// Tracker update operations: validation and application to state.
import { newId, nowIso, type TrackerStore } from "./store";
import {
	FUTURE_STATES,
	ISSUE_STATUSES,
	NODE_STATES,
	POST_KINDS,
	TEST_RESULTS,
	WORK_STATES,
	type EdgeKind,
	type Probe,
	type MapDef,
	type MapEdge,
	type MapItem,
	type TrackerEvent,
	type TrackerState,
} from "./types";

export const OP_TYPES = [
	"project",
	"map",
	"node",
	"test",
	"issue",
	"inventory",
	"area",
	"step",
	"phase",
	"estimate",
	"owner_item",
	"fact",
	"chunk",
	"post",
	"test_note",
	"agent",
	"probe",
] as const;
export type OpType = (typeof OP_TYPES)[number];

/** Loose op shape as received from the tool, CLI, or HTTP; validated in applyOp. */
export type Op = { type: OpType } & Record<string, unknown>;

export interface AgentPatch {
	kind?: string;
	focus?: string;
	name?: string;
	now?: string;
}

export interface ApplyResult {
	lines: string[];
	events: TrackerEvent[];
	agentPatch?: AgentPatch;
}

class OpError extends Error {}

function str(op: Op, key: string, required = false): string | undefined {
	const v = op[key];
	if (v === undefined || v === null || v === "") {
		if (required) throw new OpError(`${op.type}: "${key}" is required`);
		return undefined;
	}
	if (typeof v !== "string" && typeof v !== "number") throw new OpError(`${op.type}: "${key}" must be a string`);
	return String(v);
}

function num(op: Op, key: string): number | undefined {
	const v = op[key];
	if (v === undefined || v === null || v === "") return undefined;
	const n = typeof v === "number" ? v : Number(v);
	if (!Number.isFinite(n)) throw new OpError(`${op.type}: "${key}" must be a number`);
	return n;
}

function oneOf<T extends string>(op: Op, key: string, allowed: readonly T[], required = false): T | undefined {
	const v = str(op, key, required);
	if (v === undefined) return undefined;
	if (!(allowed as readonly string[]).includes(v))
		throw new OpError(`${op.type}: "${key}" must be one of ${allowed.join(", ")} (got "${v}")`);
	return v as T;
}

function isoDate(op: Op, key: string, required = false): string | undefined {
	const v = str(op, key, required);
	if (v === undefined) return undefined;
	if (Number.isNaN(Date.parse(v))) throw new OpError(`${op.type}: "${key}" must be an ISO date (YYYY-MM-DD) or datetime`);
	return v;
}

function strList(op: Op, key: string): string[] | undefined {
	const v = op[key];
	if (v === undefined || v === null) return undefined;
	if (typeof v === "string") return [v];
	if (!Array.isArray(v) || v.some(x => typeof x !== "string")) throw new OpError(`${op.type}: "${key}" must be a list of strings`);
	return v as string[];
}

export function slug(s: string): string {
	return (
		s
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-|-$/g, "")
			.slice(0, 48) || newId()
	);
}

/** Upsert into a list keyed by id, falling back to a case-insensitive name match. */
function upsert<T extends { id: string }>(
	list: T[],
	id: string | undefined,
	name: string | undefined,
	nameOf: (x: T) => string,
	make: (id: string) => T,
	remove: boolean,
): { item?: T; created: boolean; removed: boolean } {
	const lname = name?.toLowerCase();
	const idx = list.findIndex(x => (id !== undefined && x.id === id) || (lname !== undefined && nameOf(x).toLowerCase() === lname));
	if (remove) {
		if (idx < 0) throw new OpError(`nothing matches ${id ?? name}`);
		list.splice(idx, 1);
		return { removed: true, created: false };
	}
	if (idx >= 0) return { item: list[idx], created: false, removed: false };
	const item = make(id ?? slug(name ?? newId()));
	list.push(item);
	return { item, created: true, removed: false };
}

function assign<T extends object>(target: T, patch: Partial<T>): void {
	for (const [k, v] of Object.entries(patch)) if (v !== undefined) (target as Record<string, unknown>)[k] = v;
}

function knownNode(state: TrackerState, id: string, op: Op): void {
	const items = state.map.now.items;
	if (items.length && !items.some(i => i.id === id)) {
		const known = items.map(i => i.id).join(", ");
		throw new OpError(`${op.type}: unknown map node "${id}". Known ids: ${known}`);
	}
}

