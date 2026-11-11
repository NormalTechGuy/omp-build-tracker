// Builds the dashboard payload from curated state, the event log, agent
// heartbeats and collector data.
import * as os from "node:os";
import { hourBuckets, hourKey, type ForgeData, type GitData, type Merge } from "./collectors";
import { pidAlive, type TrackerStore } from "./store";
import type { AgentRecord, Area, CloudflareStatus, HistoryPoint, NodeStatus, Probe, ProbeResult, ShareStatus, Step, TrackerConfig, TrackerEvent, TrackerState } from "./types";

type TestEvent = Extract<TrackerEvent, { type: "test" }>;

export interface SnapshotTest extends Omit<TestEvent, "type" | "result"> {
	result: TestEvent["result"] | "no result";
	resolved?: { name: string; t: string };
}

export interface SnapshotAgent extends AgentRecord {
	last_min: number | null;
	todo_done: number;
	todo_total: number;
}

export interface Snapshot {
	generated_at: string;
	title: string;
	labels: TrackerState["labels"];
	headline: string;
	/** True when the headline was composed from the data. */
	headline_auto: boolean;
	overall_pct: number;
	overall_method: string;
	rules: string;
	footer: string;
	sources: string[];
	git: { branch: string; tip: string } | null;
	/** `auto`: pct derived from a milestone or the map. */
	areas: (Area & { auto?: boolean })[];
	critical_path: (Step & { derived?: boolean })[];
	phases: TrackerState["phases"];
	estimates: TrackerState["estimates"];
	owner_items: TrackerState["ownerItems"];
	facts: TrackerState["facts"];
	map: TrackerState["map"];
	/** `auto`: state derived by deterministic sources (e.g. "probes"). */
	nodes: Record<string, NodeStatus & { auto?: string }>;
	/** Health checks the server runs, with their latest result. */
	checks: CheckRow[];
	tests: SnapshotTest[];
	testing_now: { node: string; what: string; since: string; lane?: string; where?: string; agent?: string }[];
	test_notes: TrackerState["testNotes"];
	agents: SnapshotAgent[];
	/** PR merges from the forge when configured, else first-parent commits on the git mainline. */
	merges: { source: string; last3h: number; last24: number; per_hour: [string, number][]; recent: Merge[] } | null;
	prs: ForgeData["prs"] | null;
	issues: (ForgeData["issues"] & { source: string }) | null;
	milestones: { title: string; open: number; closed: number; source: string }[];
	activity: { posts24: number; per_hour: [string, number][] };
	blockers: { t: string; text: string; agent?: string }[];
	decisions: { t: string; text: string; agent?: string }[];
	notes: { t: string; text: string; agent?: string }[];
	history: HistoryPoint[];
	windows: TrackerConfig["windows"];
	forge_error?: string;
	/** Set on the read-only view served to share links and exports. */
	public?: boolean;
	/** Tailscale share state (set by the server). */
	share?: ShareStatus;
	/** Cloudflare copy status (set by the server, private view only). */
	cloudflare?: CloudflareStatus;
}

const DONE_TODO: Record<string, true> = { completed: true, done: true };
const DROPPED_TODO: Record<string, true> = { abandoned: true, dropped: true, removed: true };

function todoState(status: string): Step["state"] {
	if (DONE_TODO[status]) return "done";
	if (status === "in_progress") return "active";
	if (status === "blocked") return "blocked";
	return "queued";
}

function resolveTests(events: TestEvent[], nowMs: number, cfg: TrackerConfig["windows"]) {
	const sorted = [...events].sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
	const byKey = new Map<string, TestEvent[]>();
	for (const e of sorted) {
		const k = `${e.node}\u0000${e.name}`;
		const list = byKey.get(k) ?? [];
		list.push(e);
		byKey.set(k, list);
	}
	const tests: SnapshotTest[] = [];
	const testingNow: Snapshot["testing_now"] = [];
	for (const list of byKey.values()) {
		list.forEach((e, i) => {
			const later = list.slice(i + 1);
			const { type: _type, ...rest } = e;
			if (e.result === "running") {
				if (later.length) return; // superseded by its outcome or a rerun
				if (nowMs - Date.parse(e.t) > cfg.noResultHours * 3_600_000) {
					tests.push({ ...rest, result: "no result" });
					return;
				}
				testingNow.push({ node: e.node, what: e.name, since: e.t, lane: e.lane, where: e.where, agent: e.agent });
				tests.push(rest);
				return;
			}
			const out: SnapshotTest = { ...rest };
			if (e.result === "fail" || e.result === "stopped") {
				const pass = later.find(x => x.result === "pass");
				if (pass) out.resolved = { name: pass.name, t: pass.t };
			}
			tests.push(out);
		});
	}
	tests.sort((a, b) => Date.parse(b.t) - Date.parse(a.t));
	testingNow.sort((a, b) => Date.parse(b.since) - Date.parse(a.since));
	return { tests, testingNow };
}

