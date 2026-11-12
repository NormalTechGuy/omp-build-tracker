// omp extension: live build tracker.
// - tracker_update / tracker_view tools so agents post progress
// - automatic heartbeats from every omp session (lead and subagents)
// - /tracker command to init, serve, open, export
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { cloudflareCommand, type CloudflareAction } from "./cloudflare";
import { collectForge, collectGit, detectRepo } from "./collectors";
import { applyOps, OP_TYPES, type Op } from "./ops";
import { configureShare, renderStandaloneHtml, TrackerServer, type ShareAction } from "./server";
import { buildSnapshot } from "./snapshot";
import { findTrackerDir, newId, nowIso, projectRoot, TrackerStore } from "./store";
import {
	BLOCK_KINDS,
	COLUMN_KINDS,
	FUTURE_STATES,
	ISSUE_STATUSES,
	NODE_STATES,
	POST_KINDS,
	TEST_RESULTS,
	WORK_STATES,
	type AgentRecord,
	type TodoPhase,
} from "./types";
import { summarize, type ViewSection } from "./view";
import { CURATOR_ENV, curatorCommand, type CuratorAction } from "./curator";

// One dashboard server per tracker directory per process, shared by the lead
// session and its subagents (module state is shared across child sessions).
const servers = new Map<string, TrackerServer>();
// Lead (top-level) session ids alive in this process. A session that starts while
// another lead is alive is a subagent even when it has no persisted parent link.
const liveLeads = new Set<string>();
// Assignments handed out through the task tool, matched to child sessions by prompt text.
const spawned: { name: string; agent: string; text: string; parent: string }[] = [];

function engineOf(provider: string | undefined, id: string | undefined): string {
	const s = `${provider ?? ""} ${id ?? ""}`.toLowerCase();
	if (s.includes("claude") || s.includes("anthropic")) return "claude";
	if (s.includes("gemini") || s.includes("google")) return "gemini";
	if (s.includes("grok") || s.includes("xai")) return "grok";
	if (s.includes("gpt") || s.includes("codex") || s.includes("openai")) return "gpt";
	return provider || "unknown";
}

