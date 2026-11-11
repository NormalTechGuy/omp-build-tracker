#!/usr/bin/env bun
// omp-tracker: run the dashboard outside omp, post from any agent or script,
// export a static snapshot, or seed a demo.
import * as fs from "node:fs";
import * as path from "node:path";
import { collectForge, collectGit, detectRepo } from "./collectors";
import { seedDemo } from "./demo";
import { applyOps, OP_TYPES, type Op } from "./ops";
import { cloudflareCommand, type CloudflareAction } from "./cloudflare";
import { curatorCommand, type CuratorAction } from "./curator";
import { configureShare, renderStandaloneHtml, TrackerServer, type ShareAction } from "./server";
import { buildSnapshot } from "./snapshot";
import { findTrackerDir, nowIso, projectRoot, TrackerStore } from "./store";
import { AGENT_STATUSES, type AgentRecord, type ShareStatus, type TrackerConfig } from "./types";
import { summarize, type ViewSection } from "./view";

const USAGE = `omp-tracker — live build tracker for long-running agents

  omp-tracker init [--title T] [--forge github|gitea|none] [--repo owner/name] [--url GITEA_URL] [--token-env VAR]
  omp-tracker serve [--open] [--share funnel|tailnet]   run the dashboard server in the foreground
  omp-tracker share [funnel|tailnet|off|rotate|status]  share via Tailscale: funnel = public read-only link,
                                             tailnet = your devices only; rotate = new link, old one dies
  omp-tracker share cloudflare [on|off|rotate|status]   always-on read-only copy on Cloudflare (needs "npx wrangler login")
  omp-tracker post [--agent ID] OP_JSON...   apply ops (JSON objects or one JSON array; "-" reads stdin)
  omp-tracker agent --id ID [--name N] [--status running|idle|closed|error] [--now TEXT]
                    [--action TEXT] [--focus TEXT] [--engine E] [--model M] [--kind K] [--thinking L]
  omp-tracker curator [on [MODEL]|off|run|status]   cheap agent that reconciles the tracker with all sessions' activity
  omp-tracker view [summary|map|tests|agents|path|feeds]
  omp-tracker export [FILE]                  write a self-contained HTML snapshot
  omp-tracker demo [DIR] [--repo owner/name] [--share funnel]   seed a demo tracker (default DIR /tmp/omp-tracker-demo) and serve it

Op types: ${OP_TYPES.join(", ")}. The tracker is found from the current directory
(.omp/tracker in an ancestor) or $OMP_TRACKER_DIR.`;

function parse(argv: string[]): { pos: string[]; flags: Record<string, string | true> } {
	const pos: string[] = [];
	const flags: Record<string, string | true> = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a.startsWith("--")) {
			const [k, v] = a.slice(2).split("=", 2);
			if (v !== undefined) flags[k] = v;
			else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) flags[k] = argv[++i];
			else flags[k] = true;
		} else pos.push(a);
	}
	return { pos, flags };
}

function flag(flags: Record<string, string | true>, k: string): string | undefined {
	const v = flags[k];
	return typeof v === "string" ? v : undefined;
}

function requireStore(): TrackerStore {
	const dir = findTrackerDir(process.cwd());
	if (!dir) {
		console.error("No tracker found. Run `omp-tracker init` in the project root (or set OMP_TRACKER_DIR).");
		process.exit(1);
	}
	return new TrackerStore(dir);
}

function printShare(s: ShareStatus): void {
	if (s.mode === "off") console.log("Sharing: off");
	else if (s.url) console.log(`${s.mode === "funnel" ? "Public read-only link (anyone with it can view)" : "Tailnet link"}: ${s.url}`);
	else console.error(`Sharing (${s.mode}) not live: ${s.error ?? "unknown"}`);
}

async function serve(store: TrackerStore, open: boolean, share?: string): Promise<void> {
	const server = new TrackerServer(store, m => console.error(m));
	const url = await server.start();
	console.log(`Build tracker for ${projectRoot(store.dir)}: ${url}`);
	if (share) {
		if (share !== "funnel" && share !== "tailnet") throw new Error("--share must be funnel or tailnet");
		printShare(await configureShare(store, share, server));
	} else if (server.shareStatus().mode !== "off") printShare(server.shareStatus());
	if (open) Bun.spawn([process.platform === "darwin" ? "open" : "xdg-open", url], { stdout: "ignore", stderr: "ignore" });
	const stop = () => {
		server.stop();
		process.exit(0);
	};
	process.on("SIGINT", stop);
	process.on("SIGTERM", stop);
	await new Promise(() => {});
}

