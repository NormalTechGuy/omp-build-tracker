// Shared data model for the build tracker.
// state.json holds curated state; events.jsonl holds posts and test runs;
// agents/<id>.json holds one heartbeat file per agent session.

/** States a box on the "now" map can be in. `live` means done and working. */
export const NODE_STATES = ["live", "testing", "building", "planned", "blocked"] as const;
export type NodeState = (typeof NODE_STATES)[number];

/** States a box on the "future" map can be in. */
export const FUTURE_STATES = ["built", "progress", "planned", "future"] as const;
export type FutureState = (typeof FUTURE_STATES)[number];

/** Area / chunk / critical path states. */
export const WORK_STATES = ["live", "done", "built", "testing", "active", "building", "queued", "blocked"] as const;
export type WorkState = (typeof WORK_STATES)[number];

export const TEST_RESULTS = ["running", "pass", "fail", "stopped"] as const;
export type TestResult = (typeof TEST_RESULTS)[number];

export const ISSUE_STATUSES = ["open", "in progress", "fixed"] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];

export const POST_KINDS = ["decision", "blocker", "note"] as const;
export type PostKind = (typeof POST_KINDS)[number];

export const BLOCK_KINDS = ["table", "stats", "kv", "list", "text", "chart"] as const;
export type BlockKind = (typeof BLOCK_KINDS)[number];

export const COLUMN_KINDS = ["text", "number", "score", "pct", "delta", "state", "tokens"] as const;
export type ColumnKind = (typeof COLUMN_KINDS)[number];

export interface TabColumn {
	key: string;
	label?: string;
	/** text (default) · number · score (number with an inline bar) · pct (0–100) · delta (+/- coloured) · state (coloured word) · tokens (k/M) */
	kind?: ColumnKind;
	/** Digits after the decimal point for numeric kinds. */
	digits?: number;
	/** For score/delta: lower is better. */
	lowerBetter?: boolean;
}

export interface TabItem {
	label?: string;
	value?: string | number;
	sub?: string;
	text?: string;
	state?: string;
}

export interface TabSeries {
	name: string;
	values: (number | null)[];
	color?: string;
}

export interface TabBlock {
	id: string;
	kind: BlockKind;
	title?: string;
	note?: string;
	/** Also show this block on the Overview tab. */
	pin?: boolean;
	/** Half width on wide screens (two half blocks share a row). */
	half?: boolean;
	// table
	columns?: TabColumn[];
	rows?: Record<string, unknown>[];
	/** Column whose value identifies a row for tab_rows upserts (default: first column). */
	rowKey?: string;
	sort?: string;
	sortDir?: "asc" | "desc";
	/** Add a rank column numbered by the current sort; rows with `_unranked: true` are skipped. */
	rank?: boolean;
	// stats / kv / list
	items?: TabItem[];
	// text
	text?: string;
	// chart
	chart?: "bar" | "line" | "hbar";
	labels?: string[];
	series?: TabSeries[];
	updated: string;
}

export interface CustomTab {
	id: string;
	title: string;
	/** Short line under the tab title. */
	note?: string;
	/** Shown on share links and exports (default true). */
	public: boolean;
	/** Sort order among custom tabs (lower first). */
	order: number;
	blocks: TabBlock[];
	updated: string;
}

export const AGENT_STATUSES = ["running", "idle", "closed", "error"] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

/** A box on a map. Boxes with children (other items naming it as `parent`) render as containers. */
export interface MapItem {
	id: string;
	label: string;
	/** Container id this box sits in. */
	parent?: string;
	/** Small secondary text; `\n` splits lines. */
	sub?: string;
	/** Long name used in the side panel. */
	full?: string;
	/** Future map only: planned state of this box. */
	state?: FutureState;
	/** Future map only: issue / ticket reference shown with the state. */
	ref?: string;
	/** Future map only: what this box is. */
	desc?: string;
	/** Future map only: id of the matching box on the now map ("See it live"). */
	now?: string;
	/** Container only: lay children out full width, one per row ("column") or wrapping ("row", default). */
	flow?: "row" | "column";
	/** Start this item on a new row inside its container. */
	break?: boolean;
	/** Make this item take the full width of its container. */
	wide?: boolean;
}

export interface MapEdge {
	from: string;
	to: string;
	kind?: string;
	label?: string;
	/** Arrow at both ends. */
	both?: boolean;
}