function buildMilestones(state: TrackerState, forge: ForgeData | undefined, agents: SnapshotAgent[]): Snapshot["milestones"] {
	const milestones: Snapshot["milestones"] = [
		...state.chunks.map(c => ({ title: c.title, open: c.open, closed: c.closed, source: "tracker" })),
		...(forge?.milestones ?? []).map(m => ({ ...m, source: forge!.kind })),
	];
	const todoAgents = agents.filter(a => a.todo?.length && a.status !== "closed");
	for (const a of todoAgents)
		for (const p of a.todo!) {
			const tasks = p.tasks.filter(t => !DROPPED_TODO[t.status]);
			if (!tasks.length) continue;
			const closed = tasks.filter(t => DONE_TODO[t.status]).length;
			milestones.push({ title: todoAgents.length > 1 ? `${p.name} · ${a.name}` : p.name, open: tasks.length - closed, closed, source: "todo" });
		}
	return milestones;
}

function liveAgents(store: TrackerStore, nowMs: number, windowHours: number): SnapshotAgent[] {
	const host = os.hostname();
	const out: SnapshotAgent[] = [];
	for (const a of store.readAgents()) {
		if (nowMs - Date.parse(a.updated) > windowHours * 3_600_000) continue;
		let status = a.status;
		if (status !== "closed" && a.pid && (a.host ?? host) === host && !pidAlive(a.pid)) status = "closed";
		let done = 0;
		let total = 0;
		for (const p of a.todo ?? [])
			for (const t of p.tasks) {
				if (DROPPED_TODO[t.status]) continue;
				total++;
				if (DONE_TODO[t.status]) done++;
			}
		out.push({
			...a,
			status,
			last_min: a.lastPost ? Math.max(0, Math.round((nowMs - Date.parse(a.lastPost)) / 60_000)) : null,
			todo_done: done,
			todo_total: total,
		});
	}
	return out;
}

/** Simple glob: `*` matches anything; patterns are comma separated; case-insensitive. */
function globMatch(patterns: string, value: string): boolean {
	return patterns
		.split(",")
		.map(p => p.trim())
		.filter(Boolean)
		.some(p => new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`, "i").test(value));
}

/**
 * CI runs on workflows bound to a box become tests on it. A binding is
 * "workflow-glob[@branch-glob]", comma separated; tests are named per
 * workflow and branch so a pass only resolves failures on the same branch.
 */
function ciTests(state: TrackerState, forge: ForgeData | undefined): TestEvent[] {
	if (!forge?.runs.length) return [];
	const out: TestEvent[] = [];
	for (const [node, n] of Object.entries(state.nodes)) {
		const pattern = n.bind?.ci;
		if (!pattern) continue;
		const rules = pattern
			.split(",")
			.map(p => p.trim())
			.filter(Boolean)
			.map(p => {
				const at = p.lastIndexOf("@");
				return at > 0 ? { wf: p.slice(0, at), br: p.slice(at + 1) } : { wf: p, br: undefined };
			});
		for (const r of forge.runs) {
			const rule = rules.find(x => globMatch(x.wf, r.workflow) && (!x.br || globMatch(x.br, r.branch)));
			if (!rule) continue;
			const done = r.status === "completed";
			const result: TestEvent["result"] = !done
				? "running"
				: r.conclusion === "success"
					? "pass"
					: ["cancelled", "skipped", "neutral", "action_required", "stale"].includes(r.conclusion ?? "")
						? "stopped"
						: "fail";
			out.push({
				type: "test",
				id: `ci-${r.id}`,
				t: done ? r.updated : r.started,
				node,
				name: rule.br && !rule.br.includes("*") ? `CI · ${r.workflow}` : `CI · ${r.workflow} @ ${r.branch}`,
				result,
				...(result === "fail" || result === "stopped" ? { why: [`${r.branch} #${r.number}: ${r.conclusion ?? r.status}`, r.title] } : {}),
				next: `Run: ${r.url}`,
				lane: r.branch,
				where: forge.kind === "github" ? "GitHub Actions" : "CI",
				agent: "ci",
			});
		}
	}
	return out;
}

