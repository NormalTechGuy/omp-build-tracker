// File-backed tracker store. Every process (omp sessions, subagents, the CLI,
// external agents) writes here; the dashboard server watches the directory.
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentRecord, HistoryPoint, ProbeResult, ServerInfo, TrackerConfig, TrackerEvent, TrackerState } from "./types";

export const TRACKER_SUBDIR = path.join(".omp", "tracker");
const EVENTS_ROTATE_BYTES = 16 * 1024 * 1024;

export function nowIso(): string {
	return new Date().toISOString();
}

export function newId(): string {
	return randomUUID().replace(/-/g, "").slice(0, 12);
}

/** Find the tracker directory for `cwd`: $OMP_TRACKER_DIR, else the nearest ancestor with .omp/tracker. */
export function findTrackerDir(cwd: string): string | undefined {
	const env = process.env.OMP_TRACKER_DIR;
	if (env) return fs.existsSync(path.join(env, "state.json")) ? path.resolve(env) : undefined;
	let dir = path.resolve(cwd);
	for (;;) {
		const candidate = path.join(dir, TRACKER_SUBDIR);
		if (fs.existsSync(path.join(candidate, "state.json"))) return candidate;
		const up = path.dirname(dir);
		if (up === dir) return undefined;
		dir = up;
	}
}

/** Project root that owns a tracker dir (…/<root>/.omp/tracker). */
export function projectRoot(dir: string): string {
	const parent = path.dirname(dir);
	return path.basename(parent) === ".omp" && path.basename(dir) === "tracker" ? path.dirname(parent) : parent;
}

export function emptyState(title: string): TrackerState {
	return {
		version: 1,
		title,
		labels: {},
		map: { now: { items: [], edges: [], edgeKinds: {} }, future: { items: [], edges: [], edgeKinds: {} } },
		nodes: {},
		areas: [],
		criticalPath: [],
		phases: [],
		estimates: [],
		ownerItems: [],
		facts: [],
		chunks: [],
		testNotes: {},
		probes: [],
		updated: nowIso(),
	};
}

export function defaultConfig(): TrackerConfig {
	return {
		forge: { type: "none" },
		refresh: { gitSeconds: 30, forgeSeconds: 120, historyMinutes: 5 },
		windows: { testsHours: 6, noResultHours: 3, blockersHours: 6, agentsHours: 48 },
		autostart: true,
		promptHint: true,
		share: { mode: "off" },
		cloudflare: { enabled: false, minIntervalSeconds: 5, heartbeatSeconds: 60 },
		curator: { enabled: false, model: "@smol", minMinutes: 10 },
		stopNudge: true,
		autoTests: true,
		autoAsks: true,
	};
}

function readJson<T>(file: string): T | undefined {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8")) as T;
	} catch {
		return undefined;
	}
}

function writeJsonAtomic(file: string, value: unknown): void {
	const tmp = `${file}.${process.pid}.${newId()}.tmp`;
	fs.writeFileSync(tmp, `${JSON.stringify(value, null, 1)}\n`);
	fs.renameSync(tmp, file);
}

