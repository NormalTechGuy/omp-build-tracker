// Always-on public copy of the dashboard on Cloudflare: a Worker with the
// dashboard as static assets and a Durable Object holding the latest redacted
// snapshot, which the tracker server pushes. Deployed with wrangler.
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { slug } from "./ops";
import type { TrackerStore } from "./store";
import type { CloudflareStatus } from "./types";

const PLUGIN_ROOT = path.join(import.meta.dir, "..");
const WRANGLER = ["npx", "-y", "wrangler@4"];

export class CloudflareError extends Error {}

export interface CloudflareSecrets {
	/** Link key: the first path segment of the public URL. */
	key: string;
	/** Bearer token the tracker server uses to push snapshots. */
	token: string;
}

export function cloudflareDir(store: TrackerStore): string {
	return path.join(store.dir, "cloudflare");
}

export function readSecrets(store: TrackerStore): CloudflareSecrets | undefined {
	try {
		return JSON.parse(fs.readFileSync(path.join(cloudflareDir(store), "secrets.json"), "utf8")) as CloudflareSecrets;
	} catch {
		return undefined;
	}
}

function writeSecrets(store: TrackerStore, s: CloudflareSecrets): void {
	fs.mkdirSync(cloudflareDir(store), { recursive: true });
	fs.writeFileSync(path.join(cloudflareDir(store), "secrets.json"), JSON.stringify(s, null, 1), { mode: 0o600 });
	// Keep deploy artefacts and secrets out of git.
	const ignore = path.join(store.dir, ".gitignore");
	const cur = fs.existsSync(ignore) ? fs.readFileSync(ignore, "utf8") : "";
	if (!cur.split("\n").includes("cloudflare/")) fs.appendFileSync(ignore, `${cur.endsWith("\n") || !cur ? "" : "\n"}cloudflare/\n`);
}

const newKey = () => `t-${randomBytes(15).toString("base64url")}`;

async function wrangler(args: string[], cwd: string, stdin?: string): Promise<string> {
	const proc = Bun.spawn([...WRANGLER, ...args], {
		cwd,
		stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, WRANGLER_SEND_METRICS: "false", NO_COLOR: "1" },
	});
	const timer = setTimeout(() => proc.kill(), 300_000);
	const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
	clearTimeout(timer);
	const text = `${out}\n${err}`;
	if (code !== 0) {
		if (/not authenticated|wrangler login|CLOUDFLARE_API_TOKEN/i.test(text))
			throw new CloudflareError("Not logged in to Cloudflare. Run once: npx wrangler login");
		if (/workers\.dev subdomain/i.test(text)) {
			const link = text.match(/https:\/\/dash\.cloudflare\.com\/\S+?\/workers\/onboarding/)?.[0] ?? "https://dash.cloudflare.com/ → Workers & Pages";
			throw new CloudflareError(`This Cloudflare account has no workers.dev subdomain yet. Pick one once at ${link}, then retry.`);
		}
		throw new CloudflareError(`wrangler ${args[0]} failed:\n${text.trim().split("\n").slice(-12).join("\n")}`);
	}
	return text;
}

function writeWranglerConfig(store: TrackerStore, name: string): string {
	const dir = cloudflareDir(store);
	fs.mkdirSync(dir, { recursive: true });
	const config = {
		name,
		main: path.join(PLUGIN_ROOT, "cloudflare", "worker.js"),
		compatibility_date: "2025-09-01",
		workers_dev: true,
		assets: { directory: path.join(PLUGIN_ROOT, "web"), binding: "ASSETS", run_worker_first: true },
		durable_objects: { bindings: [{ name: "STATE", class_name: "TrackerState" }] },
		migrations: [{ tag: "v1", new_sqlite_classes: ["TrackerState"] }],
		observability: { enabled: false },
	};
	const file = path.join(dir, "wrangler.json");
	fs.writeFileSync(file, JSON.stringify(config, null, 1));
	return file;
}

async function putSecrets(store: TrackerStore, configFile: string, values: Record<string, string>): Promise<void> {
	// Secrets go over stdin so they never touch the command line or disk.
	await wrangler(["secret", "bulk", "--config", configFile], cloudflareDir(store), JSON.stringify(values));
}

export function linkOf(url: string, key: string): string {
	return `${url.replace(/\/$/, "")}/${key}/`;
}