export interface CheckRow {
	id: string;
	node: string;
	name: string;
	kind: string;
	target: string;
	everySeconds: number;
	drivesState: boolean;
	result?: ProbeResult;
}

/**
 * Box state and issues after deterministic sources: probes that drive state
 * (all pass → live, any fail → blocked) and forge issues carrying a bound label.
 */
function deriveNodes(state: TrackerState, results: Record<string, ProbeResult>, forge: ForgeData | undefined, nowMs: number): Snapshot["nodes"] {
	const nodes: Snapshot["nodes"] = structuredClone(state.nodes);
	const t = new Date(nowMs).toISOString();
	const ensure = (id: string) => (nodes[id] ??= { state: "planned", issues: [], updated: t });
	const byNode = new Map<string, Probe[]>();
	for (const p of state.probes) if (p.drivesState && results[p.id]) byNode.set(p.node, [...(byNode.get(p.node) ?? []), p]);
	for (const [id, probes] of byNode) {
		const n = ensure(id);
		const failing = probes.filter(p => !results[p.id].ok);
		n.auto = "probes";
		if (failing.length) {
			n.state = "blocked";
			const f = results[failing[0].id];
			n.note = `Health check failing: ${failing.map(p => p.name).join(", ")} (${f.detail}) since ${f.since.slice(11, 16)}Z.${n.note ? ` ${n.note}` : ""}`;
		} else n.state = "live";
	}
	if (forge?.labeled.length) {
		for (const [id, n0] of Object.entries(state.nodes)) {
			const label = n0.bind?.label;
			if (!label) continue;
			const n = ensure(id);
			for (const i of forge.labeled) {
				if (!i.labels.some(l => l.toLowerCase() === label.toLowerCase())) continue;
				if (i.state === "closed" && i.closed && nowMs - Date.parse(i.closed) > 7 * 86_400_000) continue;
				n.issues.push({
					id: `#${i.n}`,
					what: `#${i.n} ${i.title}`,
					status: i.state === "closed" ? "fixed" : "open",
					...(i.state === "closed" ? { fix: `Closed on ${forge.kind === "github" ? "GitHub" : "Gitea"}.` } : {}),
					lane: forge.kind,
					when: i.created,
					updated: i.closed ?? i.created,
				});
			}
		}
	}
	return nodes;
}

/** Areas bound to a milestone or a map container get their % from it. */
function deriveAreas(state: TrackerState, milestones: Snapshot["milestones"], nodes: Snapshot["nodes"]): Snapshot["areas"] {
	const kids = new Map<string, string[]>();
	for (const it of state.map.now.items) if (it.parent) kids.set(it.parent, [...(kids.get(it.parent) ?? []), it.id]);
	const leaves = (id: string): string[] => {
		const ch = kids.get(id);
		return ch ? ch.flatMap(leaves) : [id];
	};
	return state.areas.map(a => {
		let done: number | undefined;
		let total = 0;
		let auto = "";
		if (a.milestone) {
			const m = milestones.find(x => x.title.toLowerCase() === a.milestone!.toLowerCase());
			if (m) {
				done = m.closed;
				total = m.open + m.closed;
				auto = `${m.closed}/${total} closed in "${m.title}"`;
			}
		} else if (a.map) {
			const ls = leaves(a.map);
			done = ls.filter(id => nodes[id]?.state === "live").length;
			total = ls.length;
			auto = `${done}/${total} parts live`;
		}
		if (done === undefined || !total) return a;
		const pct = Math.round((100 * done) / total);
		const st: Snapshot["areas"][number]["state"] = a.state === "blocked" ? "blocked" : pct >= 100 ? "live" : pct > 0 ? "building" : "queued";
		return { ...a, pct, state: st, note: a.note ? `${a.note} · ${auto}` : auto, auto: true };
	});
}