function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export class TrackerStore {
	readonly dir: string;

	constructor(dir: string) {
		this.dir = dir;
	}

	static init(root: string, title: string, forge?: TrackerConfig["forge"]): TrackerStore {
		const dir = path.join(root, TRACKER_SUBDIR);
		fs.mkdirSync(path.join(dir, "agents"), { recursive: true });
		const store = new TrackerStore(dir);
		if (!fs.existsSync(store.statePath)) writeJsonAtomic(store.statePath, emptyState(title));
		if (!fs.existsSync(store.configPath)) {
			const cfg = defaultConfig();
			if (forge) cfg.forge = forge;
			writeJsonAtomic(store.configPath, cfg);
		}
		const ignore = path.join(dir, ".gitignore");
		if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, "agents/\nserver.json\ncloudflare/\n*.lock/\n*.tmp\n");
		return store;
	}

	get statePath(): string {
		return path.join(this.dir, "state.json");
	}
	get configPath(): string {
		return path.join(this.dir, "config.json");
	}
	get eventsPath(): string {
		return path.join(this.dir, "events.jsonl");
	}
	get historyPath(): string {
		return path.join(this.dir, "history.jsonl");
	}
	get agentsDir(): string {
		return path.join(this.dir, "agents");
	}
	get serverPath(): string {
		return path.join(this.dir, "server.json");
	}
	get probesPath(): string {
		return path.join(this.dir, "probes.json");
	}

	readProbeResults(): Record<string, ProbeResult> {
		return readJson<Record<string, ProbeResult>>(this.probesPath) ?? {};
	}

	writeProbeResults(results: Record<string, ProbeResult>): void {
		writeJsonAtomic(this.probesPath, results);
	}

	config(): TrackerConfig {
		const base = defaultConfig();
		const cfg = readJson<Partial<TrackerConfig>>(this.configPath) ?? {};
		return {
			...base,
			...cfg,
			forge: { ...base.forge, ...cfg.forge },
			refresh: { ...base.refresh, ...cfg.refresh },
			windows: { ...base.windows, ...cfg.windows },
			share: { ...base.share, ...cfg.share },
			cloudflare: { ...base.cloudflare, ...cfg.cloudflare },
			curator: { ...base.curator, ...cfg.curator },
		};
	}

	saveConfig(cfg: TrackerConfig): void {
		writeJsonAtomic(this.configPath, cfg);
	}

	readState(): TrackerState {
		const s = readJson<TrackerState>(this.statePath);
		if (!s) throw new Error(`Tracker state missing or unreadable: ${this.statePath}`);
		s.probes ??= []; // state files from before probes existed
		return s;
	}

	/** Run `fn` under a cross-process lock; the lock is a directory, removed when stale (>15 s). */
	withLock<T>(name: string, fn: () => T): T {
		const lock = path.join(this.dir, `${name}.lock`);
		const deadline = Date.now() + 10_000;
		for (;;) {
			try {
				fs.mkdirSync(lock);
				break;
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
				try {
					if (Date.now() - fs.statSync(lock).mtimeMs > 15_000) fs.rmSync(lock, { recursive: true, force: true });
				} catch {}
				if (Date.now() > deadline) throw new Error(`Timed out waiting for tracker lock ${lock}`);
				sleepSync(15);
			}
		}
		try {
			return fn();
		} finally {
			fs.rmSync(lock, { recursive: true, force: true });
		}
	}

	/** Read-modify-write state.json atomically. */
	mutateState<T>(fn: (state: TrackerState) => T): T {
		return this.withLock("state", () => {
			const state = this.readState();
			const out = fn(state);
			state.updated = nowIso();
			writeJsonAtomic(this.statePath, state);
			return out;
		});
	}

	appendEvents(events: TrackerEvent[]): void {
		if (!events.length) return;
		const body = events.map(e => JSON.stringify(e)).join("\n") + "\n";
		fs.appendFileSync(this.eventsPath, body);
	}

	readEvents(sinceMs?: number): TrackerEvent[] {
		let text: string;
		try {
			text = fs.readFileSync(this.eventsPath, "utf8");
		} catch {
			return [];
		}
		const out: TrackerEvent[] = [];
		for (const line of text.split("\n")) {
			if (!line) continue;
			try {
				const e = JSON.parse(line) as TrackerEvent;
				if (sinceMs === undefined || Date.parse(e.t) >= sinceMs) out.push(e);
			} catch {}
		}
		return out;
	}

	/** Rotate events.jsonl once it grows past 16 MiB, keeping the last 7 days in place. */
	rotateEventsIfLarge(): void {
		let size = 0;
		try {
			size = fs.statSync(this.eventsPath).size;
		} catch {
			return;
		}
		if (size < EVENTS_ROTATE_BYTES) return;
		this.withLock("events", () => {
			const keepFrom = Date.now() - 7 * 86_400_000;
			const all = this.readEvents();
			const archive = path.join(this.dir, `events.${new Date().toISOString().slice(0, 10)}.jsonl`);
			fs.renameSync(this.eventsPath, archive);
			this.appendEvents(all.filter(e => Date.parse(e.t) >= keepFrom));
		});
	}

	readAgents(): AgentRecord[] {
		let names: string[];
		try {
			names = fs.readdirSync(this.agentsDir);
		} catch {
			return [];
		}
		const out: AgentRecord[] = [];
		for (const name of names) {
			if (!name.endsWith(".json")) continue;
			const rec = readJson<AgentRecord>(path.join(this.agentsDir, name));
			if (rec?.id) out.push(rec);
		}
		return out;
	}

	readAgent(id: string): AgentRecord | undefined {
		return readJson<AgentRecord>(path.join(this.agentsDir, `${safeName(id)}.json`));
	}

	writeAgent(rec: AgentRecord): void {
		fs.mkdirSync(this.agentsDir, { recursive: true });
		writeJsonAtomic(path.join(this.agentsDir, `${safeName(rec.id)}.json`), rec);
	}

	/** Merge `patch` into an agent record, creating it if needed. */
	patchAgent(id: string, patch: Partial<AgentRecord>, create?: () => AgentRecord): AgentRecord | undefined {
		const cur = this.readAgent(id) ?? create?.();
		if (!cur) return undefined;
		const next: AgentRecord = { ...cur, ...stripUndefined(patch), id, updated: nowIso() };
		this.writeAgent(next);
		return next;
	}

	readHistory(): HistoryPoint[] {
		let text: string;
		try {
			text = fs.readFileSync(this.historyPath, "utf8");
		} catch {
			return [];
		}
		const out: HistoryPoint[] = [];
		for (const line of text.split("\n")) {
			if (!line) continue;
			try {
				out.push(JSON.parse(line) as HistoryPoint);
			} catch {}
		}
		return out;
	}

	appendHistory(p: HistoryPoint): void {
		fs.appendFileSync(this.historyPath, `${JSON.stringify(p)}\n`);
	}

	readServer(): ServerInfo | undefined {
		const s = readJson<ServerInfo>(this.serverPath);
		if (!s) return undefined;
		return pidAlive(s.pid) ? s : undefined;
	}
}

export function pidAlive(pid: number | undefined): boolean {
	if (!pid) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

function safeName(id: string): string {
	return id.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 120);
}

function stripUndefined<T extends object>(o: T): Partial<T> {
	const out: Partial<T> = {};
	for (const [k, v] of Object.entries(o)) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
	return out;
}
