// Dashboard HTTP server: static UI, JSON snapshot, server-sent events for live
// updates, and a small write API so agents outside omp can post too.
import * as fs from "node:fs";
import * as path from "node:path";
import { collectForge, collectGit, type ForgeData, type GitData } from "./collectors";
import { applyOps, OP_TYPES, type Op } from "./ops";
import { applyShare, newSharePath, redactDeep, removeShare, ShareError } from "./share";
import { buildSnapshot, historyPoint, type Snapshot } from "./snapshot";
import { nowIso, projectRoot, type TrackerStore } from "./store";
import { CloudflarePusher } from "./cloudflare";
import { Prober } from "./probes";
import { AGENT_STATUSES, type AgentRecord, type CloudflareStatus, type ShareConfig, type ShareStatus } from "./types";

const WEB_DIR = path.join(import.meta.dir, "..", "web");

export function stablePort(dir: string): number {
	let h = 0;
	for (const c of dir) h = (h * 31 + c.charCodeAt(0)) >>> 0;
	return 47100 + (h % 800);
}

/** What anyone with a share link or an export sees: secrets redacted, host details dropped. */
export function publicView(s: Snapshot): Snapshot {
	const out = redactDeep(s);
	out.public = true;
	// Probe commands can reveal internals; the public view shows only the check name.
	out.checks = out.checks.map(c => (c.kind === "cmd" ? { ...c, target: "" } : c));
	delete out.forge_error;
	out.agents = out.agents.map(({ pid: _pid, host: _host, ...a }) => a);
	delete out.cloudflare;
	// Keep shared payloads small: at most ~400 trend points.
	if (out.history.length > 400) {
		const step = out.history.length / 400;
		out.history = Array.from({ length: 400 }, (_, i) => out.history[Math.floor(i * step)]).concat(out.history[out.history.length - 1]);
	}
	return out;
}

/** Inline CSS, JS and Chart.js plus the (public view of the) data into one self-contained HTML file. */
export function renderStandaloneHtml(snapshot: Snapshot): string {
	const html = fs.readFileSync(path.join(WEB_DIR, "index.html"), "utf8");
	const css = fs.readFileSync(path.join(WEB_DIR, "app.css"), "utf8");
	const js = fs.readFileSync(path.join(WEB_DIR, "app.js"), "utf8");
	const chart = fs.readFileSync(path.join(WEB_DIR, "vendor", "chart.umd.min.js"), "utf8");
	const seed = JSON.stringify(publicView(snapshot)).replace(/</g, "\\u003c");
	const scriptSafe = (s: string) => s.replace(/<\/script/gi, "<\\/script");
	return html
		.replace('<link rel="stylesheet" href="app.css">', () => `<style>${css}</style>`)
		.replace('<script src="vendor/chart.umd.min.js"></script>', () => `<script>${scriptSafe(chart)}</script>`)
		.replace(
			'<script src="app.js"></script>',
			() => `<script id="seed" type="application/json">${seed}</script>\n<script>${scriptSafe(js)}</script>`,
		);
}

const STATIC: Record<string, [string, string]> = {
	"/": ["index.html", "text/html; charset=utf-8"],
	"/index.html": ["index.html", "text/html; charset=utf-8"],
	"/app.css": ["app.css", "text/css; charset=utf-8"],
	"/app.js": ["app.js", "text/javascript; charset=utf-8"],
	"/vendor/chart.umd.min.js": ["vendor/chart.umd.min.js", "text/javascript; charset=utf-8"],
};

export class TrackerServer {
	readonly store: TrackerStore;
	readonly root: string;
	url = "";
	private server?: Bun.Server<undefined>;
	/** Read-only, redacted listener that Tailscale Funnel points at. */
	private publicServer?: Bun.Server<undefined>;
	private git?: GitData;
	private forge?: ForgeData;
	private forgeError?: string;
	private snapshot?: Snapshot;
	private publicSnapshot?: Snapshot;
	private clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
	private publicClients = new Set<ReadableStreamDefaultController<Uint8Array>>();
	private watchers: fs.FSWatcher[] = [];
	private timers: Timer[] = [];
	private rebuildTimer?: Timer;
	private encoder = new TextEncoder();
	private log: (msg: string) => void;
	private share: ShareStatus = { mode: "off" };
	/** Share config + target last pushed to Tailscale. */
	private applied?: { share: ShareConfig; target: string };
	private shareSync: Promise<ShareStatus> = Promise.resolve(this.share);
	private cloud: CloudflarePusher;
	private prober: Prober;