export interface EdgeKind {
	/** Palette name (pink, orange, yellow, green, blue, purple, mute, fg) or #hex. */
	color: string;
	style?: "solid" | "dashed" | "dotted";
	label?: string;
}

export interface MapDef {
	items: MapItem[];
	edges: MapEdge[];
	edgeKinds: Record<string, EdgeKind>;
}

export interface NodeIssue {
	id: string;
	what: string;
	fix?: string;
	status: IssueStatus;
	lane?: string;
	when: string;
	updated: string;
}

export interface InventoryItem {
	what: string;
	detail?: string;
	state?: string;
}

export interface NodeStatus {
	state: NodeState;
	note?: string;
	issues: NodeIssue[];
	inventory?: { asof: string; summary?: string; items: InventoryItem[]; source?: string };
	updated: string;
	/** Deterministic sources the server keeps in sync for this box. */
	bind?: NodeBinding;
}

export interface NodeBinding {
	/** CI workflow names (globs, comma separated) whose runs become tests on this box. */
	ci?: string;
	/** Forge issue label whose issues become this box's issues. */
	label?: string;
}

export const PROBE_KINDS = ["http", "tcp", "cmd"] as const;
export type ProbeKind = (typeof PROBE_KINDS)[number];

/** A health check the tracker server runs on a schedule. */
export interface Probe {
	id: string;
	node: string;
	name: string;
	kind: ProbeKind;
	/** URL (http), host:port (tcp) or shell command (cmd). */
	target: string;
	/** http: expected status (default any 2xx/3xx). */
	expectStatus?: number;
	/** http/cmd: text the body/output must contain. */
	expectText?: string;
	everySeconds: number;
	timeoutSeconds: number;
	/** Whether results set the box state (all pass → live, any fail → blocked). */
	drivesState: boolean;
}

/** probes.json: latest result per probe, written by the server. */
export interface ProbeResult {
	t: string;
	ok: boolean;
	detail: string;
	ms: number;
	/** When the current ok/fail streak began. */
	since: string;
}

export interface Area {
	id: string;
	name: string;
	pct: number;
	state: WorkState;
	note?: string;
	weight?: number;
	/** Derive pct from a milestone / chunk / todo phase with this title. */
	milestone?: string;
	/** Derive pct from the share of live boxes under this map container. */
	map?: string;
}

export interface Step {
	id: string;
	step: string;
	state: WorkState;
	eta?: string;
	owner?: string;
	note?: string;
}

export interface Phase {
	id: string;
	phase: string;
	start: string;
	end: string;
	items: string[];
}

export interface Estimate {
	id: string;
	label: string;
	when: string;
	start?: string;
	end?: string;
}

export interface OwnerItem {
	id: string;
	key: string;
	text: string;
}

export interface Fact {
	key: string;
	value: string;
}

export interface Chunk {
	id: string;
	title: string;
	open: number;
	closed: number;
}

export interface Labels {
	/** Title of the "Infrastructure" tab and its first card. */
	infra?: string;
	/** Heading of the facts card. */
	facts?: string;
	/** Heading of the rules / approvals card. */
	rules?: string;
	/** Word for the subject being built in the header (e.g. "build tracker"). */
	subtitle?: string;
}

export interface TrackerState {
	version: 1;
	title: string;
	labels: Labels;
	headline?: string;
	overallPct?: number;
	overallMethod?: string;
	rules?: string;
	footer?: string;
	map: { now: MapDef; future: MapDef };
	nodes: Record<string, NodeStatus>;
	areas: Area[];
	criticalPath: Step[];
	phases: Phase[];
	estimates: Estimate[];
	ownerItems: OwnerItem[];
	facts: Fact[];
	chunks: Chunk[];
	testNotes: Record<string, { why?: string; next?: string }>;
	probes: Probe[];
	/** Last time either map view changed (for the stale-map hint). */
	mapUpdated?: string;
	/** Run-specific tabs the agents design (leaderboard, results matrix, checklist, …). */
	tabs: CustomTab[];
	updated: string;
}

/** One line of events.jsonl. */
export type TrackerEvent =
	| {
			type: "test";
			id: string;
			t: string;
			node: string;
			name: string;
			result: TestResult;
			why?: string[];
			next?: string;
			lane?: string;
			where?: string;
			agent?: string;
			/** Hours a running test may take before it shows as "no result" (default windows.noResultHours). */
			timeoutHours?: number;
	  }
	| { type: "post"; id: string; t: string; kind: PostKind; text: string; agent?: string }
	| { type: "op"; id: string; t: string; summary: string; agent?: string };

