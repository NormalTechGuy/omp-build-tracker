// Sharing the dashboard through Tailscale: `serve` (tailnet only) or `funnel`
// (public internet, anyone with the link). Funnel always targets a read-only,
// redacted listener; the unguessable path is the access key.
import { randomBytes } from "node:crypto";
import type { ShareConfig } from "./types";

export class ShareError extends Error {}

const OPERATOR_HINT = "Tailscale refused the change. Allow your user to manage serve/funnel once with:\n  sudo tailscale set --operator=$USER";

async function tailscale(args: string[]): Promise<string> {
	let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
	try {
		proc = Bun.spawn(["tailscale", ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
	} catch {
		throw new ShareError("The tailscale CLI is not installed or not on PATH.");
	}
	const timer = setTimeout(() => proc.kill(), 60_000);
	const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
	clearTimeout(timer);
	if (code !== 0) {
		const msg = `${err}\n${out}`.trim();
		if (/access denied|--operator/i.test(msg)) throw new ShareError(OPERATOR_HINT);
		throw new ShareError(`tailscale ${args.join(" ")} failed: ${msg || `exit ${code}`}`);
	}
	return out;
}

export interface TailnetSelf {
	dnsName: string;
	funnelPorts: number[];
}

export async function tailnetSelf(): Promise<TailnetSelf> {
	const raw = await tailscale(["status", "--json"]);
	// `tailscale status --json` schema: BackendState, Self.DNSName, Self.Capabilities.
	const status = JSON.parse(raw) as { BackendState?: string; Self?: { DNSName?: string; Capabilities?: string[] } };
	if (status.BackendState !== "Running" || !status.Self?.DNSName) throw new ShareError("Tailscale is not connected (run `tailscale up`).");
	const caps = status.Self.Capabilities ?? [];
	const portsCap = caps.find(c => c.includes("funnel-ports"));
	const ports = portsCap?.match(/ports=([\d,]+)/)?.[1]?.split(",").map(Number) ?? (caps.includes("funnel") ? [443, 8443, 10000] : []);
	return { dnsName: status.Self.DNSName.replace(/\.$/, ""), funnelPorts: ports };
}

/** A fresh unguessable mount path; whoever has the link can view. */
export function newSharePath(): string {
	return `/t-${randomBytes(12).toString("base64url")}`;
}

/** HTTPS port Tailscale listens on (443 unless configured; funnel also allows 8443 and 10000). */
export function shareHttpsPort(share: ShareConfig): number {
	return share.httpsPort ?? 443;
}

export function shareUrl(dnsName: string, share: ShareConfig): string {
	const port = shareHttpsPort(share);
	return `https://${dnsName}${port === 443 ? "" : `:${port}`}${share.path}/`;
}

interface ServeStatus {
	Web?: Record<string, { Handlers?: Record<string, unknown> }>;
	AllowFunnel?: Record<string, boolean>;
}

async function serveStatus(): Promise<ServeStatus> {
	const raw = await tailscale(["serve", "status", "--json"]).catch(() => "{}");
	// `tailscale serve status --json` schema: Web["host:port"].Handlers[path], AllowFunnel["host:port"].
	const parsed = JSON.parse(raw.trim() || "{}") as ServeStatus;
	return parsed;
}

/** Point Tailscale at `target` (http://127.0.0.1:PORT). Idempotent; rewrites the mapping when the port moved. */
export async function applyShare(share: ShareConfig, target: string): Promise<string> {
	if (share.mode === "off" || !share.path) throw new ShareError("sharing is off");
	const self = await tailnetSelf();
	const port = shareHttpsPort(share);
	if (share.mode === "funnel") {
		if (!self.funnelPorts.includes(port))
			throw new ShareError(
				self.funnelPorts.length
					? `Funnel is not allowed on port ${port}; allowed: ${self.funnelPorts.join(", ")}. Set share.httpsPort in .omp/tracker/config.json.`
					: "Funnel is not enabled for this node in the tailnet policy (nodeAttrs funnel).",
			);
		// Funnel is per port: turning it on would also publish anything else already served on that port.
		const st = await serveStatus();
		const key = `${self.dnsName}:${port}`;
		const others = Object.keys(st.Web?.[key]?.Handlers ?? {}).filter(p => p.replace(/\/$/, "") !== share.path);
		if (others.length && !st.AllowFunnel?.[key])
			throw new ShareError(
				`Port ${port} already serves ${others.join(", ")} to your tailnet only; funnel would make that public too. Set share.httpsPort to another funnel port (${self.funnelPorts.filter(p => p !== port).join(", ")}).`,
			);
	}
	await tailscale([share.mode === "funnel" ? "funnel" : "serve", "--bg", "--yes", `--https=${port}`, `--set-path=${share.path}`, target]);
	return shareUrl(self.dnsName, share);
}

export async function removeShare(share: ShareConfig): Promise<void> {
	if (!share.path) return;
	const port = shareHttpsPort(share);
	const self = await tailnetSelf();
	const key = `${self.dnsName}:${port}`;
	const before = await serveStatus();
	if (Object.keys(before.Web?.[key]?.Handlers ?? {}).some(p => p.replace(/\/$/, "") === share.path))
		await tailscale(["serve", `--https=${port}`, `--set-path=${share.path}`, "off"]);
	// Turn funnel off for the port once nothing else is served on it.
	const after = await serveStatus();
	if (after.AllowFunnel?.[key] && !Object.keys(after.Web?.[key]?.Handlers ?? {}).length)
		await tailscale(["funnel", `--https=${port}`, "off"]).catch(() => undefined);
}

const SECRET_PATTERNS: [RegExp, string][] = [
	[/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35})\b/g, "[redacted]"],
	[/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[redacted]"],
	[/\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{12,}/gi, "$1 [redacted]"],
	[/((?:api[_-]?key|access[_-]?key|secret|token|password|passwd|pwd)["']?\s*[=:]\s*["']?)[^\s"'&,;]{4,}/gi, "$1[redacted]"],
	[/(:\/\/)[^\s/:@]+:[^\s/@]+@/g, "$1[redacted]@"],
	[/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[redacted private key]"],
];

export function redactText(s: string): string {
	let out = s;
	for (const [re, rep] of SECRET_PATTERNS) out = out.replace(re, rep);
	return out;
}

/** Deep-copy a JSON value with secret-looking substrings replaced in every string. */
export function redactDeep<T>(value: T): T {
	if (typeof value === "string") return redactText(value) as T;
	if (Array.isArray(value)) return value.map(redactDeep) as T;
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v);
		return out as T;
	}
	return value;
}
