// Custom tabs: run-specific views the agents design (a leaderboard, a results
// matrix, a migration checklist, an experiment log). A tab is a list of typed
// blocks; the dashboard renders each kind. Validation keeps the payload small
// and the rendering predictable.
import { BLOCK_KINDS, COLUMN_KINDS, type CustomTab, type TabBlock, type TabColumn, type TabItem, type TabSeries, type TrackerState } from "./types";

export class TabError extends Error {}

const LIMITS = { tabs: 12, blocks: 24, rows: 500, columns: 24, items: 60, series: 12, points: 400, text: 8000, cell: 400 };
const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

type Raw = Record<string, unknown>;

const isObj = (v: unknown): v is Raw => !!v && typeof v === "object" && !Array.isArray(v);
const optStr = (o: Raw, k: string, max = 300): string | undefined => {
	const v = o[k];
	if (v === undefined || v === null || v === "") return undefined;
	if (typeof v !== "string" && typeof v !== "number") throw new TabError(`"${k}" must be a string`);
	return String(v).slice(0, max);
};

function cell(v: unknown): unknown {
	if (v === null || typeof v === "number" || typeof v === "boolean") return v;
	if (typeof v === "string") return v.slice(0, LIMITS.cell);
	throw new TabError("table cells must be strings, numbers, booleans or null");
}

function parseRow(r: unknown, i: number): Record<string, unknown> {
	if (!isObj(r)) throw new TabError(`rows[${i}] must be an object of column key → value`);
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(r)) out[k.slice(0, 40)] = cell(v);
	return out;
}

function parseColumns(raw: unknown): TabColumn[] {
	if (!Array.isArray(raw) || !raw.length) throw new TabError(`table needs "columns" (a non-empty list)`);
	if (raw.length > LIMITS.columns) throw new TabError(`at most ${LIMITS.columns} columns`);
	return raw.map((c, i) => {
		if (typeof c === "string") return { key: c };
		if (!isObj(c) || typeof c.key !== "string" || !c.key) throw new TabError(`columns[${i}] needs a "key"`);
		const kind = c.kind ?? "text";
		if (!(COLUMN_KINDS as readonly unknown[]).includes(kind)) throw new TabError(`columns[${i}].kind must be one of ${COLUMN_KINDS.join(", ")}`);
		return {
			key: c.key.slice(0, 40),
			...(optStr(c, "label", 60) ? { label: optStr(c, "label", 60) } : {}),
			kind: kind as TabColumn["kind"],
			...(typeof c.digits === "number" ? { digits: Math.max(0, Math.min(6, Math.round(c.digits))) } : {}),
			...(c.lower_better === true || c.lowerBetter === true ? { lowerBetter: true } : {}),
		};
	});
}

function parseItems(raw: unknown): TabItem[] {
	if (!Array.isArray(raw)) throw new TabError(`"items" must be a list`);
	if (raw.length > LIMITS.items) throw new TabError(`at most ${LIMITS.items} items`);
	return raw.map((it, i) => {
		if (typeof it === "string") return { text: it.slice(0, LIMITS.cell) };
		if (!isObj(it)) throw new TabError(`items[${i}] must be an object or a string`);
		const v = it.value;
		return {
			...(optStr(it, "label", 80) ? { label: optStr(it, "label", 80) } : {}),
			...(typeof v === "number" || typeof v === "string" ? { value: typeof v === "string" ? v.slice(0, 120) : v } : {}),
			...(optStr(it, "sub", 200) ? { sub: optStr(it, "sub", 200) } : {}),
			...(optStr(it, "text", LIMITS.cell) ? { text: optStr(it, "text", LIMITS.cell) } : {}),
			...(optStr(it, "state", 20) ? { state: optStr(it, "state", 20) } : {}),
		};
	});
}

function parseSeries(raw: unknown): TabSeries[] {
	if (!Array.isArray(raw) || !raw.length) throw new TabError(`chart needs "series"`);
	if (raw.length > LIMITS.series) throw new TabError(`at most ${LIMITS.series} series`);
	return raw.map((s, i) => {
		if (!isObj(s) || typeof s.name !== "string" || !Array.isArray(s.values)) throw new TabError(`series[${i}] needs "name" and "values"`);
		if (s.values.length > LIMITS.points) throw new TabError(`at most ${LIMITS.points} points per series`);
		return {
			name: s.name.slice(0, 60),
			values: s.values.map(v => (typeof v === "number" && Number.isFinite(v) ? v : null)),
			...(optStr(s, "color", 20) ? { color: optStr(s, "color", 20) } : {}),
		};
	});
}

