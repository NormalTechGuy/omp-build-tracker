// The curator: a cheap omp agent the tracker server runs now and then. It reads
// what every session did since its last run (heartbeats, todos, commits,
// tracker posts) and reconciles the tracker: map structure, box states and
// notes, critical path, areas, phases, blockers. Sessions keep working; nobody
// has to remember to post.
import * as fs from "node:fs";
import * as path from "node:path";
import { buildSnapshot } from "./snapshot";
import { projectRoot, type TrackerStore } from "./store";
import { summarize } from "./view";

/** Set in the curator's environment so the extension knows it is the curator. */
export const CURATOR_ENV = "OMP_TRACKER_CURATOR";

const CURATOR_TOOLS = "tracker_view,tracker_update,read,grep,glob";
const RUN_TIMEOUT_MS = 6 * 60_000;
const DIGEST_LIMIT = 14_000;

export interface CuratorRecord {
	lastRun?: string;
	/** Activity signature the last run covered. */
	signature?: string;
	ok?: boolean;
	/** Tail of the curator's final reply. */
	result?: string;
	running?: string;
}

const SYSTEM = [
	"You are the tracker curator for a live build dashboard that the project owner watches.",
	"Other agents do the work; you keep the tracker true to what they did. You never change project files.",
	"Use tracker_view to read the tracker and tracker_update to change it. read/grep/glob are for checking facts in the repo when the digest is unclear.",
	"Each run: compare the activity digest with the tracker and make the smallest set of updates that brings it in line:",
	"- map: add boxes for components that now exist or are being built; remove or re-parent boxes that no longer match; keep ids stable.",
	"- node: move states (planned → building → testing → live; blocked when stuck) and refresh notes in one or two factual sentences. Leave boxes whose state comes from health checks alone.",
	"- step / area / phase / estimate: keep the critical path current, mark finished steps done, record finished phases with dates.",
	"- post: record blockers and decisions that appear in the activity and are not posted yet.",
	"- custom tabs (tab_rows / tab_block): when the activity reports new results that a custom tab tracks (e.g. a new score for a leaderboard row), update those rows. Read the tab with tracker_view section tabs first. Do not create new tabs unless the run clearly lacks one for its central results.",
	"Do not repeat posts that already exist, do not invent progress, and do not narrate. If nothing needs to change, make no calls and reply NOOP.",
	"Finish with one short line describing what you changed.",
].join("\n");

function readRecord(store: TrackerStore): CuratorRecord {
	try {
		return JSON.parse(fs.readFileSync(path.join(store.dir, "curator.json"), "utf8")) as CuratorRecord;
	} catch {
		return {};
	}
}

function writeRecord(store: TrackerStore, rec: CuratorRecord): void {
	fs.writeFileSync(path.join(store.dir, "curator.json"), JSON.stringify(rec, null, 1));
}

function clip(s: string | undefined, n: number): string {
	const one = (s ?? "").replace(/\s+/g, " ").trim();
	return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

function git(root: string, args: string[]): string {
	const r = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "ignore" });
	return r.exitCode === 0 ? r.stdout.toString() : "";
}

/** What changed outside the curator: worker heartbeats, non-curator posts and the git tip. */
export function activitySignature(store: TrackerStore): string {
	const agents = store.readAgents().filter(a => a.kind !== "curator");
	const curatorIds = new Set(store.readAgents().filter(a => a.kind === "curator").map(a => a.id));
	const lastAgent = agents.reduce((m, a) => (a.updated > m ? a.updated : m), "");
	const events = store.readEvents(Date.now() - 7 * 86_400_000).filter(e => !e.agent || !curatorIds.has(e.agent));
	const tip = git(projectRoot(store.dir), ["rev-parse", "HEAD"]).trim();
	return `${lastAgent}|${events.length}|${events[events.length - 1]?.id ?? ""}|${tip}`;
}

/** The prompt: current tracker plus everything that happened since `since`. */
export function curatorDigest(store: TrackerStore, since: string): string {
	const root = projectRoot(store.dir);
	const sinceMs = Date.parse(since);
	const snap = buildSnapshot(store, undefined, undefined);
	const curatorIds = new Set(snap.agents.filter(a => a.kind === "curator").map(a => a.id));
	const nameOf = (id?: string) => snap.agents.find(a => a.id === id)?.name ?? id ?? "?";
	const lines: string[] = [`# Activity since ${since}`, "", "## Agents active since then"];
	for (const a of snap.agents) {
		if (a.kind === "curator" || Date.parse(a.updated) < sinceMs) continue;
		const todo = a.todo?.flatMap(p => p.tasks.map(t => `${t.status === "completed" ? "[x]" : t.status === "in_progress" ? "[>]" : "[ ]"} ${t.content}`)) ?? [];
		lines.push(
			`- ${a.name} (${a.kind}, ${a.status}, ${a.engine}/${a.model ?? "?"})`,
			...(a.focus ? [`  focus: ${clip(a.focus, 200)}`] : []),
			...(a.now ? [`  latest: ${clip(a.now, 280)}`] : []),
			...(a.action ? [`  last tool: ${clip(a.action, 140)}`] : []),
			...(todo.length ? [`  todos: ${clip(todo.join("; "), 400)}`] : []),
		);
	}
	const commits = git(root, ["log", `--since=${since}`, "--format=%h %an: %s", "-n", "40"]).trim();
	const base = commits ? git(root, ["rev-list", "-n", "1", `--before=${since}`, "HEAD"]).trim() : "";
	const stat = base ? git(root, ["diff", "--stat", "--stat-width=100", base, "HEAD"]).trim().split("\n").slice(-25).join("\n") : "";
	if (stat) lines.push("", "## Files changed", stat);
	const posts = store
		.readEvents(sinceMs)
		.filter(e => !e.agent || !curatorIds.has(e.agent))
		.slice(-40)
		.map(e => {
			const who = nameOf(e.agent);
			if (e.type === "test") return `- ${who}: test ${e.name} [${e.node || "-"}] ${e.result}${e.why?.[0] ? ` — ${clip(e.why[0], 120)}` : ""}`;
			if (e.type === "post") return `- ${who}: ${e.kind}: ${clip(e.text, 200)}`;
			return `- ${who}: ${clip(e.summary, 160)}`;
		});
	lines.push("", "## Tracker posts by others", ...(posts.length ? posts : ["(none)"]));
	let activity = lines.join("\n");
	if (activity.length > DIGEST_LIMIT) activity = `${activity.slice(0, DIGEST_LIMIT)}\n…(truncated)`;
	const tracker = summarize(snap, "summary").slice(0, 9000);
	return `${activity}\n\n# Tracker as it stands\n${tracker}\n\nReconcile the tracker with this activity now.`;
}

