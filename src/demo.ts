// Seeds a demo tracker so the dashboard can be explored without a live project.
import * as fs from "node:fs";
import * as path from "node:path";
import { applyOps, type Op } from "./ops";
import { newId, TrackerStore } from "./store";
import type { AgentRecord, TrackerEvent } from "./types";

const H = 3_600_000;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const day = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);

export function seedDemo(root: string, forgeRepo?: string): TrackerStore {
	fs.rmSync(path.join(root, ".omp", "tracker"), { recursive: true, force: true });
	const store = TrackerStore.init(root, "atlas");
	const cfg = store.config();
	cfg.git = { disabled: true };
	cfg.autostart = false;
	if (forgeRepo) cfg.forge = { type: "github", repo: forgeRepo };
	store.saveConfig(cfg);
	const ops: Op[] = [
		{
			type: "project",
			subtitle: "build tracker",
			headline: "Checkout rewrite: cart and auth live on staging, payments under load test, search re-index running. Now: Kafka cut-over, iOS release candidate, prod canary prep.",
			overall_method: "Weighted mean of area %, counting only work deployed to staging or prod.",
			rules: "Owner approved the rewrite plan. Agents may merge after review; prod deploys and schema migrations need the owner. Staging is free for testing.",
			infra_label: "Environment",
			facts_label: "Live on staging",
			rules_label: "Approvals in force",
		},
		{
			type: "map",
			view: "now",
			edge_kinds: {
				api: { color: "blue", style: "solid", label: "API calls" },
				data: { color: "purple", style: "solid", label: "reads / writes" },
				events: { color: "fg", style: "dashed", label: "events (Kafka)" },
				deploy: { color: "mute", style: "dotted", label: "deploys" },
			},
			items: [
				{ id: "clients", label: "Clients" },
				{ id: "web", label: "Web storefront", parent: "clients" },
				{ id: "mobile", label: "iOS / Android", parent: "clients" },
				{ id: "admin", label: "Admin console", parent: "clients" },
				{ id: "platform", label: "API platform · Kubernetes 1.31", wide: true, break: true },
				{ id: "edge", label: "edge", parent: "platform" },
				{ id: "gateway", label: "API gateway", parent: "edge" },
				{ id: "auth", label: "Auth service", parent: "edge" },
				{ id: "core", label: "commerce services", parent: "platform" },
				{ id: "cart", label: "Cart", parent: "core" },
				{ id: "payments", label: "Payments", parent: "core", sub: "Stripe + Adyen" },
				{ id: "search", label: "Search", parent: "core" },
				{ id: "notify", label: "Notifications", parent: "core" },
				{ id: "workers", label: "workers", parent: "platform", sub: "background jobs" },
				{ id: "jobs", label: "Job runner", parent: "workers" },
				{ id: "etl", label: "Order ETL", parent: "workers" },
				{ id: "data", label: "Data", break: true },
				{ id: "pg", label: "Postgres 16", parent: "data" },
				{ id: "redis", label: "Redis", parent: "data" },
				{ id: "kafka", label: "Kafka", parent: "data" },
				{ id: "warehouse", label: "Warehouse", parent: "data" },
				{ id: "delivery", label: "Delivery" },
				{ id: "ci", label: "CI pipeline", parent: "delivery" },
				{ id: "staging", label: "Staging", parent: "delivery" },
				{ id: "prod", label: "Production", parent: "delivery" },
			],
			edges: [
				{ from: "clients", to: "gateway", kind: "api", label: "HTTPS" },
				{ from: "gateway", to: "auth", kind: "api" },
				{ from: "core", to: "pg", kind: "data" },
				{ from: "payments", to: "kafka", kind: "events", label: "order events" },
				{ from: "kafka", to: "warehouse", kind: "events" },
				{ from: "ci", to: "staging", kind: "deploy" },
				{ from: "staging", to: "prod", kind: "deploy", label: "canary" },
			],
		},
		{
			type: "map",
			view: "future",
			edge_kinds: {
				api: { color: "blue", label: "API calls" },
				events: { color: "yellow", label: "event stream" },
				ml: { color: "purple", style: "dotted", label: "model inference (future)" },
			},
			items: [
				{ id: "f-clients", label: "Clients · web, iOS, Android, admin", state: "built", desc: "All storefronts on the new API.", now: "clients" },
				{ id: "f-region", label: "Region A · primary", wide: true, break: true },
				{ id: "f-gw", label: "API gateway", parent: "f-region", state: "built", now: "gateway", desc: "Single entry point with rate limits and auth." },
				{ id: "f-cart", label: "Cart", parent: "f-region", state: "built", now: "cart", desc: "Cart service on Postgres." },
				{ id: "f-pay", label: "Payments", parent: "f-region", state: "progress", now: "payments", desc: "Two PSPs with automatic failover." },
				{ id: "f-search", label: "Search", parent: "f-region", state: "progress", desc: "OpenSearch with live re-index." },
				{ id: "f-recs", label: "Recommendations", parent: "f-region", state: "future", ref: "#88", desc: "Personalised recommendations served next to search." },
				{ id: "f-ml", label: "Model server", parent: "f-region", state: "future", ref: "#91", desc: "Local model inference for recommendations and fraud scoring." },
				{ id: "f-region-b", label: "Region B · failover", state: "planned", ref: "#120", desc: "A second region taking traffic on failover.", break: true },
				{ id: "f-gw-b", label: "API gateway", parent: "f-region-b", state: "planned", ref: "#120", desc: "Replica gateway." },
				{ id: "f-db-b", label: "Postgres replica", parent: "f-region-b", state: "planned", ref: "#121", desc: "Streaming replica, promoted on failover." },
				{ id: "f-stream", label: "Event stream", state: "progress", desc: "Kafka feeding warehouse and fraud scoring." },
			],
			edges: [
				{ from: "f-clients", to: "f-gw", kind: "api" },
				{ from: "f-pay", to: "f-stream", kind: "events" },
				{ from: "f-ml", to: "f-recs", kind: "ml" },
				{ from: "f-region", to: "f-region-b", kind: "events", label: "replication", both: true },
			],
		},
		{ type: "node", id: "clients", state: "live", note: "All three clients build from the monorepo." },
		{ type: "node", id: "web", state: "live", note: "Storefront on the new API in staging; 100% of staging traffic." },
		{ type: "node", id: "mobile", state: "testing", note: "Release candidate 4.2.0-rc3 in TestFlight; Android build green." },
		{ type: "node", id: "admin", state: "building", note: "Refund screens remain." },
		{ type: "node", id: "platform", state: "live", note: "Cluster healthy; HPA on all services." },
		{ type: "node", id: "gateway", state: "live", note: "Rate limits and JWT validation on." },
		{ type: "node", id: "auth", state: "live", note: "OIDC with refresh-token rotation." },
		{ type: "node", id: "cart", state: "live", note: "Live on staging; p99 41 ms." },
		{ type: "node", id: "payments", state: "testing", note: "Load test at 400 rps; Adyen failover proven once." },
		{ type: "node", id: "search", state: "building", note: "Re-index from Postgres running." },
		{ type: "node", id: "notify", state: "planned" },
		{ type: "node", id: "jobs", state: "live" },
		{ type: "node", id: "etl", state: "blocked", note: "Waiting on warehouse credentials from the owner." },
		{ type: "node", id: "pg", state: "live", note: "Primary + one replica; PITR enabled." },
		{ type: "node", id: "redis", state: "live" },
		{ type: "node", id: "kafka", state: "building", note: "Topics created; producers cut over one by one." },
		{ type: "node", id: "warehouse", state: "planned" },
		{ type: "node", id: "ci", state: "live", note: "Main green; 11 min median pipeline." },
		{ type: "node", id: "staging", state: "live" },
		{ type: "node", id: "prod", state: "planned", note: "Canary plan written; needs owner approval." },
		{ type: "issue", node: "payments", what: "Idempotency keys expire before PSP retries finish", fix: "Key TTL raised to 24 h; retry test passing", status: "fixed", lane: "WP-PAY" },
		{ type: "issue", node: "payments", what: "Webhook replay double-books refunds", fix: "Dedup table added; replay test pending", status: "in progress", lane: "WP-PAY" },
		{ type: "issue", node: "mobile", what: "Deep links open the old checkout on iOS 17", status: "open", lane: "WP-IOS" },
		{ type: "issue", node: "search", what: "Re-index drops products with emoji in titles", fix: "Tokenizer fix in review (#214)", status: "in progress", lane: "WP-SEARCH" },
		{
			type: "inventory",
			node: "cart",
			summary: "Cart runs three replicas on staging behind the gateway.",
			items: [
				{ what: "cart-api", detail: "3 replicas, image cart:1.8.2, HPA 3–12", state: "live" },
				{ what: "carts table", detail: "Postgres 16, 1.2 M rows migrated", state: "live" },
				{ what: "price cache", detail: "Redis, 5 min TTL", state: "live" },
				{ what: "abandoned-cart job", detail: "Nightly job runner task", state: "building" },
			],
			source: "kubectl get deploy -n commerce; psql \\dt+",
		},
		{
			type: "inventory",
			node: "payments",
			summary: "Payments runs in shadow mode on staging.",
			items: [
				{ what: "payments-api", detail: "2 replicas, image payments:0.9.0", state: "testing" },
				{ what: "PSP adapters", detail: "Stripe (primary), Adyen (failover)", state: "live" },
				{ what: "ledger", detail: "Double-entry ledger table", state: "building" },
			],
		},
		...[
			["Web storefront on new API", 100, "live", "All staging traffic on the new API."],
			["Auth and gateway", 100, "live", "OIDC, rate limits, JWT validation."],
			["Cart and pricing", 90, "live", "Abandoned-cart job remains."],
			["Payments", 65, "testing", "Load and failover tests running."],
			["Search", 45, "building", "Re-index running; tokenizer fix in review."],
			["Mobile apps", 70, "testing", "iOS RC3 in TestFlight."],
			["Data pipeline", 30, "building", "Kafka cut-over; warehouse blocked on credentials."],
			["Production cut-over", 10, "queued", "Canary plan written."],
		].map(([name, pct, state, note]) => ({ type: "area" as const, name, pct, state, note, weight: name === "Production cut-over" ? 2 : 1 })),
		...[
			["Payments load test at 400 rps", "done", "14:10Z", "WP-PAY", "p99 180 ms"],
			["Payments failover drill (Stripe → Adyen)", "active", "~17:00Z", "WP-PAY", "second drill after dedup fix"],
			["Search re-index + tokenizer fix", "building", "today", "WP-SEARCH", ""],
			["Kafka producer cut-over", "building", "tomorrow", "WP-DATA", "3 of 7 producers moved"],
			["Owner approves prod canary plan", "queued", "after drill", "owner", "one-time approval"],
			["Prod canary at 5%", "queued", "after approval", "WP-REL", ""],
		].map(([step, state, eta, owner, note]) => ({ type: "step" as const, step, state, eta, owner, note })),
		{ type: "phase", phase: "Repo foundation and CI", start: day(9), end: day(8), items: ["Monorepo with shared lint and types", "CI with preview deploys", "Secrets in the vault"] },
		{ type: "phase", phase: "Platform cluster", start: day(8), end: day(6), items: ["Kubernetes 1.31 with HPA", "Gateway + auth", "Observability stack"] },
		{ type: "phase", phase: "Cart service", start: day(6), end: day(4), items: ["Cart API", "Postgres migration (1.2 M rows)", "Price cache"] },
		{ type: "phase", phase: "Web storefront cut-over", start: day(4), end: day(2), items: ["New API client", "Feature-flagged rollout", "100% of staging traffic"] },
		{ type: "phase", phase: "Payments shadow mode", start: day(2), end: day(1), items: ["Stripe + Adyen adapters", "Ledger schema", "Idempotency keys"] },
		{ type: "estimate", label: "Payments ready for prod", when: "Tomorrow, ~noon", start: day(1), end: day(-1) },
		{ type: "estimate", label: "Search re-index complete", when: "Today, late", start: day(0), end: day(0) },
		{ type: "estimate", label: "Mobile 4.2.0 in stores", when: "In 3 days", start: day(0), end: day(-3) },
		{ type: "estimate", label: "Prod cut-over complete", when: "In 6 days", start: day(-2), end: day(-6) },
		{ type: "owner_item", key: "Approve", text: "Prod canary plan (5% → 25% → 100%), docs/canary.md. Say 'approve canary' and the release agent starts." },
		{ type: "owner_item", key: "Credentials", text: "Warehouse service account for the Order ETL (read-only on the orders schema)." },
		{ type: "owner_item", key: "Decide", text: "Keep Adyen as hot failover (+$400/mo) or cold standby?" },
		{ type: "fact", key: "Kubernetes", value: "1.31.2, 3 nodes, HPA on all services" },
		{ type: "fact", key: "Postgres", value: "16.4, primary + replica, PITR 7 days" },
		{ type: "fact", key: "Kafka", value: "3 brokers, 12 topics, 3/7 producers cut over" },
		{ type: "fact", key: "API gateway", value: "Envoy 1.31 with JWT + rate limits" },
		{ type: "fact", key: "Web", value: "Next.js 15, 100% of staging traffic" },
		{ type: "fact", key: "Mobile", value: "iOS 4.2.0-rc3 (TestFlight), Android 4.2.0-rc2" },
		{ type: "chunk", title: "Checkout API", open: 3, closed: 21 },
		{ type: "chunk", title: "Payments", open: 7, closed: 12 },
		{ type: "chunk", title: "Search", open: 6, closed: 4 },
		{ type: "chunk", title: "Mobile release", open: 4, closed: 9 },
	];
	const res = applyOps(store, ops, "demo-lead");
	if (res.errors.length) throw new Error(`demo seed failed:\n${res.errors.join("\n")}`);

	const ev = (e: Omit<Extract<TrackerEvent, { type: "test" }>, "id" | "type">): TrackerEvent => ({ type: "test", id: newId(), ...e });
	const events: TrackerEvent[] = [
		ev({ t: iso(5.2 * H), node: "payments", name: "payments load test 400 rps", result: "running", lane: "WP-PAY", where: "staging", agent: "demo-pay" }),
		ev({ t: iso(4.6 * H), node: "payments", name: "payments load test 400 rps", result: "pass", lane: "WP-PAY", agent: "demo-pay" }),
		ev({ t: iso(4.1 * H), node: "payments", name: "refund webhook replay", result: "fail", why: ["Replaying a webhook booked the refund twice.", "The dedup table was not consulted on the replay path."], next: "Dedup fix in PR #219, rerun after merge.", lane: "WP-PAY", agent: "demo-pay" }),
		ev({ t: iso(3.5 * H), node: "cart", name: "cart p99 under 50 ms", result: "pass", lane: "WP-CART", agent: "demo-cart" }),
		ev({ t: iso(3.2 * H), node: "search", name: "search re-index dry run", result: "fail", why: ["Products with emoji in titles were dropped by the tokenizer."], next: "Tokenizer fix (#214).", lane: "WP-SEARCH", agent: "demo-search" }),
		ev({ t: iso(2.4 * H), node: "search", name: "search re-index dry run", result: "pass", lane: "WP-SEARCH", agent: "demo-search" }),
		ev({ t: iso(4.4 * H), node: "kafka", name: "producer cut-over: orders", result: "running", lane: "WP-DATA", where: "staging", agent: "demo-data" }),
		ev({ t: iso(1.9 * H), node: "mobile", name: "iOS deep links", result: "stopped", why: ["Device farm quota ran out mid-run."], next: "Rerun on the next quota window.", lane: "WP-IOS", agent: "demo-ios" }),
		ev({ t: iso(1.2 * H), node: "payments", name: "PSP failover drill", result: "running", lane: "WP-PAY", where: "staging", agent: "demo-pay" }),
		ev({ t: iso(0.9 * H), node: "search", name: "full re-index", result: "running", lane: "WP-SEARCH", where: "staging", agent: "demo-search" }),
		ev({ t: iso(0.6 * H), node: "web", name: "storefront smoke suite", result: "pass", lane: "WP-WEB", agent: "demo-web" }),
		ev({ t: iso(0.3 * H), node: "mobile", name: "Android checkout e2e", result: "running", lane: "WP-ANDROID", where: "device farm", agent: "demo-ios" }),
		{ type: "post", id: newId(), t: iso(0.5 * H), kind: "blocker", text: "Order ETL blocked: needs warehouse service-account credentials from the owner.", agent: "demo-data" },
		{ type: "post", id: newId(), t: iso(1.7 * H), kind: "blocker", text: "Device farm quota exhausted until 18:00Z; iOS deep-link run stopped.", agent: "demo-ios" },
		{ type: "post", id: newId(), t: iso(2 * H), kind: "decision", text: "Owner: keep the old checkout behind a flag for one week after cut-over.", agent: "demo-lead" },
		{ type: "post", id: newId(), t: iso(9 * H), kind: "decision", text: "Use Adyen as failover PSP; Stripe stays primary.", agent: "demo-lead" },
		{ type: "post", id: newId(), t: iso(20 * H), kind: "decision", text: "Search moves to OpenSearch; Algolia contract not renewed.", agent: "demo-lead" },
		{ type: "post", id: newId(), t: iso(3 * H), kind: "note", text: "Staging DB snapshot taken before the Kafka cut-over (snap-2207).", agent: "demo-data" },
	];
	// Spread background posts over the last day so the activity chart has shape.
	for (let i = 0; i < 140; i++) {
		const hoursAgo = Math.pow(Math.random(), 0.7) * 24;
		events.push({ type: "op", id: newId(), t: iso(hoursAgo * H), summary: "progress update", agent: "demo-lead" });
	}
	store.appendEvents(events);

	const t = new Date().toISOString();
	const agent = (a: Partial<AgentRecord> & Pick<AgentRecord, "id" | "name" | "engine" | "kind" | "status">, postMinAgo: number | null): AgentRecord => ({
		started: iso(10 * H),
		updated: t,
		...(postMinAgo === null ? {} : { lastPost: iso(postMinAgo * 60_000) }),
		...a,
	});
	const agents: AgentRecord[] = [
		agent({ id: "demo-lead", name: "lead · atlas rewrite", engine: "claude", model: "claude-opus-5-5", thinking: "high", kind: "lead", status: "running", now: "Waiting for the failover drill before asking the owner to approve the canary.", action: "tracker_view: summary", focus: "Coordinate the checkout rewrite to production.", last: "step Payments failover drill: active",
			todo: [{ name: "Cut-over", tasks: [{ content: "Payments failover drill", status: "in_progress" }, { content: "Owner approves canary", status: "pending" }, { content: "Prod canary 5%", status: "pending" }, { content: "Web storefront cut-over", status: "completed" }] }] }, 4),
		agent({ id: "demo-pay", name: "WP-PAY: payments failover", engine: "gpt", model: "gpt-6.1-sol", thinking: "high", kind: "builder", status: "running", now: "Drill running: Stripe disabled at the gateway, Adyen taking traffic, ledger balanced so far.", action: "bash: k6 run drills/failover.js --vus 200", focus: "Payments to prod quality: load, failover, refunds." }, 12),
		agent({ id: "demo-search", name: "WP-SEARCH: re-index", engine: "claude", model: "claude-sonnet-5", thinking: "medium", kind: "builder", status: "running", now: "Full re-index 62% done; no dropped documents after the tokenizer fix.", action: "bash: ./scripts/reindex --watch", focus: "Search on OpenSearch with live re-index." }, 35),
		agent({ id: "demo-data", name: "WP-DATA: Kafka cut-over", engine: "gemini", model: "gemini-3-pro", thinking: "high", kind: "builder", status: "running", now: "Orders producer dual-writing; comparing offsets before switching reads.", action: "bash: kcat -C -t orders -o -100", focus: "Move all producers to Kafka; ETL into the warehouse." }, 8),
		agent({ id: "demo-ios", name: "WP-IOS: mobile release", engine: "gpt", model: "gpt-6.1-sol", thinking: "medium", kind: "builder", status: "idle", now: "Deep-link run stopped by device-farm quota; resumes at 18:00Z.", focus: "Ship 4.2.0 to both stores." }, 110),
		agent({ id: "demo-review", name: "reviewer: payments PRs", engine: "claude", model: "claude-opus-5-5", thinking: "xhigh", kind: "reviewer", status: "running", now: "Reviewing PR #219 (webhook dedup); one race found in the replay path.", action: "read: services/payments/webhooks.ts" }, 22),
		agent({ id: "demo-web", name: "WP-WEB: storefront", engine: "claude", model: "claude-sonnet-5", thinking: "low", kind: "builder", status: "closed", now: "Storefront cut-over complete; smoke suite green.", focus: "Storefront on the new API." }, 36),
		agent({ id: "demo-watch", name: "watcher: staging health", engine: "gpt", model: "gpt-6.1-mini", thinking: "low", kind: "watcher", status: "running", now: "All staging SLOs green for the last hour.", action: "bash: curl -s staging/healthz" }, null),
	];
	for (const a of agents) store.writeAgent(a);

	// Two days of history every 10 minutes.
	for (let m = 48 * 60; m >= 0; m -= 10) {
		const f = 1 - m / (48 * 60);
		store.appendHistory({
			t: iso(m * 60_000),
			overall_pct: Math.round(38 + 26 * f + Math.sin(m / 90) * 1.5),
			open_issues: Math.round(30 - 12 * f + Math.sin(m / 50) * 3),
			merges24: Math.round(40 + 25 * Math.sin(m / 300) + 20 * f),
			open_prs: Math.round(12 + 4 * Math.sin(m / 120)),
			agents_running: 5 + Math.round(2 * Math.sin(m / 200)),
			agents_total: 8,
			posts24: Math.round(120 + 30 * Math.sin(m / 180)),
		});
	}
	return store;
}