/** Build a block from raw input, merging over `prev` (fields not given keep their value). */
export function parseBlock(raw: unknown, prev: TabBlock | undefined, fallbackId: string, t: string): TabBlock {
	if (!isObj(raw)) throw new TabError("each block must be an object");
	const id = optStr(raw, "id", 40) ?? prev?.id ?? fallbackId;
	if (!ID.test(id)) throw new TabError(`block id "${id}" must be lowercase letters, digits and dashes`);
	const kind = (raw.kind ?? prev?.kind) as TabBlock["kind"] | undefined;
	if (!kind || !(BLOCK_KINDS as readonly unknown[]).includes(kind)) throw new TabError(`block "${id}": "kind" must be one of ${BLOCK_KINDS.join(", ")}`);
	const b: TabBlock = { ...(prev && prev.kind === kind ? prev : {}), id, kind, updated: t } as TabBlock;
	for (const k of ["title", "note"] as const) if (raw[k] !== undefined) b[k] = optStr(raw, k, k === "note" ? 600 : 120);
	for (const k of ["pin", "half", "rank"] as const) if (typeof raw[k] === "boolean") b[k] = raw[k] as boolean;
	if (kind === "table") {
		if (raw.columns !== undefined) b.columns = parseColumns(raw.columns);
		if (!b.columns) throw new TabError(`table "${id}" needs "columns"`);
		if (raw.rows !== undefined) {
			if (!Array.isArray(raw.rows)) throw new TabError(`table "${id}": "rows" must be a list`);
			if (raw.rows.length > LIMITS.rows) throw new TabError(`at most ${LIMITS.rows} rows`);
			b.rows = raw.rows.map(parseRow);
		}
		b.rows ??= [];
		const rowKey = optStr(raw, "row_key", 40) ?? optStr(raw, "rowKey", 40);
		if (rowKey) b.rowKey = rowKey;
		const sort = optStr(raw, "sort", 40);
		if (sort) b.sort = sort;
		const dir = raw.sort_dir ?? raw.sortDir;
		if (dir === "asc" || dir === "desc") b.sortDir = dir;
	}
	if (kind === "stats" || kind === "kv" || kind === "list") {
		if (raw.items !== undefined) b.items = parseItems(raw.items);
		b.items ??= [];
	}
	if (kind === "text") {
		if (raw.text !== undefined) b.text = optStr(raw, "text", LIMITS.text) ?? "";
		b.text ??= "";
	}
	if (kind === "chart") {
		const chart = raw.chart ?? b.chart ?? "bar";
		if (chart !== "bar" && chart !== "line" && chart !== "hbar") throw new TabError(`chart "${id}": "chart" must be bar, line or hbar`);
		b.chart = chart;
		if (raw.labels !== undefined) {
			if (!Array.isArray(raw.labels)) throw new TabError(`chart "${id}": "labels" must be a list`);
			b.labels = raw.labels.slice(0, LIMITS.points).map(String);
		}
		if (raw.series !== undefined) b.series = parseSeries(raw.series);
		if (!b.labels || !b.series) throw new TabError(`chart "${id}" needs "labels" and "series"`);
	}
	return b;
}

function findTab(state: TrackerState, id: string | undefined): CustomTab {
	const tab = state.tabs.find(x => x.id === id);
	if (!tab) throw new TabError(`no tab "${id}". Tabs: ${state.tabs.map(x => x.id).join(", ") || "(none)"}`);
	return tab;
}

/** `tab` op: create, update (title/note/public/order, replace blocks) or remove a tab. */
export function applyTab(state: TrackerState, op: Raw, t: string): string {
	const id = optStr(op, "id", 40);
	if (!id || !ID.test(id)) throw new TabError(`tab: "id" is required (lowercase letters, digits, dashes), e.g. "leaderboard"`);
	const idx = state.tabs.findIndex(x => x.id === id);
	if (op.remove === true) {
		if (idx < 0) throw new TabError(`tab: no tab "${id}"`);
		state.tabs.splice(idx, 1);
		return `tab ${id} removed`;
	}
	const prev = idx >= 0 ? state.tabs[idx] : undefined;
	if (!prev && state.tabs.length >= LIMITS.tabs) throw new TabError(`at most ${LIMITS.tabs} custom tabs`);
	const title = optStr(op, "title", 40) ?? prev?.title;
	if (!title) throw new TabError(`tab: "title" is required for a new tab`);
	const tab: CustomTab = {
		id,
		title,
		...(prev?.note ? { note: prev.note } : {}),
		public: typeof op.public === "boolean" ? op.public : (prev?.public ?? true),
		order: typeof op.order === "number" ? op.order : (prev?.order ?? (state.tabs.length ? Math.max(...state.tabs.map(x => x.order)) + 1 : 0)),
		blocks: prev?.blocks ?? [],
		updated: t,
	};
	if (op.note !== undefined) {
		const note = optStr(op, "note", 300);
		if (note) tab.note = note;
		else delete tab.note;
	}
	if (op.blocks !== undefined) {
		if (!Array.isArray(op.blocks)) throw new TabError(`tab: "blocks" must be a list`);
		if (op.blocks.length > LIMITS.blocks) throw new TabError(`at most ${LIMITS.blocks} blocks per tab`);
		const blocks = op.blocks.map((b, i) => parseBlock(b, undefined, `b${i + 1}`, t));
		const seen = new Set<string>();
		for (const b of blocks) {
			if (seen.has(b.id)) throw new TabError(`tab "${id}": duplicate block id "${b.id}"`);
			seen.add(b.id);
		}
		tab.blocks = blocks;
	}
	if (idx >= 0) state.tabs[idx] = tab;
	else state.tabs.push(tab);
	return `tab ${id} "${tab.title}": ${tab.blocks.length} block(s) [${tab.blocks.map(b => `${b.id}:${b.kind}`).join(", ")}]`;
}