/** Deploy (or redeploy) the Worker, set its secrets and enable pushing. Returns the public link. */
export async function deployCloudflare(store: TrackerStore): Promise<CloudflareStatus> {
	const cfg = store.config();
	const name = cfg.cloudflare.name ?? `omp-tracker-${slug(store.readState().title).slice(0, 30)}-${randomBytes(2).toString("hex")}`.replace(/-+/g, "-");
	const secrets = readSecrets(store) ?? { key: newKey(), token: randomBytes(32).toString("hex") };
	writeSecrets(store, secrets);
	const configFile = writeWranglerConfig(store, name);
	const out = await wrangler(["deploy", "--config", configFile], cloudflareDir(store));
	const url = out.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/i)?.[0];
	if (!url) throw new CloudflareError(`Deployed, but could not find the workers.dev URL in wrangler output:\n${out.trim().slice(-600)}`);
	await putSecrets(store, configFile, { SHARE_KEY: secrets.key, WRITE_TOKEN: secrets.token });
	cfg.cloudflare = { ...store.config().cloudflare, enabled: true, name, url, assetsHash: assetsHash() };
	store.saveConfig(cfg);
	return { enabled: true, url: linkOf(url, secrets.key) };
}

/** Hash of what a deploy uploads (dashboard files + Worker). A different hash means the copy is out of date. */
export function assetsHash(): string {
	const h = new Bun.CryptoHasher("sha256");
	const walk = (dir: string) => {
		for (const name of fs.readdirSync(dir).sort()) {
			const p = path.join(dir, name);
			if (fs.statSync(p).isDirectory()) walk(p);
			else h.update(name).update(fs.readFileSync(p));
		}
	};
	walk(path.join(PLUGIN_ROOT, "web"));
	h.update(fs.readFileSync(path.join(PLUGIN_ROOT, "cloudflare", "worker.js")));
	return h.digest("hex").slice(0, 16);
}

/** Redeploy when the plugin's dashboard files changed since the last deploy (keeps the link and secrets). */
export async function redeployIfStale(store: TrackerStore, log: (m: string) => void): Promise<void> {
	const cfg = store.config().cloudflare;
	if (!cfg.enabled || !cfg.name || !readSecrets(store) || cfg.assetsHash === assetsHash()) return;
	try {
		await deployCloudflare(store);
		log("tracker: Cloudflare copy redeployed with the updated dashboard");
	} catch (err) {
		log(`tracker: Cloudflare redeploy failed: ${err instanceof Error ? err.message : String(err)}`);
	}
}

/** New link key; the old link stops working as soon as the secret is updated. */
export async function rotateCloudflare(store: TrackerStore): Promise<CloudflareStatus> {
	const cfg = store.config();
	const secrets = readSecrets(store);
	if (!cfg.cloudflare.enabled || !cfg.cloudflare.name || !cfg.cloudflare.url || !secrets)
		throw new CloudflareError("Cloudflare sharing is not set up; run `share cloudflare` first.");
	const next = { ...secrets, key: newKey() };
	await putSecrets(store, writeWranglerConfig(store, cfg.cloudflare.name), { SHARE_KEY: next.key });
	writeSecrets(store, next);
	store.saveConfig(cfg); // touch config so the server re-reads secrets and pushes
	return { enabled: true, url: linkOf(cfg.cloudflare.url, next.key) };
}

/** Delete the Worker and its data; the link stops working. */
export async function removeCloudflare(store: TrackerStore): Promise<CloudflareStatus> {
	const cfg = store.config();
	if (cfg.cloudflare.name) {
		const configFile = writeWranglerConfig(store, cfg.cloudflare.name);
		// `wrangler delete` asks for confirmation; answer it on stdin.
		await wrangler(["delete", "--config", configFile, "--force"], cloudflareDir(store), "y\n");
	}
	cfg.cloudflare = { ...cfg.cloudflare, enabled: false, url: undefined };
	store.saveConfig(cfg);
	fs.rmSync(path.join(cloudflareDir(store), "secrets.json"), { force: true });
	return { enabled: false };
}

/** Pushes the public snapshot to the Worker: on change, at most every `minIntervalSeconds`, plus a heartbeat. */
export class CloudflarePusher {
	private lastBody = "";
	private lastPush = 0;
	private timer?: Timer;
	private pending?: () => string;
	status: CloudflareStatus = { enabled: false };