export interface TodoTask {
	content: string;
	status: string;
}
export interface TodoPhase {
	name: string;
	tasks: TodoTask[];
}

/** agents/<id>.json */
export interface AgentRecord {
	id: string;
	name: string;
	engine: string;
	model?: string;
	thinking?: string;
	status: AgentStatus;
	kind: string;
	/** What the agent is saying right now (last assistant text). */
	now?: string;
	/** Last tool call, "tool: detail". */
	action?: string;
	/** Assignment / goal. */
	focus?: string;
	/** Last tracker post text. */
	last?: string;
	lastPost?: string;
	parent?: string;
	pid?: number;
	host?: string;
	todo?: TodoPhase[];
	/** Curator: number of runs recorded on this card. */
	runs?: number;
	started: string;
	updated: string;
}

export interface ForgeConfig {
	type: "github" | "gitea" | "none";
	/** owner/name */
	repo?: string;
	/** Gitea base URL, e.g. http://localhost:3000 */
	url?: string;
	/** Environment variable holding the Gitea token. */
	tokenEnv?: string;
}

export interface TrackerConfig {
	port?: number;
	host?: string;
	git?: { branch?: string; disabled?: boolean };
	forge: ForgeConfig;
	refresh: { gitSeconds: number; forgeSeconds: number; historyMinutes: number };
	windows: { testsHours: number; noResultHours: number; blockersHours: number; agentsHours: number };
	/** Start the dashboard server from omp sessions automatically. */
	autostart: boolean;
	/** Add a short tracker note to every agent's system prompt. */
	promptHint: boolean;
	share: ShareConfig;
	cloudflare: CloudflareConfig;
	curator: CuratorConfig;
	/** Remind the lead agent to update the tracker when a run changed files but posted nothing. */
	stopNudge: boolean;
	/** Post test / typecheck / lint commands agents run in bash as tests automatically. */
	autoTests: boolean;
	/** Show questions agents ask you (ask tool) under "Waiting on you" while they wait. */
	autoAsks: boolean;
}

export interface CuratorConfig {
	/** Run a cheap omp agent that reconciles the tracker with what all sessions did. */
	enabled: boolean;
	/** Model selector or role for the curator (default "@smol"). */
	model: string;
	/** Minimum minutes between curator runs. */
	minMinutes: number;
	/** Command that starts omp (default: omp on PATH). */
	command?: string;
}

export interface ShareConfig {
	/** off; tailnet: `tailscale serve` (your devices, read-write); funnel: public read-only link. */
	mode: "off" | "tailnet" | "funnel";
	/** Unguessable mount path, e.g. /t-AbC…; rotating it revokes old links. */
	path?: string;
	/** Tailscale HTTPS port (default 443; funnel allows 443, 8443, 10000). */
	httpsPort?: number;
	/** Local port of the read-only listener funnel points at (default: dashboard port + 1000). */
	publicPort?: number;
}

/** Share state the server reports (server.json, snapshot). */
export interface ShareStatus {
	mode: ShareConfig["mode"];
	path?: string;
	url?: string;
	error?: string;
	/** When the server last applied the share config. */
	at?: string;
}

export interface CloudflareConfig {
	enabled: boolean;
	/** Worker name (created on first deploy). */
	name?: string;
	/** https://<name>.<account>.workers.dev */
	url?: string;
	/** Minimum seconds between pushes (Durable Object free tier: 100k writes/day). */
	minIntervalSeconds: number;
	/** Push at least this often even without changes, so "updated" stays fresh. */
	heartbeatSeconds: number;
	/** Hash of the dashboard files last deployed; the server redeploys when it differs. */
	assetsHash?: string;
}

export interface CloudflareStatus {
	enabled: boolean;
	/** Public link including the key. */
	url?: string;
	lastPush?: string;
	error?: string;
}

/** server.json */
export interface ServerInfo {
	pid: number;
	port: number;
	url: string;
	started: string;
	share?: ShareStatus;
	cloudflare?: CloudflareStatus;
}

export interface HistoryPoint {
	t: string;
	overall_pct: number;
	open_issues: number | null;
	merges24: number;
	open_prs: number | null;
	agents_running: number;
	agents_total: number;
	posts24: number;
}