/** Headline from the data when no one wrote one. */
function autoHeadline(state: TrackerState, nodes: Snapshot["nodes"], testingNow: Snapshot["testing_now"], tests: SnapshotTest[], path: Snapshot["critical_path"]): string {
	const parts: string[] = [];
	const items = state.map.now.items.filter(i => !state.map.now.items.some(c => c.parent === i.id));
	if (items.length) {
		const count = (s: string) => items.filter(i => (nodes[i.id]?.state ?? "planned") === s).length;
		parts.push(`${count("live")} of ${items.length} parts live${count("blocked") ? `, ${count("blocked")} blocked` : ""}${count("testing") ? `, ${count("testing")} testing` : ""}.`);
	}
	const failing = tests.filter(t => (t.result === "fail" || t.result === "stopped") && !t.resolved);
	if (failing.length) parts.push(`Failing: ${failing.slice(0, 3).map(t => t.name).join(", ")}${failing.length > 3 ? ` +${failing.length - 3}` : ""}.`);
	const active = path.filter(s => s.state === "active" || s.state === "building").map(s => s.step);
	const now = [...testingNow.map(t => t.what), ...active];
	if (now.length) parts.push(`Now: ${now.slice(0, 4).join("; ")}.`);
	return parts.join(" ");
}
export function buildSnapshot(
	store: TrackerStore,
	git: GitData | undefined,
	forge: ForgeData | undefined,
	forgeError?: string,
): Snapshot {
	const cfg = store.config();
	const state = store.readState();
	const nowMs = Date.now();
	const lookback = Math.max(cfg.windows.testsHours, cfg.windows.noResultHours, 24, cfg.windows.blockersHours) * 3_600_000;
	const events = store.readEvents(nowMs - Math.max(lookback, 14 * 86_400_000));
	const recent = events.filter(e => nowMs - Date.parse(e.t) <= lookback);
	const testEvents = [
		...recent.filter((e): e is TestEvent => e.type === "test"),
		...ciTests(state, forge),
	].filter(e => nowMs - Date.parse(e.t) <= Math.max(cfg.windows.testsHours, cfg.windows.noResultHours + 1) * 3_600_000);
	const { tests: allTests, testingNow } = resolveTests(testEvents, nowMs, cfg.windows);
	const tests = allTests.filter(t => nowMs - Date.parse(t.t) <= cfg.windows.testsHours * 3_600_000 || t.result === "no result");
	const agents = liveAgents(store, nowMs, cfg.windows.agentsHours);
	const probeResults = store.readProbeResults();
	const nodes = deriveNodes(state, probeResults, forge, nowMs);
	const checks: CheckRow[] = state.probes.map(p => ({
		id: p.id,
		node: p.node,
		name: p.name,
		kind: p.kind,
		target: p.target,
		everySeconds: p.everySeconds,
		drivesState: p.drivesState,
		...(probeResults[p.id] ? { result: probeResults[p.id] } : {}),
	}));
	const milestones = buildMilestones(state, forge, agents);
	const areas = deriveAreas(state, milestones, nodes);

	// Overall progress: explicit, else weighted areas, else todo completion.
	let overall = state.overallPct;
	let method = state.overallMethod ?? "";
	if (overall === undefined && areas.length) {
		const wsum = areas.reduce((s, a) => s + (a.weight ?? 1), 0) || 1;
		overall = Math.round(areas.reduce((s, a) => s + a.pct * (a.weight ?? 1), 0) / wsum);
		method ||= "Weighted mean of area progress.";
	}
	if (overall === undefined) {
		const done = agents.reduce((s, a) => s + a.todo_done, 0);
		const total = agents.reduce((s, a) => s + a.todo_total, 0);
		overall = total ? Math.round((100 * done) / total) : 0;
		method ||= "Share of todo tasks completed across agents.";
	}

	// Critical path: curated, else the lead agent's todo list.
	let criticalPath: Snapshot["critical_path"] = state.criticalPath;
	if (!criticalPath.length) {
		const lead = agents
			.filter(a => a.todo?.length && a.status !== "closed" && !a.parent)
			.sort((a, b) => Date.parse(b.updated) - Date.parse(a.updated))[0];
		if (lead)
			criticalPath = lead.todo!.flatMap(p =>
				p.tasks
					.filter(t => !DROPPED_TODO[t.status])
					.map((t, i) => ({ id: `${p.name}-${i}`, step: t.content, state: todoState(t.status), owner: p.name, derived: true })),
			);
	}

	// Activity: every tracker event is a post.
	const perHour = hourBuckets(24, nowMs);
	const hourIdx = new Map(perHour.map((b, i) => [b[0], i]));
	let posts24 = 0;
	for (const e of recent) {
		const ms = Date.parse(e.t);
		if (nowMs - ms > 24 * 3_600_000) continue;
		posts24++;
		const i = hourIdx.get(hourKey(ms));
		if (i !== undefined) perHour[i][1]++;
	}
	const posts = events.filter((e): e is Extract<TrackerEvent, { type: "post" }> => e.type === "post").reverse();
	const strip = (p: Extract<TrackerEvent, { type: "post" }>) => ({ t: p.t, text: p.text, agent: p.agent });

	// Issues: forge if configured, else issues recorded on map nodes.
	let issues: Snapshot["issues"] = forge ? { ...forge.issues, source: forge.kind } : null;
	if (!issues) {
		const all = Object.values(nodes).flatMap(n => n.issues);
		if (all.length) {
			const days: [string, number, number][] = [];
			for (let i = 6; i >= 0; i--) days.push([new Date(nowMs - i * 86_400_000).toISOString().slice(0, 10), 0, 0]);
			const di = new Map(days.map((d, i) => [d[0], i]));
			for (const x of all) {
				const c = di.get(x.when.slice(0, 10));
				if (c !== undefined) days[c][1]++;
				if (x.status === "fixed") {
					const f = di.get(x.updated.slice(0, 10));
					if (f !== undefined) days[f][2]++;
				}
			}
			const open = all.filter(x => x.status !== "fixed").length;
			issues = { total: all.length, open, closed: all.length - open, days, source: "map" };
		}
	}

	const sources = ["omp agent sessions"];
	if (git) sources.push(`git ${git.branch}`);
	if (forge) sources.push(`${forge.kind === "github" ? "GitHub" : "Gitea"} ${forge.repo}`);

	return {
		generated_at: new Date(nowMs).toISOString(),
		title: state.title,
		labels: state.labels,
		headline: state.headline || autoHeadline(state, nodes, testingNow, tests, criticalPath),
		headline_auto: !state.headline,
		overall_pct: overall,
		overall_method: method,
		rules: state.rules ?? "",
		footer: state.footer ?? "",
		sources,
		git: git ? { branch: git.branch, tip: git.tip } : null,
		areas,
		critical_path: criticalPath,
		phases: state.phases,
		estimates: state.estimates,
		owner_items: state.ownerItems,
		facts: state.facts,
		map: state.map,
		nodes,
		checks,
		tests,
		testing_now: testingNow,
		test_notes: state.testNotes,
		agents,
		merges: forge
			? { source: "merged PRs", last3h: forge.merges.last3h, last24: forge.merges.last24, per_hour: forge.merges.perHour, recent: forge.merges.recent }
			: git
				? { source: `commits on ${git.branch}`, last3h: git.last3h, last24: git.last24, per_hour: git.perHour, recent: git.recent }
				: null,
		prs: forge ? forge.prs : null,
		issues,
		milestones,
		activity: { posts24, per_hour: perHour },
		blockers: posts.filter(p => p.kind === "blocker" && nowMs - Date.parse(p.t) <= cfg.windows.blockersHours * 3_600_000).map(strip),
		decisions: posts.filter(p => p.kind === "decision").slice(0, 200).map(strip),
		notes: posts.filter(p => p.kind === "note").slice(0, 200).map(strip),
		history: store.readHistory().filter(h => nowMs - Date.parse(h.t) <= 14 * 86_400_000),
		windows: cfg.windows,
		...(forgeError ? { forge_error: forgeError } : {}),
	};
}

export function historyPoint(s: Snapshot): HistoryPoint {
	return {
		t: s.generated_at,
		overall_pct: s.overall_pct,
		open_issues: s.issues ? s.issues.open : null,
		merges24: s.merges?.last24 ?? 0,
		open_prs: s.prs ? s.prs.open : null,
		agents_running: s.agents.filter(a => a.status === "running").length,
		agents_total: s.agents.length,
		posts24: s.activity.posts24,
	};
}
