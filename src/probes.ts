// Deterministic health checks: the tracker server runs each probe on its
// schedule, keeps the latest result in probes.json and posts a test event
// whenever a probe flips between pass and fail.
import * as net from "node:net";
import { newId, nowIso, type TrackerStore } from "./store";
import type { Probe, ProbeResult, TrackerEvent } from "./types";

const MAX_PARALLEL = 4;

function clip(s: string, n = 300): string {
	const one = s.replace(/\s+/g, " ").trim();
	return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

async function runHttp(p: Probe): Promise<{ ok: boolean; detail: string }> {
	const res = await fetch(p.target, { redirect: "follow", signal: AbortSignal.timeout(p.timeoutSeconds * 1000) });
	const body = p.expectText ? await res.text() : "";
	await res.body?.cancel().catch(() => undefined);
	const statusOk = p.expectStatus ? res.status === p.expectStatus : res.status < 400;
	if (!statusOk) return { ok: false, detail: `HTTP ${res.status}${p.expectStatus ? ` (expected ${p.expectStatus})` : ""}` };
	if (p.expectText && !body.includes(p.expectText)) return { ok: false, detail: `HTTP ${res.status}, body lacks "${p.expectText}"` };
	return { ok: true, detail: `HTTP ${res.status}` };
}

function runTcp(p: Probe): Promise<{ ok: boolean; detail: string }> {
	const i = p.target.lastIndexOf(":");
	const { promise, resolve } = Promise.withResolvers<{ ok: boolean; detail: string }>();
	const sock = net.connect({ host: p.target.slice(0, i), port: Number(p.target.slice(i + 1)) });
	const done = (ok: boolean, detail: string) => {
		sock.destroy();
		resolve({ ok, detail });
	};
	sock.setTimeout(p.timeoutSeconds * 1000, () => done(false, `timeout after ${p.timeoutSeconds}s`));
	sock.once("connect", () => done(true, `connected to ${p.target}`));
	sock.once("error", err => done(false, err.message));
	return promise;
}

async function runCmd(p: Probe, cwd: string): Promise<{ ok: boolean; detail: string }> {
	const proc = Bun.spawn(["sh", "-c", p.target], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
	const timer = setTimeout(() => proc.kill(), p.timeoutSeconds * 1000);
	const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
	clearTimeout(timer);
	const text = `${out}\n${err}`.trim();
	if (proc.signalCode) return { ok: false, detail: `timeout after ${p.timeoutSeconds}s` };
	if (code !== 0) return { ok: false, detail: clip(`exit ${code}${text ? `: ${text.split("\n").slice(-3).join(" ")}` : ""}`) };
	if (p.expectText && !text.includes(p.expectText)) return { ok: false, detail: clip(`output lacks "${p.expectText}"`) };
	return { ok: true, detail: clip(text.split("\n").pop() || "exit 0", 160) };
}

export async function runProbe(p: Probe, cwd: string): Promise<{ ok: boolean; detail: string; ms: number }> {
	const start = performance.now();
	let r: { ok: boolean; detail: string };
	try {
		r = p.kind === "http" ? await runHttp(p) : p.kind === "tcp" ? await runTcp(p) : await runCmd(p, cwd);
	} catch (err) {
		r = { ok: false, detail: clip(err instanceof Error ? err.message : String(err)) };
	}
	return { ...r, ms: Math.round(performance.now() - start) };
}

export class Prober {
	private busy = false;
	private nextAt = new Map<string, number>();

	constructor(
		private store: TrackerStore,
		private cwd: string,
		private onChange: () => void,
	) {}

	/** Run every due probe (up to MAX_PARALLEL at a time); called on a short tick. Overlapping ticks are skipped. */
	async tick(): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		try {
			await this.runDue();
		} finally {
			this.busy = false;
		}
	}

	private async runDue(): Promise<void> {
		const probes = this.store.readState().probes;
		const now = Date.now();
		const due = probes.filter(p => (this.nextAt.get(p.id) ?? 0) <= now).slice(0, MAX_PARALLEL);
		if (!due.length) return;
		for (const p of due) this.nextAt.set(p.id, now + p.everySeconds * 1000);
		const results = await Promise.all(due.map(async p => ({ p, r: await runProbe(p, this.cwd) })));
		const known = this.store.readProbeResults();
		const events: TrackerEvent[] = [];
		const t = nowIso();
		for (const { p, r } of results) {
			// Probe definitions can change while a run is in flight; record against the current id.
			const prev = known[p.id];
			const flipped = !prev || prev.ok !== r.ok;
			known[p.id] = { t, ok: r.ok, detail: r.detail, ms: r.ms, since: flipped ? t : prev.since };
			if (flipped)
				events.push({
					type: "test",
					id: newId(),
					t,
					node: p.node,
					name: p.name,
					result: r.ok ? "pass" : "fail",
					...(r.ok ? {} : { why: [r.detail], next: "Checked again automatically; resolves when the probe passes." }),
					lane: "probe",
					where: `${p.kind} ${p.kind === "cmd" ? "" : p.target}`.trim(),
					agent: "probe",
				});
		}
		// Drop results of probes that no longer exist.
		const ids = new Set(probes.map(p => p.id));
		for (const id of Object.keys(known)) if (!ids.has(id)) delete known[id];
		this.store.writeProbeResults(known);
		this.store.appendEvents(events);
		this.onChange();
	}
}