function parseItems(raw: unknown, view: "now" | "future"): MapItem[] {
	if (!Array.isArray(raw)) throw new OpError(`map: "items" must be a list`);
	return raw.map((r, i) => {
		const o = r as Record<string, unknown>;
		if (!o || typeof o.id !== "string" || !o.id) throw new OpError(`map: items[${i}] needs a string "id"`);
		const item: MapItem = { id: o.id, label: typeof o.label === "string" && o.label ? o.label : o.id };
		for (const k of ["parent", "sub", "full", "ref", "desc", "now"] as const)
			if (typeof o[k] === "string" && o[k]) item[k] = o[k] as string;
		if (o.flow === "row" || o.flow === "column") item.flow = o.flow;
		if (o.break === true) item.break = true;
		if (o.wide === true) item.wide = true;
		if (o.state !== undefined) {
			if (view !== "future") throw new OpError(`map: items[${i}].state is only for the future view; use a "node" op for now-map state`);
			if (!(FUTURE_STATES as readonly unknown[]).includes(o.state))
				throw new OpError(`map: items[${i}].state must be one of ${FUTURE_STATES.join(", ")}`);
			item.state = o.state as MapItem["state"];
		}
		return item;
	});
}

function parseEdges(raw: unknown): MapEdge[] {
	if (!Array.isArray(raw)) throw new OpError(`map: "edges" must be a list`);
	return raw.map((r, i) => {
		const o = r as Record<string, unknown>;
		if (!o || typeof o.from !== "string" || typeof o.to !== "string") throw new OpError(`map: edges[${i}] needs "from" and "to"`);
		const e: MapEdge = { from: o.from, to: o.to };
		if (typeof o.kind === "string" && o.kind) e.kind = o.kind;
		if (typeof o.label === "string" && o.label) e.label = o.label;
		if (o.both === true) e.both = true;
		return e;
	});
}

function checkMap(def: MapDef): void {
	const ids = new Set<string>();
	for (const it of def.items) {
		if (ids.has(it.id)) throw new OpError(`map: duplicate item id "${it.id}"`);
		ids.add(it.id);
	}
	for (const it of def.items) {
		if (it.parent && !ids.has(it.parent)) throw new OpError(`map: item "${it.id}" names unknown parent "${it.parent}"`);
		const seen = new Set<string>([it.id]);
		let p = it.parent;
		while (p) {
			if (seen.has(p)) throw new OpError(`map: parent cycle through "${p}"`);
			seen.add(p);
			p = def.items.find(x => x.id === p)?.parent;
		}
	}
	for (const e of def.edges)
		for (const end of [e.from, e.to]) if (!ids.has(end)) throw new OpError(`map: edge ${e.from} → ${e.to} names unknown item "${end}"`);
}

