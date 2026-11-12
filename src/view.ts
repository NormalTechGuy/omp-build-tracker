// Compact text rendering of a snapshot for agents (tracker_view) and the CLI.
import type { Snapshot } from "./snapshot";

export type ViewSection = "summary" | "map" | "tests" | "agents" | "path" | "feeds" | "tabs";

function ago(iso: string): string {
	const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
	return m < 60 ? `${m}m ago` : m < 1440 ? `${(m / 60).toFixed(1)}h ago` : `${(m / 1440).toFixed(1)}d ago`;
}

function mapLines(s: Snapshot): string[] {
	const out: string[] = [];
	for (const view of ["now", "future"] as const) {
		const d = s.map[view];
		if (!d.items.length) {
			out.push(`${view} map: empty`);
			continue;
		}
		out.push(`${view} map (${d.items.length} boxes, ${d.edges.length} edges):`);
		const kids = new Map<string, typeof d.items>();
		for (const it of d.items) {
			const p = it.parent && d.items.some(x => x.id === it.parent) ? it.parent : "";
			kids.set(p, [...(kids.get(p) ?? []), it]);
		}
		const walk = (parent: string, depth: number) => {
			for (const it of kids.get(parent) ?? []) {
				let state: string;
				if (view === "now") {
					const n = s.nodes[it.id];
					const open = n?.issues.filter(i => i.status !== "fixed").length ?? 0;
					const checks = s.checks.filter(c => c.node === it.id).map(c => `${c.name}=${c.result ? (c.result.ok ? "pass" : "fail") : "pending"}`);
					const bind = n?.bind ? Object.entries(n.bind).map(([k, v]) => `${k}:${v}`) : [];
					const auto = [...(checks.length ? [`checks ${checks.join(" ")}`] : []), ...bind].join("; ");
					state = `${n?.state ?? "planned"}${n?.auto ? ` (from ${n.auto})` : ""}${open ? `, ${open} open issue(s)` : ""}${auto ? ` [${auto}]` : ""}${n?.note ? ` — ${n.note}` : ""}`;
				} else state = `${it.state ?? "-"}${it.ref ? ` ${it.ref}` : ""}`;
				out.push(`${"  ".repeat(depth + 1)}${it.id} "${it.label}": ${state}`);
				walk(it.id, depth + 1);
			}
		};
		walk("", 0);
		if (d.edges.length) out.push(`  edges: ${d.edges.map(e => `${e.from}→${e.to}${e.kind ? `[${e.kind}]` : ""}`).join(", ")}`);
	}
	return out;
}

function testLines(s: Snapshot): string[] {
	const out = [`testing now (${s.testing_now.length}):`];
	for (const t of s.testing_now) out.push(`  ${t.node || "-"}: ${t.what} (since ${ago(t.since)})`);
	out.push(`tests, last ${s.windows.testsHours} h (${s.tests.length}):`);
	for (const t of s.tests.slice(0, 30))
		out.push(`  [${t.id}] ${t.result}${t.resolved ? " (resolved)" : ""} ${t.name} @${t.node || "-"} ${ago(t.t)}${t.why?.[0] ? ` — ${t.why[0]}` : ""}`);
	return out;
}

function pathLines(s: Snapshot): string[] {
	const out = [`critical path${s.critical_path.some(x => x.derived) ? " (from lead todo list)" : ""}:`];
	for (const x of s.critical_path) out.push(`  [${x.state}] ${x.step}${x.eta ? ` · ${x.eta}` : ""}${x.owner ? ` · ${x.owner}` : ""}`);
	if (s.areas.length) out.push("areas:", ...s.areas.map(a => `  ${a.name}: ${a.pct}% ${a.state}`));
	if (s.estimates.length) out.push("estimates:", ...s.estimates.map(e => `  ${e.label}: ${e.when}`));
	if (s.owner_items.length) out.push("waiting on owner:", ...s.owner_items.map(o => `  [${o.id}] ${o.key}: ${o.text}`));
	return out;
}

function agentLines(s: Snapshot): string[] {
	return [
		`agents (${s.agents.filter(a => a.status === "running").length} running / ${s.agents.length}):`,
		...s.agents.map(
			a => `  ${a.name} [${a.status}] ${a.engine}/${a.model ?? "?"} ${a.kind}${a.todo_total ? ` todos ${a.todo_done}/${a.todo_total}` : ""}${a.now ? ` — ${a.now.slice(0, 120)}` : ""}`,
		),
	];
}

function feedLines(s: Snapshot): string[] {
	return [
		`blockers (last ${s.windows.blockersHours} h):`,
		...s.blockers.map(b => `  ${ago(b.t)}: ${b.text}`),
		"recent decisions:",
		...s.decisions.slice(0, 10).map(d => `  ${ago(d.t)}: ${d.text}`),
	];
}

/** Custom tabs: brief lists ids and block shapes; full also prints table rows. */
function tabLines(s: Snapshot, full: boolean): string[] {
	const tabs = s.tabs ?? [];
	if (!tabs.length) return ["custom tabs: none"];
	const out = ["custom tabs:"];
	for (const t of tabs) {
		out.push(`  ${t.id} "${t.title}"${t.public ? "" : " (private)"} — updated ${ago(t.updated)}`);
		for (const b of t.blocks) {
			const shape =
				b.kind === "table"
					? `columns ${b.columns?.map(c => c.key).join(",")}; row_key ${b.rowKey ?? b.columns?.[0]?.key}; ${b.rows?.length ?? 0} rows`
					: b.kind === "chart"
						? `${b.chart} chart, ${b.series?.length ?? 0} series × ${b.labels?.length ?? 0}`
						: b.kind === "text"
							? `${b.text?.length ?? 0} chars`
							: `${b.items?.length ?? 0} items`;
			out.push(`    ${b.id} (${b.kind}${b.pin ? ", pinned" : ""}) ${b.title ? `"${b.title}" ` : ""}— ${shape}`);
			if (full && b.kind === "table")
				for (const r of (b.rows ?? []).slice(0, 40)) out.push(`      ${b.columns!.map(c => `${c.key}=${r[c.key] ?? ""}`).join(" | ")}`);
		}
	}
	return out;
}

export function summarize(s: Snapshot, section: ViewSection, url?: string): string {
	const head = [`${s.title} — ${s.overall_pct}% overall${url ? ` · dashboard ${url}` : ""}`, s.headline ? `headline: ${s.headline}` : "headline: (none)"];
	switch (section) {
		case "map":
			return [...head, ...mapLines(s)].join("\n");
		case "tests":
			return [...head, ...testLines(s)].join("\n");
		case "agents":
			return [...head, ...agentLines(s)].join("\n");
		case "path":
			return [...head, ...pathLines(s)].join("\n");
		case "feeds":
			return [...head, ...feedLines(s)].join("\n");
		case "tabs":
			return [...head, ...tabLines(s, true)].join("\n");
		default: {
			const failing = s.tests.filter(t => (t.result === "fail" || t.result === "stopped") && !t.resolved);
			return [
				...head,
				...mapLines(s),
				`testing now: ${s.testing_now.map(t => `${t.node || "-"}: ${t.what}`).join("; ") || "none"}`,
				`unresolved failures: ${failing.map(t => `[${t.id}] ${t.name}`).join("; ") || "none"}`,
				...pathLines(s),
				...tabLines(s, false),
				`blockers: ${s.blockers.map(b => b.text).join(" | ") || "none"}`,
				`agents: ${s.agents.filter(a => a.status === "running").length} running / ${s.agents.length}`,
			].join("\n");
		}
	}
}