async function main(): Promise<void> {
	const [cmd, ...rest] = process.argv.slice(2);
	const { pos, flags } = parse(rest);
	switch (cmd) {
		case "init": {
			const git = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], { stderr: "ignore" });
			const root = git.exitCode === 0 ? git.stdout.toString().trim() : process.cwd();
			const type = (flag(flags, "forge") ?? "") as TrackerConfig["forge"]["type"] | "";
			let forge: TrackerConfig["forge"] = { type: "none" };
			const repo = flag(flags, "repo");
			if (type === "gitea") forge = { type: "gitea", repo, url: flag(flags, "url"), tokenEnv: flag(flags, "token-env") ?? "GITEA_TOKEN" };
			else if (type === "github" || (!type && (repo || (await detectRepo(root))?.host === "github.com")))
				forge = { type: "github", repo: repo ?? (await detectRepo(root))?.repo };
			const store = TrackerStore.init(root, flag(flags, "title") ?? path.basename(root), forge);
			console.log(`Tracker at ${store.dir} (forge: ${forge.type}${forge.repo ? ` ${forge.repo}` : ""}).`);
			return;
		}
		case "serve":
			return serve(requireStore(), flags.open === true, flag(flags, "share"));
		case "curator": {
			const action = (pos[0] ?? "status") as CuratorAction;
			if (!["on", "off", "run", "status"].includes(action)) throw new Error("usage: omp-tracker curator [on [model] | off | run | status]");
			const r = await curatorCommand(requireStore(), action, pos[1]);
			(r.ok ? console.log : console.error)(r.text);
			process.exit(r.ok ? 0 : 1);
		}
		case "share": {
			const store = requireStore();
			const action = (pos[0] ?? "status") as ShareAction | "status" | "cloudflare";
			if (action === "cloudflare") {
				const sub = (pos[1] ?? "on") as CloudflareAction;
				if (!["on", "off", "rotate", "status"].includes(sub)) throw new Error("usage: omp-tracker share cloudflare [on|off|rotate|status]");
				const r = await cloudflareCommand(store, sub);
				(r.ok ? console.log : console.error)(r.text);
				process.exit(r.ok ? 0 : 1);
			}
			if (action === "status") {
				printShare(store.readServer()?.share ?? { mode: store.config().share.mode, error: "no dashboard server running" });
				console.log((await cloudflareCommand(store, "status")).text);
				return;
			}
			if (!["funnel", "tailnet", "off", "rotate"].includes(action))
				throw new Error("usage: omp-tracker share [funnel|tailnet|off|rotate|status|cloudflare [on|off|rotate|status]]");
			const status = await configureShare(store, action);
			printShare(status);
			process.exit(status.error ? 1 : 0);
			return;
		}
		case "post": {
			const store = requireStore();
			let raw = pos;
			if (pos.length === 1 && pos[0] === "-") raw = [await Bun.stdin.text()];
			const ops: Op[] = [];
			for (const r of raw) {
				const v = JSON.parse(r) as unknown;
				for (const o of Array.isArray(v) ? v : [v]) ops.push(o as Op);
			}
			const agent = flag(flags, "agent");
			const out = applyOps(store, ops, agent);
			if (agent) {
				const summary = out.lines[out.lines.length - 1];
				store.patchAgent(agent, { lastPost: nowIso(), ...(summary ? { last: summary } : {}), ...(out.agentPatch ?? {}) });
			}
			for (const l of out.lines) console.log(`✓ ${l}`);
			for (const e of out.errors) console.error(`✗ ${e}`);
			process.exit(out.errors.length && !out.lines.length ? 1 : 0);
			return;
		}
		case "agent": {
			const store = requireStore();
			const id = flag(flags, "id");
			if (!id) throw new Error("--id is required");
			const status = flag(flags, "status");
			if (status && !(AGENT_STATUSES as readonly string[]).includes(status)) throw new Error(`--status must be one of ${AGENT_STATUSES.join(", ")}`);
			const patch: Partial<AgentRecord> = {};
			for (const k of ["name", "now", "action", "focus", "engine", "model", "kind", "thinking"] as const) {
				const v = flag(flags, k);
				if (v !== undefined) patch[k] = v;
			}
			if (status) patch.status = status as AgentRecord["status"];
			const t = nowIso();
			const rec = store.patchAgent(id, patch, () => ({ id, name: id, engine: "external", status: "running", kind: "builder", started: t, updated: t }));
			console.log(JSON.stringify(rec));
			return;
		}
		case "view": {
			const store = requireStore();
			console.log(summarize(buildSnapshot(store, undefined, undefined), (pos[0] ?? "summary") as ViewSection, store.readServer()?.url));
			return;
		}
		case "export": {
			const store = requireStore();
			const root = projectRoot(store.dir);
			const cfg = store.config();
			let forgeErr: string | undefined;
			const forge = await collectForge(root, cfg.forge).catch(err => {
				forgeErr = err instanceof Error ? err.message : String(err);
				return undefined;
			});
			const git = cfg.git?.disabled ? undefined : await collectGit(root, cfg.git?.branch);
			const target = path.resolve(pos[0] ?? path.join(root, "tracker.html"));
			fs.writeFileSync(target, renderStandaloneHtml(buildSnapshot(store, git, forge, forgeErr)));
			console.log(`Wrote ${target}`);
			return;
		}
		case "demo": {
			const dir = path.resolve(pos[0] ?? "/tmp/omp-tracker-demo");
			fs.mkdirSync(dir, { recursive: true });
			const store = seedDemo(dir, flag(flags, "repo"));
			console.log(`Demo tracker seeded at ${store.dir}`);
			return serve(store, flags.open === true, flag(flags, "share"));
		}
		default:
			console.log(USAGE);
			process.exit(cmd && cmd !== "help" && cmd !== "--help" ? 1 : 0);
	}
}

main().catch(err => {
	console.error(err instanceof Error ? err.message : String(err));
	process.exit(1);
});