/** `tab_block` op: add, update (merge) or remove one block. */
export function applyTabBlock(state: TrackerState, op: Raw, t: string): string {
	const tab = findTab(state, optStr(op, "tab", 40));
	const block = isObj(op.block) ? op.block : op;
	const id = optStr(block, "id", 40);
	if (!id) throw new TabError(`tab_block: block "id" is required`);
	const idx = tab.blocks.findIndex(b => b.id === id);
	if (op.remove === true) {
		if (idx < 0) throw new TabError(`tab_block: no block "${id}" in tab ${tab.id}`);
		tab.blocks.splice(idx, 1);
		tab.updated = t;
		return `block ${tab.id}/${id} removed`;
	}
	if (idx < 0 && tab.blocks.length >= LIMITS.blocks) throw new TabError(`at most ${LIMITS.blocks} blocks per tab`);
	const b = parseBlock(block, idx >= 0 ? tab.blocks[idx] : undefined, id, t);
	if (idx >= 0) tab.blocks[idx] = b;
	else if (typeof op.position === "number") tab.blocks.splice(Math.max(0, Math.min(tab.blocks.length, Math.round(op.position))), 0, b);
	else tab.blocks.push(b);
	tab.updated = t;
	return `block ${tab.id}/${b.id} (${b.kind}) ${idx >= 0 ? "updated" : "added"}`;
}

/** `tab_rows` op: upsert table rows by the block's row key; remove rows by key. */
export function applyTabRows(state: TrackerState, op: Raw, t: string): string {
	const tab = findTab(state, optStr(op, "tab", 40));
	const bid = optStr(op, "block", 40);
	const b = tab.blocks.find(x => x.id === bid);
	if (!b) throw new TabError(`tab_rows: no block "${bid}" in tab ${tab.id}. Blocks: ${tab.blocks.map(x => x.id).join(", ")}`);
	if (b.kind !== "table") throw new TabError(`tab_rows: block ${b.id} is a ${b.kind}, not a table`);
	const key = b.rowKey ?? b.columns![0].key;
	const rows = b.rows ?? [];
	let added = 0;
	let updated = 0;
	let removed = 0;
	if (op.rows !== undefined) {
		if (!Array.isArray(op.rows)) throw new TabError(`tab_rows: "rows" must be a list`);
		for (const [i, r] of op.rows.entries()) {
			const row = parseRow(r, i);
			if (row[key] === undefined || row[key] === null || row[key] === "") throw new TabError(`tab_rows: rows[${i}] needs the row key "${key}"`);
			const j = rows.findIndex(x => String(x[key]) === String(row[key]));
			if (j >= 0) {
				// Merge so one column can be updated without restating the row.
				rows[j] = { ...rows[j], ...row };
				updated++;
			} else {
				rows.push(row);
				added++;
			}
		}
	}
	if (op.remove_keys !== undefined) {
		if (!Array.isArray(op.remove_keys)) throw new TabError(`tab_rows: "remove_keys" must be a list`);
		const drop = new Set(op.remove_keys.map(String));
		const before = rows.length;
		b.rows = rows.filter(x => !drop.has(String(x[key])));
		removed = before - b.rows.length;
	} else b.rows = rows;
	if (b.rows.length > LIMITS.rows) throw new TabError(`at most ${LIMITS.rows} rows`);
	b.updated = t;
	tab.updated = t;
	return `rows ${tab.id}/${b.id}: ${added} added, ${updated} updated, ${removed} removed (key "${key}")`;
}