	constructor(store: TrackerStore, log: (msg: string) => void = () => {}) {
		this.store = store;
		this.root = projectRoot(store.dir);
		this.log = log;
		this.cloud = new CloudflarePusher(store, log, () => this.writeServerJson());
		this.prober = new Prober(store, this.root, () => this.scheduleRebuild());
	}

	async start(): Promise<string> {
		const cfg = this.store.config();
		const host = cfg.host ?? "127.0.0.1";
		const preferred = cfg.port ?? stablePort(this.store.dir);
		let lastErr: unknown;
		for (const port of [preferred, preferred + 1, preferred + 2, 0]) {
			try {
				this.server = Bun.serve({ hostname: host, port, idleTimeout: 0, fetch: req => this.handle(req) });
				break;
			} catch (err) {
				lastErr = err;
			}
		}
		if (!this.server) throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
		this.url = `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${this.server.port}/`;
		this.writeServerJson();

		await Promise.all([this.refreshGit(), this.refreshForge()]);
		this.rebuild();
		this.recordHistory(true);
		await this.syncShare();

		const onChange = (_ev: string, file: string | Buffer | null) => {
			const name = String(file ?? "");
			if (name.endsWith(".tmp") || name.endsWith(".lock") || name === "server.json" || name === "history.jsonl" || name === "probes.json") return;
			if (name === "config.json") void this.syncShare();
			this.scheduleRebuild();
		};
		for (const dir of [this.store.dir, this.store.agentsDir]) {
			try {
				fs.mkdirSync(dir, { recursive: true });
				this.watchers.push(fs.watch(dir, onChange));
			} catch (err) {
				this.log(`tracker: cannot watch ${dir}: ${String(err)}`);
			}
		}
		const every = (ms: number, fn: () => unknown) => {
			this.timers.push(
				setInterval(() => {
					Promise.resolve()
						.then(fn)
						.catch(err => this.log(`tracker: ${String(err)}`));
				}, ms),
			);
		};
		every(cfg.refresh.gitSeconds * 1000, async () => {
			await this.refreshGit();
			this.scheduleRebuild();
		});
		every(cfg.refresh.forgeSeconds * 1000, async () => {
			await this.refreshForge();
			this.scheduleRebuild();
		});
		every(20_000, () => this.rebuild()); // ages, stale agents, no-result tests
		every(5_000, () => this.prober.tick()); // health checks, each on its own schedule
		every(60_000, () => this.recordHistory(false));
		every(15_000, () => this.broadcastRaw(": keepalive\n\n"));
		every(3_600_000, () => this.store.rotateEventsIfLarge());
		return this.url;
	}

	stop(): void {
		for (const w of this.watchers) w.close();
		for (const t of this.timers) clearInterval(t);
		clearTimeout(this.rebuildTimer);
		for (const c of [...this.clients, ...this.publicClients]) {
			try {
				c.close();
			} catch {}
		}
		this.clients.clear();
		this.publicClients.clear();
		this.server?.stop(true);
		this.server = undefined;
		this.publicServer?.stop(true);
		this.cloud.stop();
		// The Tailscale mapping stays: the link works again as soon as a server restarts.
		try {
			const s = JSON.parse(fs.readFileSync(this.store.serverPath, "utf8")) as { pid?: number };
			if (s.pid === process.pid) fs.rmSync(this.store.serverPath, { force: true });
		} catch {}
	}

	shareStatus(): ShareStatus {
		return this.share;
	}

	cloudflareStatus(): CloudflareStatus {
		return this.cloud.status;
	}

	private writeServerJson(): void {
		if (!this.server) return; // stopped: never resurrect server.json
		fs.writeFileSync(
			this.store.serverPath,
			JSON.stringify({ pid: process.pid, port: this.server?.port, url: this.url, started: nowIso(), share: this.share, cloudflare: this.cloud.status }),
		);
	}