	constructor(
		private store: TrackerStore,
		private log: (m: string) => void,
		/** Called after each push attempt with the new status. */
		private onStatus: () => void = () => {},
	) {}

	/** Re-read config and secrets; returns whether pushing is enabled. */
	refresh(): boolean {
		const cfg = this.store.config().cloudflare;
		const secrets = readSecrets(this.store);
		if (!cfg.enabled || !cfg.url || !secrets) {
			this.status = { enabled: false };
			return false;
		}
		const url = linkOf(cfg.url, secrets.key);
		// A new link (rotation) starts without the old link's push history.
		this.status = this.status.url === url ? { ...this.status, enabled: true } : { enabled: true, url };
		return true;
	}

	/** Offer the latest public snapshot JSON (lazily serialized). */
	offer(body: () => string): void {
		if (!this.refresh()) return;
		this.pending = body;
		if (this.timer) return;
		const wait = Math.max(0, this.lastPush + this.store.config().cloudflare.minIntervalSeconds * 1000 - Date.now());
		this.timer = setTimeout(() => void this.flush(), wait);
	}

	stop(): void {
		clearTimeout(this.timer);
		this.timer = undefined;
	}

	private async flush(): Promise<void> {
		this.timer = undefined;
		const make = this.pending;
		this.pending = undefined;
		const cfg = this.store.config().cloudflare;
		const secrets = readSecrets(this.store);
		if (!make || !cfg.enabled || !cfg.url || !secrets) return;
		const body = make();
		// Skip unchanged content (ignoring the timestamp) unless the heartbeat is due.
		const comparable = body.replace(/"generated_at":"[^"]*"/, "");
		if (comparable === this.lastBody && Date.now() - this.lastPush < cfg.heartbeatSeconds * 1000) return;
		try {
			const res = await fetch(`${linkOf(cfg.url, secrets.key)}api/push`, {
				method: "POST",
				headers: { authorization: `Bearer ${secrets.token}`, "content-type": "application/json" },
				body,
				signal: AbortSignal.timeout(20_000),
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
			this.lastBody = comparable;
			this.lastPush = Date.now();
			this.status = { enabled: true, url: linkOf(cfg.url, secrets.key), lastPush: new Date(this.lastPush).toISOString() };
			this.onStatus();
		} catch (err) {
			this.lastPush = Date.now(); // back off for one interval before retrying
			this.status = { ...this.status, error: err instanceof Error ? err.message : String(err) };
			this.onStatus();
			this.log(`tracker: cloudflare push failed: ${this.status.error}`);
			this.pending ??= make;
			this.timer ??= setTimeout(() => void this.flush(), cfg.minIntervalSeconds * 1000);
		}
	}
}

export type CloudflareAction = "on" | "off" | "rotate" | "status";

/** One entry point for `/tracker share cloudflare …` and `omp-tracker share cloudflare …`. Returns a user-facing line. */
export async function cloudflareCommand(store: TrackerStore, action: CloudflareAction): Promise<{ text: string; ok: boolean }> {
	try {
		if (action === "status") {
			const cfg = store.config().cloudflare;
			const secrets = readSecrets(store);
			if (!cfg.enabled || !cfg.url || !secrets) return { text: "Cloudflare copy: off", ok: true };
			const live = store.readServer()?.cloudflare;
			const push = live?.lastPush ? `last push ${live.lastPush}` : "no push yet (needs a running tracker server)";
			return { text: `Cloudflare copy (always on, read-only): ${linkOf(cfg.url, secrets.key)}\n${push}${live?.error ? `\nlast error: ${live.error}` : ""}`, ok: true };
		}
		const status = action === "off" ? await removeCloudflare(store) : action === "rotate" ? await rotateCloudflare(store) : await deployCloudflare(store);
		if (!status.enabled) return { text: "Cloudflare copy deleted; its link no longer works.", ok: true };
		const serving = store.readServer() ? "The tracker server pushes updates every few seconds." : "Start the tracker server (/tracker or omp-tracker serve) to push data.";
		return { text: `Cloudflare copy (always on, read-only; anyone with the link can view): ${status.url}\n${serving}`, ok: true };
	} catch (err) {
		return { text: err instanceof Error ? err.message : String(err), ok: false };
	}
}