function clip(s: string, n: number): string {
	const one = s.replace(/\s+/g, " ").trim();
	return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

function describeAction(toolName: string, args: unknown, intent: string | undefined): string {
	const a = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
	const pick = (k: string) => (typeof a[k] === "string" ? (a[k] as string) : undefined);
	const detail = pick("command") ?? pick("path") ?? pick("pattern") ?? pick("query") ?? pick("url") ?? intent ?? "";
	return clip(`${toolName}: ${detail}`, 220);
}

function textOf(message: unknown): string {
	if (!message || typeof message !== "object") return "";
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((p): p is { type: "text"; text: string } => !!p && typeof p === "object" && p.type === "text" && typeof p.text === "string")
		.map(p => p.text)
		.join("\n");
}

async function ensureServer(store: TrackerStore, log: (m: string) => void): Promise<string> {
	const running = servers.get(store.dir);
	if (running) return running.url;
	const other = store.readServer();
	if (other && other.pid !== process.pid) return other.url;
	const server = new TrackerServer(store, log);
	servers.set(store.dir, server);
	try {
		return await server.start();
	} catch (err) {
		servers.delete(store.dir);
		throw err;
	}
}

const WORK_TOOLS: Record<string, true> = { edit: true, write: true, ast_edit: true };

// Test, typecheck and lint commands whose outcome is posted as a test automatically.
const TEST_COMMAND =
	/(?:^|[\s;&|(])(?:(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?test\b|(?:bunx|npx|pnpm\s+exec)\s+(?:vitest|jest|playwright\s+test|tsc)\b|vitest\b|jest\b|pytest\b|python3?\s+-m\s+pytest\b|go\s+test\b|cargo\s+(?:test|nextest|clippy)\b|(?:\.\/)?gradlew?\s+test\b|mvn\s+(?:test|verify)\b|dotnet\s+test\b|rspec\b|phpunit\b|mix\s+test\b|ctest\b|(?:make|just)\s+test\b|tsc\s+(?:--noEmit|-p)\b|ruff\s+check\b|eslint\b|biome\s+(?:check|lint)\b)/;

/** The test-like segment of a shell command, used as the test name; undefined if none. */
function testName(command: string): string | undefined {
	const part = command.split(/&&|\|\||;|\n/).find(p => TEST_COMMAND.test(` ${p}`));
	return part ? clip(part.replace(/\s+2>&1.*$/, ""), 80) : undefined;
}

function openUrl(pi: ExtensionAPI, url: string): void {
	const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
	void pi.exec(cmd, [url]).catch(() => {});
}

export default function buildTracker(pi: ExtensionAPI): void {
	const z = pi.zod;
	pi.setLabel("Build tracker");

	let store: TrackerStore | undefined;
	let agentId = "";
	let pending: Partial<AgentRecord> = {};
	let flushTimer: Timer | undefined;
	let lastCtx: ExtensionContext | undefined;

	const log = (m: string) => pi.logger.warn(m);

	let isSub = false;
	// The curator is an omp process the tracker server starts with this env var set.
	const isCurator = process.env[CURATOR_ENV] === "1";
	// Per-run bookkeeping for the end-of-run nudge (reset on each user prompt).
	let workThisRun = 0;
	let postedThisRun = false;
	let nudgedThisRun = false;
	// Test commands in flight, by tool call id.
	const testCalls = new Map<string, { name: string; t: string }>();
	let staleCache: { at: number; text: string } | undefined;

	/** Lead-only hint when the map is missing or older than the code it describes. */
	const mapHint = (st: TrackerStore): string => {
		if (staleCache && Date.now() - staleCache.at < 5 * 60_000) return staleCache.text;
		const state = st.readState();
		let text = "";
		if (!state.map.now.items.length) {
			text =
				"The tracker has no system map yet. Draw one early with a `map` op: boxes for the components this work builds or changes, containers for groups, edges for the main flows; then add probes and bindings so states keep themselves current. If this run has its own central output (a leaderboard, a results matrix, a migration checklist, an experiment log), give it a custom tab with a `tab` op and keep it current with `tab_rows`.";
		} else {
			const since = state.mapUpdated ?? state.updated;
			const ageH = (Date.now() - Date.parse(since)) / 3_600_000;
			if (ageH >= 12) {
				const r = Bun.spawnSync(["git", "rev-list", "--count", `--since=${since}`, "HEAD"], { cwd: projectRoot(st.dir), stdout: "pipe", stderr: "ignore" });
				const commits = r.exitCode === 0 ? Number(r.stdout.toString().trim()) : 0;
				if (commits >= 5)
					text = `The tracker map was last changed ${ageH < 48 ? `${Math.round(ageH)} h` : `${Math.round(ageH / 24)} days`} ago and ${commits} commits have landed since. Check it still matches the code (new, removed or renamed components; containers that changed) and fix it with a \`map\` op if not.`;
			}
		}
		staleCache = { at: Date.now(), text };
		return text;
	};

	const baseRecord = (ctx: ExtensionContext): AgentRecord => {
		const header = ctx.sessionManager.getHeader();
		const file = ctx.sessionManager.getSessionFile();
		const parent = header?.parentSession;
		const t = nowIso();
		const sub = isSub && file ? path.basename(file, ".jsonl") : undefined;
		return {
			id: agentId,
			name: isCurator ? "tracker curator" : (sub ?? (isSub ? "subagent" : (ctx.sessionManager.getSessionName() ?? header?.title ?? `lead · ${path.basename(ctx.cwd)}`))),
			engine: engineOf(ctx.model?.provider, ctx.model?.id),
			model: ctx.model?.id,
			thinking: pi.getThinkingLevel() ?? undefined,
			status: "idle",
			kind: isCurator ? "curator" : isSub ? "subagent" : "lead",
			...(parent ? { parent } : {}),
			pid: process.pid,
			host: os.hostname(),
			started: t,
			updated: t,
		};
	};

	const flush = () => {
		clearTimeout(flushTimer);
		flushTimer = undefined;
		if (!store || !agentId || !lastCtx) return;
		const ctx = lastCtx;
		const patch = { ...pending, model: ctx.model?.id, engine: engineOf(ctx.model?.provider, ctx.model?.id), thinking: pi.getThinkingLevel() ?? undefined };
		pending = {};
		try {
			store.patchAgent(agentId, patch, () => baseRecord(ctx));
		} catch (err) {
			log(`tracker: heartbeat failed: ${String(err)}`);
		}
	};

	/** Queue an agent-record change; `now` flushes immediately (status changes). */
	const beat = (ctx: ExtensionContext, patch: Partial<AgentRecord>, now = false) => {
		if (!store) return;
		lastCtx = ctx;
		pending = { ...pending, ...patch };
		if (now) flush();
		else flushTimer ??= setTimeout(flush, 1500);
	};

	const attach = async (ctx: ExtensionContext) => {
		const dir = findTrackerDir(ctx.cwd);
		store = dir ? new TrackerStore(dir) : undefined;
		if (!store) return;
		// The curator is a new process each run; one stable id keeps it to one dashboard card.
		agentId = isCurator ? "curator" : ctx.sessionManager.getSessionId();
		lastCtx = ctx;
		isSub = !!ctx.sessionManager.getHeader()?.parentSession || [...liveLeads].some(id => id !== agentId);
		if (!isSub) liveLeads.add(agentId);
		const existing = store.readAgent(agentId);
		const runs = isCurator ? { runs: (existing?.runs ?? (existing ? 1 : 0)) + 1, started: nowIso(), now: "" } : {};
		store.writeAgent({ ...baseRecord(ctx), ...(existing ?? {}), ...runs, status: existing?.status === "running" ? "running" : "idle", pid: process.pid, updated: nowIso() });
		if (!isSub && !isCurator && store.config().autostart) {
			try {
				await ensureServer(store, log);
			} catch (err) {
				log(`tracker: server failed to start: ${String(err)}`);
			}
		}
	};

	pi.on("session_start", async (_e, ctx) => attach(ctx));
	pi.on("session_switch", async (_e, ctx) => {
		if (agentId && store) {
			liveLeads.delete(agentId);
			beat(ctx, { status: "closed" }, true);
		}
		await attach(ctx);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (!store || event.reason !== "prompt") return;
		workThisRun = 0;
		postedThisRun = false;
		nudgedThisRun = false;
		const rec = store.readAgent(agentId);
		const patch: Partial<AgentRecord> = { status: "running" };
		if (!rec?.focus && !isCurator) patch.focus = clip(event.prompt, 400);
		if (isSub && rec?.kind === "subagent") {
			const idx = spawned.findIndex(s => s.text && event.prompt.includes(s.text.slice(0, 200)));
			if (idx >= 0) {
				const s = spawned.splice(idx, 1)[0];
				Object.assign(patch, { name: s.name, kind: s.agent, parent: s.parent, focus: clip(s.text, 400) });
			}
		}
		const name = ctx.sessionManager.getSessionName();
		if (name && rec?.kind === "lead") patch.name = name;
		beat(ctx, patch, true);
		const cfg = store.config();
		// Take over serving when the process that ran the dashboard has exited.
		if (!isSub && !isCurator && cfg.autostart && !servers.has(store.dir) && !store.readServer())
			await ensureServer(store, log).catch(err => log(`tracker: server failed to start: ${String(err)}`));
		if (!cfg.promptHint || isCurator) return;
		const url = servers.get(store.dir)?.url ?? store.readServer()?.url;
		const stale = isSub ? "" : mapHint(store);
		const hint = [
			"# Live build tracker",
			`This project has a live build tracker${url ? ` (${url})` : ""} that the owner watches. Your session already reports status and tool activity automatically, and test/typecheck/lint commands you run in bash are posted as tests for you.`,
			"Prefer deterministic sources over manual posts: give each box a `probe` (http URL, tcp host:port or shell cmd) and the server checks it on a schedule and sets the box live/blocked by itself; bind boxes to CI workflows (`node` op `ci`) and issue labels (`label`), and areas to milestones (`milestone`) or map containers (`map`). Then post by hand only what no check can see: box state changes, issues you find, blockers, decisions, next steps and estimates. Keep text short and factual.",
			"If the run has a central result the standard tabs do not show well (a leaderboard, a results matrix, a checklist), keep it in a custom tab (`tab`, then `tab_rows` to update single rows) rather than in facts or notes.",
			"Call `tracker_view` first to see map ids and custom tabs. Read skill://build-tracker for conventions.",
			...(stale ? [stale] : []),
		].join("\n");
		return { systemPrompt: [...event.systemPrompt, hint] };
	});

	pi.on("agent_start", async (_e, ctx) => beat(ctx, { status: "running" }, true));
	pi.on("agent_end", async (event, ctx) => {
		if (event.willContinue) return;
		beat(ctx, { status: "idle" }, true);
	});
	pi.on("message_end", async (event, ctx) => {
		const msg = event.message as { role?: string; stopReason?: string; errorMessage?: string };
		if (msg.role !== "assistant") return;
		if (msg.stopReason === "error") {
			beat(ctx, { status: "error", now: clip(msg.errorMessage ?? "provider error", 280) }, true);
			return;
		}
		const text = textOf(event.message);
		if (text.trim()) beat(ctx, { now: clip(text, 280) });
	});
	// tool_call is awaited before the tool runs, so assignments are recorded before
	// any child session starts; tool_execution_* events are mirrored asynchronously.
	pi.on("tool_call", async event => {
		if (event.toolName !== "task" || !store) return;
		const args = event.input && typeof event.input === "object" ? (event.input as { tasks?: unknown; agent?: unknown }) : {};
		const tasks = Array.isArray(args.tasks) ? (args.tasks as { name?: unknown; task?: unknown; agent?: unknown }[]) : [];
		for (const t of tasks)
			if (t && typeof t.task === "string")
				spawned.push({
					name: typeof t.name === "string" && t.name ? t.name : "subagent",
					agent: typeof t.agent === "string" && t.agent ? t.agent : typeof args.agent === "string" ? args.agent : "task",
					text: t.task,
					parent: agentId,
				});
		spawned.splice(0, Math.max(0, spawned.length - 200));
	});
	pi.on("tool_execution_start", async (event, ctx) => {
		if (event.toolName === "tracker_update") postedThisRun = true;
		if (event.toolName === "tracker_update" || event.toolName === "tracker_view") return;
		const args = event.args && typeof event.args === "object" ? (event.args as Record<string, unknown>) : {};
		if (WORK_TOOLS[event.toolName] || (event.toolName === "bash" && typeof args.command === "string" && /\bgit\s+(commit|merge|rebase|push)\b/.test(args.command)))
			workThisRun++;
		beat(ctx, { action: describeAction(event.toolName, event.args, event.intent), status: "running" });
		if (!store || isCurator) return;
		const cfg = store.config();
		if (cfg.autoTests && event.toolName === "bash" && typeof args.command === "string") {
			const name = testName(args.command);
			if (name) testCalls.set(event.toolCallId, { name, t: nowIso() });
		}
		if (cfg.autoAsks && event.toolName === "ask") {
			const question = clip(String(args.html ?? args.question ?? args.questions ?? "").replace(/<[^>]+>/g, " "), 300);
			if (question) applyOps(store, [{ type: "owner_item", id: `ask-${event.toolCallId}`, key: "Answer", text: question }], agentId);
		}
	});
	pi.on("tool_execution_end", async (event, ctx) => {
		if (store && event.toolName === "ask" && !isCurator && store.config().autoAsks) {
			const st = store;
			st.mutateState(s => {
				s.ownerItems = s.ownerItems.filter(o => o.id !== `ask-${event.toolCallId}`);
			});
		}
		const test = testCalls.get(event.toolCallId);
		if (test && store) {
			testCalls.delete(event.toolCallId);
			const result = event.result as { content?: unknown; details?: { exitCode?: number } } | undefined;
			const text = textOf(result);
			// A backgrounded job has no outcome yet; leave it out rather than guess.
			if (!/Backgrounded as job/.test(text)) {
				const failed = event.isError || (result?.details?.exitCode ?? 0) !== 0;
				// Prefer lines that say what failed; drop omp's own shell notices.
				const lines = text
					.split("\n")
					.map(l => l.trim())
					.filter(l => l && !/^(Ran in a copy of|Command exited with|Wall time|\(no output)/.test(l));
				const telling = lines.filter(l => /fail|error|expect|✗|assert|panic|exception/i.test(l));
				const tail = (telling.length ? telling.slice(0, 2) : lines.slice(-3)).join(" · ");
				store.appendEvents([
					{
						type: "test",
						id: newId(),
						t: nowIso(),
						node: "",
						name: test.name,
						result: failed ? "fail" : "pass",
						...(failed ? { why: [clip(tail || `exit ${result?.details?.exitCode ?? "non-zero"}`, 300)] } : {}),
						lane: "auto",
						agent: agentId,
					},
				]);
			}
		}
		if (event.toolName !== "todo" || event.isError) return;
		const details = (event.result as { details?: { phases?: unknown } } | undefined)?.details;
		if (!Array.isArray(details?.phases)) return;
		const todo: TodoPhase[] = (details.phases as { name?: unknown; tasks?: unknown }[]).map(p => ({
			name: String(p.name ?? ""),
			tasks: Array.isArray(p.tasks)
				? (p.tasks as { content?: unknown; status?: unknown }[]).map(t => ({ content: String(t.content ?? ""), status: String(t.status ?? "pending") }))
				: [],
		}));
		beat(ctx, { todo }, true);
	});
	// End-of-run check (main session only; omp never fires this for subagents).
	pi.on("session_stop", async event => {
		if (!store || isCurator || event.stop_hook_active || nudgedThisRun) return;
		if (!store.config().stopNudge || workThisRun === 0 || postedThisRun) return;
		nudgedThisRun = true;
		return {
			continue: true,
			additionalContext:
				"Before you finish: this run changed the project but posted nothing to the live build tracker. If the change affects what the tracker shows, update it in one tracker_update call: box states and notes, map boxes for components added or removed, finished critical-path steps, blockers, decisions. Tests you ran in bash are already posted automatically; do not repost them, and do not post notes about routine edits. If nothing on the tracker is affected, make no tracker call and say so in one line.",
		};
	});
	pi.on("session_shutdown", async (_e, ctx) => {
		beat(ctx, { status: "closed" }, true);
		if (!isSub && store) {
			liveLeads.delete(agentId);
			servers.get(store.dir)?.stop();
			servers.delete(store.dir);
		}
	});

	// ---- tools ----
	const s = z.string();
	const opt = <T>(schema: T) => (schema as { optional(): T }).optional();
	const mapItem = z.object({
		id: s.describe("Stable id, e.g. 'auth-service'"),
		label: s.describe("Short box label"),
		parent: opt(s.describe("Id of the container box this one sits in")),
		sub: opt(s.describe("Small secondary text; \\n for more lines")),
		full: opt(s.describe("Long name shown in the side panel")),
		state: opt(z.enum(FUTURE_STATES).describe("Future view only: built | progress | planned | future")),
		ref: opt(s.describe("Future view only: issue/ticket ref, e.g. '#42'")),
		desc: opt(s.describe("Future view only: what this box is")),
		now: opt(s.describe("Future view only: id of the matching now-map box")),
		flow: opt(z.enum(["row", "column"]).describe("Container: lay children in wrapping rows (default) or one per row")),
		break: opt(z.boolean().describe("Start a new row before this box")),
		wide: opt(z.boolean().describe("Take the full width of the container")),
	});
	const edge = z.object({ from: s, to: s, kind: opt(s.describe("Key into edge_kinds")), label: opt(s), both: opt(z.boolean()) });
	const removeFlag = opt(z.boolean().describe("Delete the matching entry"));
	const tabBlock = z.object({
		id: opt(s.describe("Block id, lowercase-dashes; needed to update the block later")),
		kind: opt(z.enum(BLOCK_KINDS).describe("table | stats (big numbers) | kv | list | text | chart")),
		title: opt(s),
		note: opt(s.describe("Small text under the block title, e.g. how to read it")),
		pin: opt(z.boolean().describe("Also show this block on the Overview tab")),
		half: opt(z.boolean().describe("Half width on wide screens")),
		columns: opt(
			z.array(
				z.object({
					key: s,
					label: opt(s),
					kind: opt(z.enum(COLUMN_KINDS)),
					digits: opt(z.number()),
					lower_better: opt(z.boolean()),
				}),
			),
		),
		rows: opt(z.array(z.record(z.unknown())).describe("Objects keyed by column key; optional _muted, _highlight, _unranked, _note")),
		row_key: opt(s.describe("Column identifying a row for tab_rows (default: first column)")),
		sort: opt(s.describe("Column key to sort by")),
		sort_dir: opt(z.enum(["asc", "desc"])),
		rank: opt(z.boolean().describe("Add a # column ranked by the sort")),
		items: opt(z.array(z.object({ label: opt(s), value: opt(z.union([s, z.number()])), sub: opt(s), text: opt(s), state: opt(s) }))),
		text: opt(s.describe("text block: paragraphs separated by blank lines; lines starting '- ' are bullets")),
		chart: opt(z.enum(["bar", "line", "hbar"])),
		labels: opt(z.array(s)),
		series: opt(z.array(z.object({ name: s, values: z.array(z.number()), color: opt(s) }))),
	});
	const op = z.union([
		z.object({
			type: z.literal("project"),
			title: opt(s),
			subtitle: opt(s.describe("Header words after the title; default 'build tracker'")),
			headline: opt(s.describe("One or two sentences: where things stand and what is happening now. 'auto' composes it from the data")),
			overall_pct: opt(z.number().describe("Overall %, 0-100. Omit to derive from weighted areas")),
			overall_method: opt(s),
			rules: opt(s.describe("Approvals / ground rules in force")),
			footer: opt(s),
			infra_label: opt(s.describe("Name for the Infrastructure tab, e.g. 'Environment'")),
			facts_label: opt(s),
			rules_label: opt(s),
		}),
		z.object({
			type: z.literal("map"),
			view: opt(z.enum(["now", "future"]).describe("now (default): what exists and its live state; future: target design")),
			items: opt(z.array(mapItem).describe("Boxes to add or replace by id. A box with children is drawn as a container")),
			edges: opt(z.array(edge)),
			edge_kinds: opt(
				z.record(z.object({ color: s.describe("pink|orange|yellow|green|blue|purple|mute|fg or #hex"), style: opt(z.enum(["solid", "dashed", "dotted"])), label: opt(s.describe("Legend text")) })),
			),
			remove_items: opt(z.array(s)),
			remove_edges: opt(z.array(edge)),
			replace: opt(z.boolean().describe("Clear this view before applying")),
		}),
		z.object({
			type: z.literal("node"),
			id: s.describe("Now-map box id"),
			state: opt(z.enum(NODE_STATES).describe("Ignored while a state-driving probe exists for the box")),
			note: opt(s.describe("Current status in one or two sentences")),
			ci: opt(s.describe("CI workflow names (globs, comma separated) whose runs become tests on this box; '-' clears")),
			label: opt(s.describe("Forge issue label whose issues become this box's issues; '-' clears")),
		}),
		z.object({
			type: z.literal("probe"),
			node: s.describe("Now-map box the check belongs to"),
			name: s.describe("Check name (match key with node)"),
			http: opt(s.describe("URL to GET; passes on status < 400 or expect_status")),
			tcp: opt(s.describe("host:port that must accept a connection")),
			cmd: opt(s.describe("Shell command run in the project root; passes on exit 0")),
			expect_status: opt(z.number()),
			expect_text: opt(s.describe("Text the response body / command output must contain")),
			every_s: opt(z.number().describe("Seconds between runs (default 60, min 10)")),
			timeout_s: opt(z.number().describe("Default 10")),
			drives_state: opt(z.boolean().describe("Default true: all checks pass → live, any fails → blocked")),
			remove: removeFlag,
		}),
		z.object({
			type: z.literal("test"),
			node: opt(s.describe("Now-map box under test")),
			name: s.describe("Test name; reuse the same name for the outcome post"),
			result: z.enum(TEST_RESULTS).describe("running when starting; pass/fail/stopped when done"),
			why: opt(z.array(s).describe("Fail/stopped: reasons, most important first")),
			next: opt(s.describe("Fail/stopped: what happens next")),
			lane: opt(s.describe("Work lane / ticket")),
			where: opt(s.describe("Where it runs")),
			timeout_h: opt(z.number().describe("Hours a running test may take before it shows as 'no result' (default 3); set it for long runs")),
		}),
		z.object({
			type: z.literal("issue"),
			node: s,
			what: opt(s.describe("The problem found (required for a new issue)")),
			id: opt(s),
			fix: opt(s),
			status: opt(z.enum(ISSUE_STATUSES)),
			lane: opt(s),
			remove: removeFlag,
		}),
		z.object({
			type: z.literal("inventory"),
			node: s,
			summary: opt(s),
			items: z.array(z.object({ what: s, detail: opt(s), state: opt(s.describe("live, building, …")) })),
			source: opt(s),
		}),
		z.object({
			type: z.literal("area"),
			name: s,
			id: opt(s),
			pct: opt(z.number()),
			state: opt(z.enum(WORK_STATES)),
			note: opt(s),
			weight: opt(z.number()),
			milestone: opt(s.describe("Derive pct from the milestone / chunk / todo phase with this title")),
			map: opt(s.describe("Derive pct from the share of live boxes under this map container")),
			remove: removeFlag,
		}),
		z.object({
			type: z.literal("step"),
			step: s.describe("Critical-path step text (match key)"),
			id: opt(s),
			state: opt(z.enum(WORK_STATES)),
			eta: opt(s),
			owner: opt(s),
			note: opt(s),
			position: opt(z.number().describe("0-based position in the path")),
			remove: removeFlag,
		}),
		z.object({ type: z.literal("phase"), phase: s, start: s.describe("YYYY-MM-DD"), end: s.describe("YYYY-MM-DD"), items: opt(z.array(s)), id: opt(s), remove: removeFlag }),
		z.object({
			type: z.literal("estimate"),
			label: s,
			when: opt(s.describe("Human text, e.g. 'Nov 12, ~18:00'")),
			start: opt(s.describe("ISO date/datetime for the timeline")),
			end: opt(s.describe("ISO date/datetime for the timeline")),
			id: opt(s),
			remove: removeFlag,
		}),
		z.object({ type: z.literal("owner_item"), text: s.describe("What the owner must do or decide"), key: opt(s.describe("Short tag")), id: opt(s), remove: removeFlag }),
		z.object({ type: z.literal("fact"), key: s, value: opt(s), remove: removeFlag }),
		z.object({ type: z.literal("chunk"), title: s, open: opt(z.number()), closed: opt(z.number()), id: opt(s), remove: removeFlag }),
		z.object({ type: z.literal("post"), kind: z.enum(POST_KINDS), text: s }),
		z.object({ type: z.literal("test_note"), test_id: s, why: opt(s), next: opt(s) }),
		z.object({
			type: z.literal("agent"),
			kind: opt(s.describe("Your role: builder, reviewer, driver, coordinator, watcher, …")),
			focus: opt(s.describe("Your assignment")),
			name: opt(s.describe("Display name")),
			now: opt(s.describe("What you are doing right now")),
		}),
		z.object({
			type: z.literal("tab"),
			id: s.describe("Tab id, lowercase-dashes, e.g. 'leaderboard'"),
			title: opt(s.describe("Tab title (required for a new tab)")),
			note: opt(s.describe("One line under the title, e.g. the question the run answers")),
			blocks: opt(z.array(tabBlock).describe("Replaces all blocks when given")),
			public: opt(z.boolean().describe("Show on share links and exports (default true)")),
			order: opt(z.number()),
			remove: removeFlag,
		}),
		z.object({
			type: z.literal("tab_block"),
			tab: s,
			block: tabBlock.describe("Block to add, or fields to merge into the block with this id"),
			position: opt(z.number().describe("0-based position for a new block")),
			remove: removeFlag,
		}),
		z.object({
			type: z.literal("tab_rows"),
			tab: s,
			block: s.describe("Table block id"),
			rows: opt(z.array(z.record(z.unknown())).describe("Rows to add or merge, matched on the block's row_key (default: first column)")),
			remove_keys: opt(z.array(s)),
		}),
	]);

	const noTracker = () => ({
		content: [{ type: "text" as const, text: "No build tracker in this project. The user can create one with `/tracker init`." }],
		details: {},
	});

	pi.registerTool({
		name: "tracker_update",
		label: "Tracker Update",
		approval: "write",
		loadMode: findTrackerDir(process.cwd()) ? "essential" : "discoverable",
		description: [
			"Post progress to the project's live build tracker (a dashboard the owner watches).",
			"Ops apply in order; each is atomic and failures are reported per op. Upserts match by id, else by name/text.",
			`Op types: ${OP_TYPES.join(", ")}.`,
			"map: define boxes (items, optional parent containers) and edges for the now or future view.",
			`node: set a now-map box state (${NODE_STATES.join("/")}) and note; bind it to CI workflows (ci) and issue labels (label).`,
			"probe: a health check (http/tcp/cmd) the server runs on a schedule; results post tests and set the box state with no further agent work.",
			"test: post 'running' when a test starts and pass/fail/stopped with the same name when it ends.",
			"issue: problem found on a box (open → in progress → fixed). post: decision | blocker | note.",
			"area/step/phase/estimate/owner_item/fact/chunk: progress areas, critical path, completed phases, estimates, items waiting on the owner, environment facts, work chunks.",
			"tab / tab_block / tab_rows: a run-specific tab you design from blocks (table, stats, kv, list, text, chart), e.g. a leaderboard; update single rows with tab_rows. Table column kinds: text, number, score (with bar), pct, delta, state, tokens; rows may set _muted, _highlight, _unranked, _note.",
		].join("\n"),
		parameters: z.object({ ops: z.array(op).describe("Updates to apply in order") }),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const dir = findTrackerDir(ctx.cwd);
			if (!dir) return noTracker();
			const st = new TrackerStore(dir);
			const sessionId = isCurator ? "curator" : ctx.sessionManager.getSessionId();
			// Shape enforced by the tool's parameter schema before execute runs.
			const { ops } = params as { ops: Op[] };
			const out = applyOps(st, ops, sessionId);
			const summary = out.lines[out.lines.length - 1];
			const t = nowIso();
			st.patchAgent(
				sessionId,
				{ lastPost: t, ...(summary ? { last: summary } : {}), ...(out.agentPatch ?? {}) },
				() => ({ ...baseRecord(ctx), id: sessionId }),
			);
			const text = [...out.lines.map(l => `✓ ${l}`), ...out.errors.map(e => `✗ ${e}`)].join("\n") || "No changes.";
			return { content: [{ type: "text", text }], details: { applied: out.lines.length, errors: out.errors }, isError: out.errors.length > 0 && out.lines.length === 0 };
		},
	});

	pi.registerTool({
		name: "tracker_view",
		label: "Tracker View",
		approval: "read",
		loadMode: findTrackerDir(process.cwd()) ? "essential" : "discoverable",
		description: "Read the live build tracker: headline, map box ids and states, open issues, tests running and failing, critical path, blockers, agents. Use it before posting to learn ids.",
		parameters: z.object({
			section: opt(z.enum(["summary", "map", "tests", "agents", "path", "feeds", "tabs"]).describe("Default summary covers everything briefly; tabs prints custom tab tables in full")),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const dir = findTrackerDir(ctx.cwd);
			if (!dir) return noTracker();
			const st = new TrackerStore(dir);
			const snap = buildSnapshot(st, undefined, undefined);
			const url = servers.get(dir)?.url ?? st.readServer()?.url;
			const { section } = params as { section?: ViewSection };
			return { content: [{ type: "text", text: summarize(snap, section ?? "summary", url) }], details: {} };
		},
	});

	// ---- /tracker command ----
	pi.registerCommand("tracker", {
		description: "Live build tracker: /tracker [init [title] | open | share [funnel|tailnet|off|rotate|cloudflare …] | curator [on [model]|off|run|status] | stop | export [file] | status]",
		handler: async (args, ctx) => {
			const [sub = "open", ...rest] = args.trim().split(/\s+/).filter(Boolean);
			if (sub === "init") {
				const existing = findTrackerDir(ctx.cwd);
				if (existing) {
					ctx.ui.notify(`Tracker already exists: ${existing}`, "info");
					return;
				}
				const gitTop = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd: ctx.cwd }).catch(() => undefined);
				const root = gitTop && gitTop.code === 0 && gitTop.stdout.trim() ? gitTop.stdout.trim() : ctx.cwd;
				const repo = await detectRepo(root);
				const forge = repo?.host === "github.com" ? { type: "github" as const, repo: repo.repo } : { type: "none" as const };
				const st = TrackerStore.init(root, rest.join(" ") || path.basename(root), forge);
				await attach(ctx);
				pi.setActiveTools([...new Set([...pi.getActiveTools(), "tracker_update", "tracker_view"])]);
				const url = await ensureServer(st, log);
				openUrl(pi, url);
				ctx.ui.notify(`Tracker created at ${st.dir} (forge: ${forge.type}${repo ? ` ${repo.repo}` : ""}). Dashboard: ${url}`, "info");
				return;
			}
			const dir = findTrackerDir(ctx.cwd);
			if (!dir) {
				ctx.ui.notify("No tracker here. Run /tracker init [title] first.", "warning");
				return;
			}
			const st = new TrackerStore(dir);
			const shareLine = (s: { mode: string; url?: string; error?: string } | undefined) =>
				!s || s.mode === "off"
					? "Sharing: off"
					: s.url
						? `${s.mode === "funnel" ? "Public read-only link (anyone with it can view)" : "Tailnet link"}: ${s.url}`
						: `Sharing (${s.mode}) failed: ${s.error ?? "unknown error"}`;
			if (sub === "open" || sub === "serve") {
				const url = await ensureServer(st, log);
				openUrl(pi, url);
				const share = servers.get(dir)?.shareStatus() ?? st.readServer()?.share;
				ctx.ui.notify(`Build tracker: ${url}${share && share.mode !== "off" ? `\n${shareLine(share)}` : ""}`, "info");
			} else if (sub === "share") {
				const action = (rest[0] ?? "funnel") as ShareAction | "status" | "cloudflare";
				if (action === "cloudflare") {
					const sub2 = (rest[1] ?? "on") as CloudflareAction;
					if (!["on", "off", "rotate", "status"].includes(sub2)) {
						ctx.ui.notify("Usage: /tracker share cloudflare [on|off|rotate|status]", "warning");
						return;
					}
					if (sub2 === "on" && !servers.has(dir) && !st.readServer()) await ensureServer(st, log);
					if (sub2 !== "status") ctx.ui.notify("Working with Cloudflare (wrangler)…", "info");
					const r = await cloudflareCommand(st, sub2);
					ctx.ui.notify(r.text, r.ok ? "info" : "warning");
					return;
				}
				if (action === "status") {
					const cf = await cloudflareCommand(st, "status");
					ctx.ui.notify(`${shareLine(servers.get(dir)?.shareStatus() ?? st.readServer()?.share ?? { mode: st.config().share.mode })}\n${cf.text}`, "info");
					return;
				}
				if (!["funnel", "tailnet", "off", "rotate"].includes(action)) {
					ctx.ui.notify("Usage: /tracker share [funnel|tailnet|off|rotate|status|cloudflare [on|off|rotate|status]]", "warning");
					return;
				}
				if (action !== "off" && !servers.has(dir) && !st.readServer()) await ensureServer(st, log);
				const status = await configureShare(st, action, servers.get(dir));
				ctx.ui.notify(status.error ? `Sharing failed: ${status.error}` : shareLine(status), status.error ? "warning" : "info");
			} else if (sub === "curator") {
				const action = (rest[0] ?? "status") as CuratorAction;
				if (!["on", "off", "run", "status"].includes(action)) {
					ctx.ui.notify("Usage: /tracker curator [on [model] | off | run | status]", "warning");
					return;
				}
				if (action === "run") ctx.ui.notify("Running the tracker curator…", "info");
				const r = await curatorCommand(st, action, rest[1]);
				ctx.ui.notify(r.text, r.ok ? "info" : "warning");
			} else if (sub === "stop") {
				const srv = servers.get(dir);
				if (srv) {
					srv.stop();
					servers.delete(dir);
					ctx.ui.notify("Tracker server stopped.", "info");
				} else ctx.ui.notify(`No server owned by this session${st.readServer() ? ` (another process serves ${st.readServer()!.url})` : ""}.`, "info");
			} else if (sub === "export") {
				const target = path.resolve(ctx.cwd, rest[0] ?? path.join(projectRoot(dir), "tracker.html"));
				const root = projectRoot(dir);
				let forgeErr: string | undefined;
				const forge = await collectForge(root, st.config().forge).catch(err => {
					forgeErr = String(err instanceof Error ? err.message : err);
					return undefined;
				});
				const html = renderStandaloneHtml(buildSnapshot(st, await collectGit(root, st.config().git?.branch), forge, forgeErr));
				await Bun.write(target, html);
				ctx.ui.notify(`Exported static dashboard to ${target}`, "info");
			} else if (sub === "status") {
				const url = servers.get(dir)?.url ?? st.readServer()?.url;
				ctx.ui.notify(summarize(buildSnapshot(st, undefined, undefined), "summary", url), "info");
			} else ctx.ui.notify("Usage: /tracker [init [title] | open | share … | curator … | stop | export [file] | status]", "warning");
		},
	});
}