	/** Bring Tailscale and the public listener in line with config.json. Serialized; safe to call often. */
	syncShare(): Promise<ShareStatus> {
		this.shareSync = this.shareSync.then(
			() => this.doSyncShare(),
			() => this.doSyncShare(),
		);
		return this.shareSync;
	}

	private async doSyncShare(): Promise<ShareStatus> {
		const share = this.store.config().share;
		const want = share.mode === "off" ? undefined : share;
		try {
			if (want?.mode === "funnel") this.startPublicServer(want);
			else if (this.publicServer) {
				this.publicServer.stop(true);
				this.publicServer = undefined;
			}
			const target = want ? `http://127.0.0.1:${(want.mode === "funnel" ? this.publicServer : this.server)!.port}` : "";
			const prev = this.applied;
			const unchanged =
				!!prev && !!want && prev.share.mode === want.mode && prev.share.path === want.path && prev.share.httpsPort === want.httpsPort && prev.target === target;
			if (unchanged && this.share.url) {
				// Already applied with this config and target.
			} else if (!want) {
				if (prev) await removeShare(prev.share);
				this.applied = undefined;
				this.share = { mode: "off" };
			} else {
				const samePlace = !!prev && prev.share.path === want.path && prev.share.httpsPort === want.httpsPort;
				// Leaving funnel: drop the public mapping (and funnel on the port) before serving tailnet-only.
				if (prev && prev.share.mode === "funnel" && want.mode !== "funnel") await removeShare(prev.share);
				const url = await applyShare(want, target);
				// New link first, then retire the old one, so rotation never takes funnel down.
				if (prev && !samePlace && !(prev.share.mode === "funnel" && want.mode !== "funnel")) await removeShare(prev.share);
				this.applied = { share: { ...want }, target };
				this.share = { mode: want.mode, path: want.path, url };
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (!(err instanceof ShareError)) this.log(`tracker: share failed: ${msg}`);
			this.share = { mode: share.mode, path: share.path, error: msg };
		}
		this.share.at = nowIso();
		this.writeServerJson();
		this.scheduleRebuild();
		return this.share;
	}

	private startPublicServer(share: ShareConfig): void {
		const preferred = share.publicPort ?? (this.store.config().port ?? stablePort(this.store.dir)) + 1000;
		if (this.publicServer && (share.publicPort === undefined || this.publicServer.port === share.publicPort)) return;
		this.publicServer?.stop(true);
		this.publicServer = undefined;
		for (const port of share.publicPort === undefined ? [preferred, preferred + 1, preferred + 2, 0] : [preferred]) {
			try {
				this.publicServer = Bun.serve({ hostname: "127.0.0.1", port, idleTimeout: 0, fetch: req => this.handlePublic(req) });
				return;
			} catch {}
		}
		throw new ShareError(`Cannot bind the read-only share listener on 127.0.0.1:${preferred}.`);
	}

	private async refreshGit(): Promise<void> {
		const cfg = this.store.config();
		if (cfg.git?.disabled) return;
		this.git = await collectGit(this.root, cfg.git?.branch);
	}

	private async refreshForge(): Promise<void> {
		try {
			this.forge = await collectForge(this.root, this.store.config().forge);
			this.forgeError = undefined;
		} catch (err) {
			this.forgeError = err instanceof Error ? err.message : String(err);
		}
	}

	private scheduleRebuild(): void {
		if (this.rebuildTimer) return;
		this.rebuildTimer = setTimeout(() => {
			this.rebuildTimer = undefined;
			try {
				this.rebuild();
			} catch (err) {
				this.log(`tracker: rebuild failed: ${String(err)}`);
			}
		}, 250);
	}

	private rebuild(): void {
		const snap = buildSnapshot(this.store, this.git, this.forge, this.forgeError);
		snap.share = this.share;
		const before = JSON.stringify(this.cloud.status);
		this.cloud.refresh();
		snap.cloudflare = this.cloud.status;
		this.snapshot = snap;
		this.broadcastRaw(`event: snapshot\ndata: ${JSON.stringify(snap)}\n\n`, this.clients);
		this.publicSnapshot = undefined;
		if (this.publicServer) this.broadcastRaw(`event: snapshot\ndata: ${JSON.stringify(this.currentPublic())}\n\n`, this.publicClients);
		this.cloud.offer(() => JSON.stringify({ ...this.currentPublic(), share: { mode: "cloudflare" } }));
		if (JSON.stringify(this.cloud.status) !== before) this.writeServerJson();
	}

	private recordHistory(onStart: boolean): void {
		if (!this.snapshot) return;
		const minutes = this.store.config().refresh.historyMinutes;
		const hist = this.store.readHistory();
		const last = hist[hist.length - 1];
		if (last && Date.now() - Date.parse(last.t) < minutes * 60_000 * (onStart ? 0.5 : 1)) return;
		this.store.appendHistory(historyPoint(this.snapshot));
		this.scheduleRebuild();
	}

	private broadcastRaw(chunk: string, clients?: Set<ReadableStreamDefaultController<Uint8Array>>): void {
		const bytes = this.encoder.encode(chunk);
		for (const set of clients ? [clients] : [this.clients, this.publicClients]) {
			for (const c of set) {
				try {
					c.enqueue(bytes);
				} catch {
					set.delete(c);
				}
			}
		}
	}

	private staticFile(pathname: string): Response | undefined {
		const route = STATIC[pathname];
		if (!route) return undefined;
		return new Response(Bun.file(path.join(WEB_DIR, route[0])), {
			headers: { "content-type": route[1], "cache-control": "no-cache" },
		});
	}

	private stream(clients: Set<ReadableStreamDefaultController<Uint8Array>>, current: () => Snapshot): Response {
		let ctrl: ReadableStreamDefaultController<Uint8Array> | undefined;
		const stream = new ReadableStream<Uint8Array>({
			start: c => {
				ctrl = c;
				clients.add(c);
				c.enqueue(this.encoder.encode(`retry: 3000\nevent: snapshot\ndata: ${JSON.stringify(current())}\n\n`));
			},
			cancel: () => {
				if (ctrl) clients.delete(ctrl);
			},
		});
		return new Response(stream, {
			// x-accel-buffering: proxies (Tailscale serve included) must not buffer the event stream.
			headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" },
		});
	}

	private current(): Snapshot {
		if (!this.snapshot) this.rebuild();
		return this.snapshot!;
	}

	private currentPublic(): Snapshot {
		if (!this.publicSnapshot) {
			const pub = publicView(this.current());
			pub.share = { mode: this.share.mode };
			this.publicSnapshot = pub;
		}
		return this.publicSnapshot;
	}

	/** Funnel listener: GET only, redacted data, no write API. */
	private async handlePublic(req: Request): Promise<Response> {
		if (req.method !== "GET" && req.method !== "HEAD") return new Response("read-only", { status: 405, headers: { allow: "GET" } });
		const url = new URL(req.url);
		const file = this.staticFile(url.pathname);
		if (file) return file;
		if (url.pathname === "/api/snapshot") return Response.json(this.currentPublic());
		if (url.pathname === "/api/stream") return this.stream(this.publicClients, () => this.currentPublic());
		return new Response("not found", { status: 404 });
	}

	private async handle(req: Request): Promise<Response> {
		const url = new URL(req.url);
		if (req.method === "GET") {
			const file = this.staticFile(url.pathname);
			if (file) return file;
			if (url.pathname === "/api/snapshot") return Response.json(this.current());
			if (url.pathname === "/api/stream") return this.stream(this.clients, () => this.current());
			if (url.pathname === "/export.html")
				return new Response(renderStandaloneHtml(this.current()), {
					headers: { "content-type": "text/html; charset=utf-8", "content-disposition": 'attachment; filename="tracker.html"' },
				});
		}
		if (req.method === "POST" && url.pathname === "/api/ops") return this.postOps(req);
		if (req.method === "POST" && url.pathname === "/api/agent") return this.postAgent(req);
		return new Response("not found", { status: 404 });
	}

	private async readBody(req: Request): Promise<Record<string, unknown> | Response> {
		try {
			const body = (await req.json()) as unknown;
			if (!body || typeof body !== "object" || Array.isArray(body)) return Response.json({ error: "body must be a JSON object" }, { status: 400 });
			return body as Record<string, unknown>;
		} catch {
			return Response.json({ error: "invalid JSON" }, { status: 400 });
		}
	}

	/** POST /api/ops {agent?: string, ops: Op[]} */
	private async postOps(req: Request): Promise<Response> {
		const body = await this.readBody(req);
		if (body instanceof Response) return body;
		const ops = body.ops;
		if (!Array.isArray(ops) || ops.some(o => !o || typeof o !== "object" || !(OP_TYPES as readonly unknown[]).includes((o as { type?: unknown }).type)))
			return Response.json({ error: `ops must be a list of {type: ${OP_TYPES.join("|")}, ...}` }, { status: 400 });
		const agent = typeof body.agent === "string" ? body.agent : undefined;
		const out = applyOps(this.store, ops as Op[], agent);
		if (agent) {
			const summary = out.lines[out.lines.length - 1];
			this.store.patchAgent(agent, { lastPost: nowIso(), ...(summary ? { last: summary } : {}), ...(out.agentPatch ?? {}) });
		}
		return Response.json(out, { status: out.errors.length && !out.lines.length ? 400 : 200 });
	}

	/** POST /api/agent — heartbeat for agents that are not omp sessions (Codex, Claude Code, scripts). */
	private async postAgent(req: Request): Promise<Response> {
		const body = await this.readBody(req);
		if (body instanceof Response) return body;
		if (typeof body.id !== "string" || !body.id) return Response.json({ error: "id is required" }, { status: 400 });
		const status = body.status;
		if (status !== undefined && !(AGENT_STATUSES as readonly unknown[]).includes(status))
			return Response.json({ error: `status must be one of ${AGENT_STATUSES.join(", ")}` }, { status: 400 });
		const patch: Partial<AgentRecord> = {};
		for (const k of ["name", "engine", "model", "thinking", "kind", "now", "action", "focus", "parent"] as const)
			if (typeof body[k] === "string") patch[k] = body[k] as string;
		if (status) patch.status = status as AgentRecord["status"];
		const t = nowIso();
		const rec = this.store.patchAgent(body.id, patch, () => ({
			id: body.id as string,
			name: (body.name as string) ?? (body.id as string),
			engine: (body.engine as string) ?? "external",
			status: "running",
			kind: (body.kind as string) ?? "builder",
			started: t,
			updated: t,
		}));
		return Response.json(rec);
	}
}

export type ShareAction = "funnel" | "tailnet" | "off" | "rotate";

/**
 * Change sharing in config.json and wait for the running server to apply it.
 * `local` is the server owned by this process, if any; a server in another
 * process picks the change up through its config watcher.
 */
export async function configureShare(store: TrackerStore, action: ShareAction, local?: TrackerServer): Promise<ShareStatus> {
	const cfg = store.config();
	const prev = { ...cfg.share };
	if (action === "rotate") {
		if (cfg.share.mode === "off") return { mode: "off", error: "Sharing is off; nothing to rotate." };
		cfg.share.path = newSharePath();
	} else {
		cfg.share.mode = action;
		if (action !== "off" && !cfg.share.path) cfg.share.path = newSharePath();
	}
	store.saveConfig(cfg);
	if (local) return local.syncShare();
	const other = store.readServer();
	if (!other) {
		if (action === "off" && prev.mode !== "off") await removeShare(prev);
		return action === "off"
			? { mode: "off" }
			: { mode: cfg.share.mode, path: cfg.share.path, error: "No dashboard server is running; the link goes live when one starts (/tracker or omp-tracker serve)." };
	}
	const started = Date.now();
	const deadline = started + 45_000;
	while (Date.now() < deadline) {
		await Bun.sleep(500);
		const s = store.readServer()?.share;
		// Only a sync that ran after this change counts; older results describe the previous config.
		if (s?.at && Date.parse(s.at) >= started - 50 && s.mode === cfg.share.mode && (s.mode === "off" || s.path === cfg.share.path)) return s;
	}
	return { mode: cfg.share.mode, path: cfg.share.path, error: "Timed out waiting for the dashboard server to apply the change." };
}