function ompCommand(store: TrackerStore): string {
	return store.config().curator.command ?? Bun.which("omp") ?? "omp";
}

/** Config overlay for curator runs: bookkeeping stays out of the user's long-term memory and learned skills. */
function isolationOverlay(store: TrackerStore): string {
	const file = path.join(store.dir, "curator.config.yml");
	const body = "memory:\n  backend: off\nautolearn:\n  enabled: false\n";
	if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== body) fs.writeFileSync(file, body);
	return file;
}

/** Run the curator once. Returns its final reply (or the error). */
export async function runCurator(store: TrackerStore, log: (m: string) => void = () => {}): Promise<{ ok: boolean; result: string }> {
	const cfg = store.config().curator;
	const rec = readRecord(store);
	const startedAt = new Date().toISOString();
	const since = rec.lastRun ?? new Date(Date.now() - 6 * 3_600_000).toISOString();
	const signature = activitySignature(store);
	writeRecord(store, { ...rec, running: startedAt });
	const prompt = curatorDigest(store, since);
	let ok = false;
	let result = "";
	try {
		const proc = Bun.spawn(
			[
				ompCommand(store),
				"-p",
				"--no-session",
				"--no-skills",
				"--no-rules",
				"--config",
				isolationOverlay(store),
				"--model",
				cfg.model,
				"--thinking",
				"low",
				"--tools",
				CURATOR_TOOLS,
				"--append-system-prompt",
				SYSTEM,
				prompt,
			],
			{ cwd: projectRoot(store.dir), stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, [CURATOR_ENV]: "1" } },
		);
		const timer = setTimeout(() => proc.kill(), RUN_TIMEOUT_MS);
		const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
		clearTimeout(timer);
		ok = code === 0;
		result = clip((ok ? out : `${err}\n${out}`).trim().split("\n").slice(-6).join(" "), 400) || (ok ? "done" : `exit ${code}`);
	} catch (err) {
		result = err instanceof Error ? err.message : String(err);
	}
	if (!ok) log(`tracker: curator run failed: ${result}`);
	writeRecord(store, { lastRun: startedAt, signature, ok, result });
	return { ok, result };
}

export function curatorStatus(store: TrackerStore): CuratorRecord & { enabled: boolean; model: string; minMinutes: number } {
	const cfg = store.config().curator;
	return { ...readRecord(store), enabled: cfg.enabled, model: cfg.model, minMinutes: cfg.minMinutes };
}

/** Server-side schedule: run when enabled, due, and something happened since the last run. */
export class CuratorScheduler {
	private busy = false;

	constructor(
		private store: TrackerStore,
		private log: (m: string) => void,
		private onDone: () => void,
	) {}

	async tick(): Promise<void> {
		const cfg = this.store.config().curator;
		if (!cfg.enabled || this.busy) return;
		const rec = readRecord(this.store);
		if (rec.running && Date.now() - Date.parse(rec.running) < RUN_TIMEOUT_MS) return; // another process is running it
		if (rec.lastRun && Date.now() - Date.parse(rec.lastRun) < cfg.minMinutes * 60_000) return;
		if (rec.signature === activitySignature(this.store)) return;
		this.busy = true;
		try {
			await runCurator(this.store, this.log);
		} finally {
			this.busy = false;
			this.onDone();
		}
	}
}

export type CuratorAction = "on" | "off" | "run" | "status";

/** One entry point for `/tracker curator …` and `omp-tracker curator …`. */
export async function curatorCommand(store: TrackerStore, action: CuratorAction, model?: string): Promise<{ text: string; ok: boolean }> {
	const cfg = store.config();
	if (action === "on" || action === "off") {
		cfg.curator = { ...cfg.curator, enabled: action === "on", ...(model ? { model } : {}) };
		store.saveConfig(cfg);
		return {
			text:
				action === "on"
					? `Curator on: ${cfg.curator.model}, at most every ${cfg.curator.minMinutes} min, only when sessions did something since its last run. The tracker server runs it.`
					: "Curator off.",
			ok: true,
		};
	}
	if (action === "run") {
		const r = await runCurator(store);
		return { text: `Curator ${r.ok ? "finished" : "failed"}: ${r.result}`, ok: r.ok };
	}
	const s = curatorStatus(store);
	return {
		text: `Curator ${s.enabled ? "on" : "off"} (${s.model}, every ≥${s.minMinutes} min). ${s.lastRun ? `Last run ${s.lastRun}: ${s.ok ? "ok" : "failed"} — ${s.result ?? ""}` : "Never run."}`,
		ok: true,
	};
}