export function applyOp(state: TrackerState, op: Op, agent: string | undefined): ApplyResult {
	const t = nowIso();
	const remove = op.remove === true;
	const lines: string[] = [];
	const events: TrackerEvent[] = [];
	const note = (summary: string) => {
		lines.push(summary);
		events.push({ type: "op", id: newId(), t, summary, agent });
	};
	switch (op.type) {
		case "project": {
			const title = str(op, "title");
			if (title) state.title = title;
			const headline = str(op, "headline");
			// null or "auto" hands the headline back to the server, which composes it from the data.
			if (op.headline === null || headline === "auto") delete state.headline;
			else if (headline !== undefined) state.headline = headline;
			if (op.overall_pct === null) delete state.overallPct;
			else {
				const pct = num(op, "overall_pct");
				if (pct !== undefined) state.overallPct = Math.max(0, Math.min(100, Math.round(pct)));
			}
			assign(state, { overallMethod: str(op, "overall_method"), rules: str(op, "rules"), footer: str(op, "footer") });
			assign(state.labels, {
				subtitle: str(op, "subtitle"),
				infra: str(op, "infra_label"),
				facts: str(op, "facts_label"),
				rules: str(op, "rules_label"),
			});
			note(`project updated${headline ? `: ${headline}` : ""}`);
			break;
		}
		case "map": {
			const view = oneOf(op, "view", ["now", "future"] as const) ?? "now";
			const def = state.map[view];
			if (op.replace === true) {
				def.items = [];
				def.edges = [];
				def.edgeKinds = {};
			}
			for (const id of strList(op, "remove_items") ?? []) {
				def.items = def.items.filter(i => i.id !== id);
				def.edges = def.edges.filter(e => e.from !== id && e.to !== id);
				for (const i of def.items) if (i.parent === id) delete i.parent;
			}
			if (op.remove_edges !== undefined) {
				for (const e of parseEdges(op.remove_edges)) def.edges = def.edges.filter(x => !(x.from === e.from && x.to === e.to));
			}
			if (op.items !== undefined) {
				for (const it of parseItems(op.items, view)) {
					const idx = def.items.findIndex(x => x.id === it.id);
					if (idx >= 0) def.items[idx] = it;
					else def.items.push(it);
				}
			}
			if (op.edges !== undefined) {
				for (const e of parseEdges(op.edges)) {
					const idx = def.edges.findIndex(x => x.from === e.from && x.to === e.to);
					if (idx >= 0) def.edges[idx] = e;
					else def.edges.push(e);
				}
			}
			if (op.edge_kinds !== undefined) {
				const kinds = op.edge_kinds as Record<string, EdgeKind>;
				if (!kinds || typeof kinds !== "object") throw new OpError(`map: "edge_kinds" must be an object`);
				for (const [k, v] of Object.entries(kinds)) {
					if (!v || typeof v.color !== "string") throw new OpError(`map: edge_kinds.${k} needs a "color"`);
					def.edgeKinds[k] = { color: v.color, style: v.style ?? "solid", label: v.label };
				}
			}
			checkMap(def);
			note(`${view} map: ${def.items.length} items, ${def.edges.length} edges`);
			break;
		}
		case "node": {
			const id = str(op, "id", true)!;
			knownNode(state, id, op);
			const st = oneOf(op, "state", NODE_STATES);
			const cur = state.nodes[id] ?? { state: "planned", issues: [], updated: t };
			if (st) cur.state = st;
			const n = str(op, "note");
			if (n !== undefined) cur.note = n;
			const ci = str(op, "ci");
			const label = str(op, "label");
			if (ci !== undefined || label !== undefined) {
				cur.bind = { ...cur.bind, ...(ci !== undefined ? { ci } : {}), ...(label !== undefined ? { label } : {}) };
				// "-" clears a binding.
				if (cur.bind.ci === "-") delete cur.bind.ci;
				if (cur.bind.label === "-") delete cur.bind.label;
			}
			cur.updated = t;
			state.nodes[id] = cur;
			const binds = cur.bind ? Object.entries(cur.bind).map(([k, v]) => `${k}=${v}`).join(", ") : "";
			note(`${id} → ${cur.state}${n ? `: ${n}` : ""}${binds ? ` [bound: ${binds}]` : ""}`);
			break;
		}
		case "test": {
			const node = str(op, "node");
			if (node) knownNode(state, node, op);
			const name = str(op, "name", true)!;
			const result = oneOf(op, "result", TEST_RESULTS, true)!;
			const why = strList(op, "why");
			const ev: TrackerEvent = {
				type: "test",
				id: newId(),
				t,
				node: node ?? "",
				name,
				result,
				...(why ? { why } : {}),
				...(str(op, "next") ? { next: str(op, "next") } : {}),
				...(str(op, "lane") ? { lane: str(op, "lane") } : {}),
				...(str(op, "where") ? { where: str(op, "where") } : {}),
				agent,
			};
			events.push(ev);
			lines.push(`test ${name} [${node ?? "-"}] ${result} (id ${ev.id})`);
			break;
		}
		case "issue": {
			const node = str(op, "node", true)!;
			knownNode(state, node, op);
			const cur = state.nodes[node] ?? { state: "planned", issues: [], updated: t };
			state.nodes[node] = cur;
			const what = str(op, "what");
			const r = upsert(
				cur.issues,
				str(op, "id"),
				what,
				x => x.what,
				id => {
					if (!what) throw new OpError(`issue: "what" is required for a new issue`);
					return { id, what, status: "open" as const, when: t, updated: t };
				},
				remove,
			);
			if (r.item) {
				assign(r.item, {
					what,
					fix: str(op, "fix"),
					status: oneOf(op, "status", ISSUE_STATUSES),
					lane: str(op, "lane"),
					updated: t,
				});
				note(`issue on ${node}: ${r.item.what} [${r.item.status}] (id ${r.item.id})`);
			} else note(`issue removed from ${node}`);
			break;
		}
		case "inventory": {
			const node = str(op, "node", true)!;
			knownNode(state, node, op);
			const raw = op.items;
			if (!Array.isArray(raw)) throw new OpError(`inventory: "items" must be a list`);
			const items = raw.map((r, i) => {
				const o = r as Record<string, unknown>;
				if (!o || typeof o.what !== "string") throw new OpError(`inventory: items[${i}] needs "what"`);
				return {
					what: o.what,
					...(typeof o.detail === "string" ? { detail: o.detail } : {}),
					...(typeof o.state === "string" ? { state: o.state } : {}),
				};
			});
			const cur = state.nodes[node] ?? { state: "planned", issues: [], updated: t };
			cur.inventory = { asof: t, summary: str(op, "summary"), items, source: str(op, "source") };
			state.nodes[node] = cur;
			note(`inventory for ${node}: ${items.length} items`);
			break;
		}
		case "area": {
			const name = str(op, "name");
			const r = upsert(
				state.areas,
				str(op, "id"),
				name,
				x => x.name,
				id => ({ id, name: name ?? id, pct: 0, state: "building" as const }),
				remove,
			);
			if (r.item) {
				const pct = num(op, "pct");
				assign(r.item, {
					name,
					pct: pct === undefined ? undefined : Math.max(0, Math.min(100, Math.round(pct))),
					state: oneOf(op, "state", WORK_STATES),
					note: str(op, "note"),
					weight: num(op, "weight"),
					milestone: str(op, "milestone"),
					map: str(op, "map"),
				});
				note(`area ${r.item.name}: ${r.item.pct}% ${r.item.state}`);
			} else note(`area removed`);
			break;
		}
		case "step": {
			const text = str(op, "step");
			const r = upsert(
				state.criticalPath,
				str(op, "id"),
				text,
				x => x.step,
				id => ({ id, step: text ?? id, state: "queued" as const }),
				remove,
			);
			if (r.item) {
				assign(r.item, {
					step: text,
					state: oneOf(op, "state", WORK_STATES),
					eta: str(op, "eta"),
					owner: str(op, "owner"),
					note: str(op, "note"),
				});
				const pos = num(op, "position");
				if (pos !== undefined) {
					const list = state.criticalPath;
					list.splice(list.indexOf(r.item), 1);
					list.splice(Math.max(0, Math.min(list.length, Math.round(pos))), 0, r.item);
				}
				note(`step ${r.item.step}: ${r.item.state}`);
			} else note(`step removed`);
			break;
		}
		case "phase": {
			const phase = str(op, "phase");
			const r = upsert(
				state.phases,
				str(op, "id"),
				phase,
				x => x.phase,
				id => ({ id, phase: phase ?? id, start: isoDate(op, "start", true)!, end: isoDate(op, "end", true)!, items: [] }),
				remove,
			);
			if (r.item) {
				assign(r.item, { phase, start: isoDate(op, "start"), end: isoDate(op, "end"), items: strList(op, "items") });
				note(`phase done: ${r.item.phase}`);
			} else note(`phase removed`);
			break;
		}
		case "estimate": {
			const label = str(op, "label");
			const r = upsert(
				state.estimates,
				str(op, "id"),
				label,
				x => x.label,
				id => ({ id, label: label ?? id, when: str(op, "when") ?? "" }),
				remove,
			);
			if (r.item) {
				assign(r.item, { label, when: str(op, "when"), start: isoDate(op, "start"), end: isoDate(op, "end") });
				note(`estimate ${r.item.label}: ${r.item.when}`);
			} else note(`estimate removed`);
			break;
		}
		case "owner_item": {
			const text = str(op, "text");
			const r = upsert(
				state.ownerItems,
				str(op, "id"),
				text,
				x => x.text,
				id => ({ id, key: str(op, "key") ?? "-", text: text ?? id }),
				remove,
			);
			if (r.item) {
				assign(r.item, { key: str(op, "key"), text });
				note(`waiting on owner: ${r.item.key} — ${r.item.text} (id ${r.item.id})`);
			} else note(`owner item resolved`);
			break;
		}
		case "fact": {
			const key = str(op, "key", true)!;
			const idx = state.facts.findIndex(f => f.key.toLowerCase() === key.toLowerCase());
			if (remove) {
				if (idx >= 0) state.facts.splice(idx, 1);
				note(`fact removed: ${key}`);
				break;
			}
			const value = str(op, "value", true)!;
			if (idx >= 0) state.facts[idx] = { key, value };
			else state.facts.push({ key, value });
			note(`fact ${key}: ${value}`);
			break;
		}
		case "chunk": {
			const title = str(op, "title");
			const r = upsert(
				state.chunks,
				str(op, "id"),
				title,
				x => x.title,
				id => ({ id, title: title ?? id, open: 0, closed: 0 }),
				remove,
			);
			if (r.item) {
				assign(r.item, { title, open: num(op, "open"), closed: num(op, "closed") });
				note(`chunk ${r.item.title}: ${r.item.closed} closed, ${r.item.open} open`);
			} else note(`chunk removed`);
			break;
		}
		case "probe": {
			const node = str(op, "node", true)!;
			knownNode(state, node, op);
			const name = str(op, "name", true)!;
			const idx = state.probes.findIndex(p => p.node === node && p.name.toLowerCase() === name.toLowerCase());
			if (remove) {
				if (idx < 0) throw new OpError(`probe: no probe "${name}" on ${node}`);
				state.probes.splice(idx, 1);
				note(`probe removed: ${name} on ${node}`);
				break;
			}
			const targets = (["http", "tcp", "cmd"] as const).filter(k => str(op, k) !== undefined);
			const prev = idx >= 0 ? state.probes[idx] : undefined;
			if (targets.length > 1) throw new OpError(`probe: give exactly one of http, tcp, cmd`);
			if (!targets.length && !prev) throw new OpError(`probe: one of http (URL), tcp (host:port) or cmd (shell command) is required`);
			const kind = targets[0] ?? prev!.kind;
			const target = targets[0] ? str(op, targets[0])! : prev!.target;
			if (kind === "http" && !/^https?:\/\//.test(target)) throw new OpError(`probe: http needs an http(s):// URL`);
			if (kind === "tcp" && !/^[^\s:]+:\d+$/.test(target)) throw new OpError(`probe: tcp needs host:port`);
			const every = num(op, "every_s") ?? prev?.everySeconds ?? 60;
			const timeout = num(op, "timeout_s") ?? prev?.timeoutSeconds ?? 10;
			const probe: Probe = {
				id: prev?.id ?? `${slug(node)}-${slug(name)}`,
				node,
				name,
				kind,
				target,
				...(num(op, "expect_status") ?? prev?.expectStatus ? { expectStatus: num(op, "expect_status") ?? prev?.expectStatus } : {}),
				...(str(op, "expect_text") ?? prev?.expectText ? { expectText: str(op, "expect_text") ?? prev?.expectText } : {}),
				everySeconds: Math.max(10, Math.round(every)),
				timeoutSeconds: Math.max(1, Math.min(120, Math.round(timeout))),
				drivesState: typeof op.drives_state === "boolean" ? op.drives_state : (prev?.drivesState ?? true),
			};
			if (idx >= 0) state.probes[idx] = probe;
			else state.probes.push(probe);
			note(`probe ${name} on ${node}: ${kind} ${target} every ${probe.everySeconds}s${probe.drivesState ? ", drives box state" : ""}`);
			break;
		}
		case "post": {
			const kind = oneOf(op, "kind", POST_KINDS, true)!;
			const text = str(op, "text", true)!;
			events.push({ type: "post", id: newId(), t, kind, text, agent });
			lines.push(`${kind} posted`);
			break;
		}
		case "test_note": {
			const id = str(op, "test_id", true)!;
			state.testNotes[id] = { ...state.testNotes[id], ...(str(op, "why") ? { why: str(op, "why") } : {}), ...(str(op, "next") ? { next: str(op, "next") } : {}) };
			note(`note on test ${id}`);
			break;
		}
		case "agent": {
			const patch: AgentPatch = { kind: str(op, "kind"), focus: str(op, "focus"), name: str(op, "name"), now: str(op, "now") };
			lines.push(`agent profile updated`);
			return { lines, events, agentPatch: patch };
		}
		default:
			throw new OpError(`unknown op type "${String(op.type)}"; expected one of ${OP_TYPES.join(", ")}`);
	}
	return { lines, events };
}

export interface ApplyOutcome {
	lines: string[];
	errors: string[];
	agentPatch?: AgentPatch;
}

/**
 * Apply ops in order under the state lock. Each op is atomic; a failing op is
 * reported and skipped, the rest still apply.
 */
export function applyOps(store: TrackerStore, ops: Op[], agent: string | undefined): ApplyOutcome {
	const lines: string[] = [];
	const errors: string[] = [];
	const events: TrackerEvent[] = [];
	let agentPatch: AgentPatch | undefined;
	store.mutateState(state => {
		ops.forEach((op, i) => {
			const snapshot = structuredClone(state);
			try {
				const r = applyOp(state, op, agent);
				lines.push(...r.lines);
				events.push(...r.events);
				if (r.agentPatch) agentPatch = { ...agentPatch, ...r.agentPatch };
			} catch (err) {
				Object.assign(state, snapshot);
				for (const k of Object.keys(state)) if (!(k in snapshot)) delete (state as unknown as Record<string, unknown>)[k];
				if (!(err instanceof OpError)) throw err;
				errors.push(`ops[${i}] ${err.message}`);
			}
		});
	});
	store.appendEvents(events);
	return { lines, errors, agentPatch };
}
