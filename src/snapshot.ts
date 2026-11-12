// Builds the dashboard payload from curated state, the event log, agent
// heartbeats and collector data.
import * as os from "node:os";
import { hourBuckets, hourKey, type ForgeData, type GitData, type Merge } from "./collectors";
import { pidAlive, type TrackerStore } from "./store";
import type { AgentRecord, Area, CloudflareStatus, CustomTab, HistoryPoint, NodeStatus, Probe, ProbeResult, ShareStatus, Step, TrackerConfig, TrackerEvent, TrackerState } from "./types";

type TestEvent = Extract<TrackerEvent, { type: "test" }>;

export interface SnapshotTest extends Omit<TestEvent, "type" | "result"> {
	result: TestEvent["result"] | "no result";
	resolved?: { name: string; t: string };
}

export interface SnapshotAgent extends AgentRecord {
	last_min: number | null;
	/** Minutes since the agent last reported anything. */
	active_min: number;
	/** Not checkable by pid and silent for 30+ minutes. */
	stale?: boolean;
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
	/** Run-specific tabs, in display order. */
	tabs: CustomTab[];
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
				if (nowMs - Date.parse(e.t) > (e.timeoutHours ?? cfg.noResultHours) * 3_600_000) {
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

/** Minutes without any update after which an agent that cannot be checked by pid shows as stale. */
const STALE_MINUTES = 30;

function liveAgents(store: TrackerStore, nowMs: number, windowHours: number): SnapshotAgent[] {
	const host = os.hostname();
	let out: SnapshotAgent[] = [];
	for (const a of store.readAgents()) {
		if (nowMs - Date.parse(a.updated) > windowHours * 3_600_000) continue;
		let status = a.status;
		const checkable = !!a.pid && (a.host ?? host) === host;
		if (status !== "closed" && checkable && !pidAlive(a.pid)) status = "closed";
		const activeMin = Math.max(0, Math.round((nowMs - Date.parse(a.updated)) / 60_000));
		// Agents outside omp (or on another host) never report "closed"; silence means stale.
		const stale = status !== "closed" && !checkable && activeMin > STALE_MINUTES;
		if (stale && status === "running") status = "idle";
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
			...(stale ? { stale: true } : {}),
			last_min: a.lastPost ? Math.max(0, Math.round((nowMs - Date.parse(a.lastPost)) / 60_000)) : null,
			active_min: activeMin,
			todo_done: done,
			todo_total: total,
		});
	}
	// Older versions recorded each curator run as its own session: show them as one card.
	const curators = out.filter(a => a.kind === "curator").sort((a, b) => Date.parse(b.updated) - Date.parse(a.updated));
	if (curators.length > 1) {
		const keep = { ...curators[0], runs: curators.reduce((n, c) => n + (c.runs ?? 1), 0) };
		out = [...out.filter(a => a.kind !== "curator"), keep];
	}
	// An agent posting from outside omp under the same name as a real session is the same agent:
	// keep the most recently updated record of each such name.
	const byName = new Map<string, SnapshotAgent[]>();
	for (const a of out) byName.set(a.name, [...(byName.get(a.name) ?? []), a]);
	const drop = new Set<SnapshotAgent>();
	for (const group of byName.values()) {
		if (group.length < 2 || !group.some(a => a.engine === "external")) continue;
		const newest = group.reduce((m, a) => (Date.parse(a.updated) > Date.parse(m.updated) ? a : m));
		for (const a of group) if (a !== newest && a.engine === "external") drop.add(a);
	}
	return out.filter(a => !drop.has(a));
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

/** Progress credit per box state for map-bound areas. */
const STATE_CREDIT: Record<string, number> = { live: 1, testing: 0.75, building: 0.4, blocked: 0.25, planned: 0 };

/** Areas bound to a milestone or a map container get their % from it. */
function deriveAreas(state: TrackerState, milestones: Snapshot["milestones"], nodes: Snapshot["nodes"]): Snapshot["areas"] {
	const kids = new Map<string, string[]>();
	for (const it of state.map.now.items) if (it.parent) kids.set(it.parent, [...(kids.get(it.parent) ?? []), it.id]);
	const leaves = (id: string): string[] => {
		const ch = kids.get(id);
		return ch ? ch.flatMap(leaves) : [id];
	};
	return state.areas.map(a => {
		let pct: number | undefined;
		let auto = "";
		if (a.milestone) {
			const m = milestones.find(x => x.title.toLowerCase() === a.milestone!.toLowerCase());
			if (m && m.open + m.closed) {
				pct = Math.round((100 * m.closed) / (m.open + m.closed));
				auto = `${m.closed}/${m.open + m.closed} closed in "${m.title}"`;
			}
		} else if (a.map) {
			const ls = leaves(a.map);
			if (ls.length) {
				const states = ls.map(id => nodes[id]?.state ?? "planned");
				pct = Math.round((100 * states.reduce((s, x) => s + (STATE_CREDIT[x] ?? 0), 0)) / ls.length);
				const count = (s: string) => states.filter(x => x === s).length;
				auto = [`${count("live")}/${ls.length} live`, ...(["testing", "building", "blocked"] as const).filter(s => count(s)).map(s => `${count(s)} ${s}`)].join(", ");
			}
		}
		if (pct === undefined) return a;
		const st: Snapshot["areas"][number]["state"] = a.state === "blocked" ? "blocked" : pct >= 100 ? "live" : pct > 0 ? "building" : "queued";
		return { ...a, pct, state: st, note: a.note ? `${a.note} · ${auto}` : auto, auto: true };
	});
}

/** Short form of a test or step name for the headline: text before ":" or ", so", at most ~48 chars. */
function brief(s: string): string {
	let out = s.split(":")[0].split(/, so |; /)[0].trim();
	if (out.length > 48) out = `${out.slice(0, 47).replace(/\s+\S*$/, "")}…`;
	return out;
}

/** Headline from the data when no one wrote one. */
function autoHeadline(state: TrackerState, nodes: Snapshot["nodes"], testingNow: Snapshot["testing_now"], tests: SnapshotTest[], path: Snapshot["critical_path"]): string {
	const parts: string[] = [];
	const items = state.map.now.items.filter(i => !state.map.now.items.some(c => c.parent === i.id));
	if (items.length) {
		const count = (s: string) => items.filter(i => (nodes[i.id]?.state ?? "planned") === s).length;
		parts.push(`${count("live")} of ${items.length} parts live${count("blocked") ? `, ${count("blocked")} blocked` : ""}${count("testing") ? `, ${count("testing")} testing` : ""}.`);
	}
	// Same rule as the dashboard: a failure on a box that is live now is superseded.
	const failing = [
		...new Set(tests.filter(t => (t.result === "fail" || t.result === "stopped") && !t.resolved && !(t.node && nodes[t.node]?.state === "live")).map(t => brief(t.name))),
	];
	if (failing.length) parts.push(`Failing: ${failing.slice(0, 2).join(", ")}${failing.length > 2 ? ` +${failing.length - 2}` : ""}.`);
	const active = path.filter(s => s.state === "active" || s.state === "building").map(s => s.step);
	const now: string[] = [];
	for (const x of [...testingNow.map(t => t.what), ...active].map(brief)) {
		// The same work often appears as a running test and as an active step.
		const k = x.toLowerCase().slice(0, 14);
		if (!now.some(y => y.toLowerCase().slice(0, 14) === k)) now.push(x);
	}
	if (now.length) parts.push(`Now: ${now.slice(0, 3).join("; ")}${now.length > 3 ? ` +${now.length - 3}` : ""}.`);
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
	// Running tests may declare a longer timeout (e.g. GPU runs); look back far enough to keep them.
	const maxTimeout = events.reduce((m, e) => (e.type === "test" && e.timeoutHours ? Math.max(m, e.timeoutHours) : m), 0);
	const testWindowMs = Math.max(cfg.windows.testsHours, cfg.windows.noResultHours + 1, maxTimeout + 1) * 3_600_000;
	const testEvents = [...events.filter((e): e is TestEvent => e.type === "test"), ...ciTests(state, forge)].filter(e => nowMs - Date.parse(e.t) <= testWindowMs);
	const { tests: allTests, testingNow } = resolveTests(testEvents, nowMs, cfg.windows);
	const tests = allTests.filter(t => nowMs - Date.parse(t.t) <= cfg.windows.testsHours * 3_600_000 || t.result === "running" || t.result === "no result");
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
	// Newest first; an identical post repeated later (same kind and text) shows once, at its latest time.
	const seenPosts = new Set<string>();
	const posts = events
		.filter((e): e is Extract<TrackerEvent, { type: "post" }> => e.type === "post")
		.reverse()
		.filter(p => {
			const k = `${p.kind}\u0000${p.text.replace(/\s+/g, " ").trim().toLowerCase()}`;
			if (seenPosts.has(k)) return false;
			seenPosts.add(k);
			return true;
		});
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
		tabs: [...state.tabs].sort((a, b) => a.order - b.order),
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
