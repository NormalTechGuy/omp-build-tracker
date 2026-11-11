// Collectors for data the agents never have to post: git history and the forge
// (GitHub through the gh CLI, or Gitea through its REST API).
import type { ForgeConfig } from "./types";

export interface Merge {
	/** Unix seconds. */
	t: number;
	pr?: number;
	title: string;
}

export interface MergeStats {
	last3h: number;
	last24: number;
	/** [hourIso, count] for the last 48 h, oldest first. */
	perHour: [string, number][];
	/** Newest first. */
	recent: Merge[];
}

export interface GitData extends MergeStats {
	branch: string;
	tip: string;
}

export interface PrRow {
	n: number;
	title: string;
	draft: boolean;
	branch: string;
	author: string;
	age_h: number;
}

export interface ForgeData {
	kind: "github" | "gitea";
	repo: string;
	prs: { open: number; drafts: number; list: PrRow[] };
	issues: { total: number; open: number; closed: number; days: [string, number, number][] };
	milestones: { title: string; open: number; closed: number }[];
	/** Merged pull requests in the last 48 h. */
	merges: MergeStats;
	/** Recent CI runs (GitHub Actions), newest first. */
	runs: CiRun[];
	/** Open issues plus issues closed in the last 7 days, with labels. */
	labeled: ForgeIssue[];
	fetched: string;
	error?: string;
}

export interface CiRun {
	id: number;
	workflow: string;
	title: string;
	branch: string;
	number: number;
	/** queued | in_progress | completed … */
	status: string;
	/** success | failure | cancelled | skipped | timed_out … (completed runs) */
	conclusion: string | null;
	started: string;
	updated: string;
	url: string;
}

export interface ForgeIssue {
	n: number;
	title: string;
	url: string;
	state: "open" | "closed";
	labels: string[];
	created: string;
	closed?: string;
}

async function run(cmd: string[], cwd: string, timeoutMs = 20_000): Promise<{ ok: boolean; out: string; err: string }> {
	try {
		const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
		const timer = setTimeout(() => proc.kill(), timeoutMs);
		const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
		clearTimeout(timer);
		return { ok: code === 0, out, err };
	} catch (e) {
		return { ok: false, out: "", err: String(e) };
	}
}

/** Floor a time to its UTC hour, as "YYYY-MM-DDTHH:00". */
export function hourKey(ms: number): string {
	return new Date(Math.floor(ms / 3_600_000) * 3_600_000).toISOString().slice(0, 13) + ":00";
}

/** Empty [hourKey, 0] buckets for the last `hours` hours, oldest first. */
export function hourBuckets(hours: number, nowMs = Date.now()): [string, number][] {
	const out: [string, number][] = [];
	for (let i = hours - 1; i >= 0; i--) out.push([hourKey(nowMs - i * 3_600_000), 0]);
	return out;
}

export function mergeStats(merges: Merge[], nowMs = Date.now()): MergeStats {
	const perHour = hourBuckets(48, nowMs);
	const index = new Map(perHour.map((b, i) => [b[0], i]));
	let last3h = 0;
	let last24 = 0;
	const recent = merges.filter(m => nowMs - m.t * 1000 <= 48 * 3_600_000).sort((a, b) => b.t - a.t);
	for (const m of recent) {
		const ms = m.t * 1000;
		const i = index.get(hourKey(ms));
		if (i !== undefined) perHour[i][1]++;
		if (nowMs - ms <= 3 * 3_600_000) last3h++;
		if (nowMs - ms <= 24 * 3_600_000) last24++;
	}
	return { last3h, last24, perHour, recent: recent.slice(0, 60) };
}

export async function collectGit(root: string, branchOverride?: string): Promise<GitData | undefined> {
	const head = await run(["git", "rev-parse", "--abbrev-ref", "HEAD"], root);
	if (!head.ok) return undefined;
	const current = head.out.trim();
	const tip = (await run(["git", "rev-parse", "--short", "HEAD"], root)).out.trim();
	let mainline = branchOverride;
	if (!mainline) {
		const remoteHead = await run(["git", "symbolic-ref", "--short", "refs/remotes/origin/HEAD"], root);
		mainline = remoteHead.ok ? remoteHead.out.trim() : current;
	}
	// Each first-parent commit on the mainline is one landed change (a merge or a direct commit).
	const log = await run(["git", "log", "--first-parent", mainline, "--since=48 hours ago", "--format=%ct%x09%s"], root);
	const recent: Merge[] = [];
	for (const line of log.ok ? log.out.split("\n") : []) {
		if (!line) continue;
		const tab = line.indexOf("\t");
		const title = line.slice(tab + 1);
		const pr = title.match(/(?:Merge pull request #|\(#|!)(\d+)/);
		recent.push({
			t: Number(line.slice(0, tab)),
			...(pr ? { pr: Number(pr[1]) } : {}),
			title: title.replace(/^Merge pull request #\d+ from \S+\s*/, "").replace(/\s*\(#\d+\)$/, "") || title,
		});
	}
	return { branch: current === "HEAD" ? tip : current, tip, ...mergeStats(recent) };
}

/** Guess owner/name from the origin remote. */
export async function detectRepo(root: string): Promise<{ host: string; repo: string } | undefined> {
	const r = await run(["git", "remote", "get-url", "origin"], root);
	if (!r.ok) return undefined;
	const url = r.out.trim();
	const m = url.match(/^(?:https?:\/\/(?:[^@/]+@)?|ssh:\/\/(?:[^@/]+@)?|[^@/]+@)([^/:]+)(?::\d+)?[/:](.+?)(?:\.git)?\/?$/);
	return m ? { host: m[1], repo: m[2] } : undefined;
}

function dayBuckets(days: number): [string, number, number][] {
	const out: [string, number, number][] = [];
	const today = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
	for (let i = days - 1; i >= 0; i--) out.push([new Date(today - i * 86_400_000).toISOString().slice(0, 10), 0, 0]);
	return out;
}

function countDays(days: [string, number, number][], created: string[], closed: string[]): void {
	const idx = new Map(days.map((d, i) => [d[0], i]));
	for (const c of created) {
		const i = idx.get(c.slice(0, 10));
		if (i !== undefined) days[i][1]++;
	}
	for (const c of closed) {
		const i = idx.get(c.slice(0, 10));
		if (i !== undefined) days[i][2]++;
	}
}

function ageHours(iso: string): number {
	return Math.max(0, Math.round(((Date.now() - Date.parse(iso)) / 3_600_000) * 10) / 10);
}

const GH_QUERY = `query($owner:String!,$name:String!,$since:DateTime!,$cursor:String){
 repository(owner:$owner,name:$name){
  open:issues(states:OPEN){totalCount}
  closed:issues(states:CLOSED){totalCount}
  pullRequests(states:OPEN,first:100,orderBy:{field:CREATED_AT,direction:DESC}){totalCount nodes{number title isDraft headRefName createdAt author{login}}}
  milestones(first:50,orderBy:{field:DUE_DATE,direction:ASC}){nodes{title openIssues:issues(states:OPEN){totalCount} closedIssues:issues(states:CLOSED){totalCount}}}
  merged:pullRequests(states:MERGED,first:100,orderBy:{field:UPDATED_AT,direction:DESC}){nodes{number title mergedAt}}
  openIssues:issues(states:OPEN,first:100,orderBy:{field:UPDATED_AT,direction:DESC}){nodes{number title url createdAt closedAt labels(first:10){nodes{name}}}}
  recent:issues(first:100,after:$cursor,filterBy:{since:$since},orderBy:{field:UPDATED_AT,direction:DESC}){pageInfo{hasNextPage endCursor} nodes{number title url createdAt closedAt labels(first:10){nodes{name}}}}
 }}`;

interface Count {
	totalCount: number;
}
interface GhRepo {
	open: Count;
	closed: Count;
	pullRequests: Count & {
		nodes: { number: number; title: string; isDraft: boolean; headRefName: string; createdAt: string; author: { login: string } | null }[];
	};
	milestones: { nodes: { title: string; openIssues: Count; closedIssues: Count }[] };
	merged: { nodes: { number: number; title: string; mergedAt: string | null }[] };
	openIssues: { nodes: GhIssue[] };
	recent: { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: GhIssue[] };
}
interface GhIssue {
	number: number;
	title: string;
	url: string;
	createdAt: string;
	closedAt: string | null;
	labels: { nodes: { name: string }[] };
}
interface GhRun {
	id: number;
	name: string;
	display_title: string;
	head_branch: string;
	run_number: number;
	status: string;
	conclusion: string | null;
	run_started_at?: string;
	created_at: string;
	updated_at: string;
	html_url: string;
}
interface GiteaPull {
	number: number;
	title: string;
	draft?: boolean;
	head?: { ref?: string };
	user?: { login?: string };
	created_at: string;
	merged_at?: string | null;
}
interface GiteaIssue {
	number: number;
	title: string;
	html_url: string;
	state: string;
	created_at: string;
	closed_at: string | null;
	labels?: { name: string }[];
}
interface GiteaMilestone {
	title: string;
	open_issues: number;
	closed_issues: number;
}

async function collectGithub(root: string, repo: string): Promise<ForgeData> {
	const [owner, name] = repo.split("/");
	const days = dayBuckets(7);
	const since = `${days[0][0]}T00:00:00Z`;
	const created: string[] = [];
	const closed: string[] = [];
	let cursor: string | undefined;
	let first: GhRepo | undefined;
	const labeled = new Map<number, ForgeIssue>();
	const toIssue = (i: GhIssue): ForgeIssue => ({
		n: i.number,
		title: i.title,
		url: i.url,
		state: i.closedAt ? "closed" : "open",
		labels: i.labels.nodes.map(l => l.name),
		created: i.createdAt,
		...(i.closedAt ? { closed: i.closedAt } : {}),
	});
	for (let page = 0; page < 5; page++) {
		const args = ["gh", "api", "graphql", "-f", `query=${GH_QUERY}`, "-F", `owner=${owner}`, "-F", `name=${name}`, "-F", `since=${since}`];
		if (cursor) args.push("-F", `cursor=${cursor}`);
		const r = await run(args, root, 30_000);
		if (!r.ok) throw new Error(r.err.trim() || "gh api graphql failed");
		// Shape fixed by GH_QUERY; gh exits non-zero on GraphQL errors.
		const parsed = JSON.parse(r.out) as { data?: { repository?: GhRepo } };
		const repoData = parsed.data?.repository;
		if (!repoData) throw new Error(`repository ${repo} not found`);
		first ??= repoData;
		for (const n of repoData.recent.nodes) {
			created.push(n.createdAt);
			if (n.closedAt) closed.push(n.closedAt);
			if (n.labels.nodes.length) labeled.set(n.number, toIssue(n));
		}
		if (!repoData.recent.pageInfo.hasNextPage) break;
		cursor = repoData.recent.pageInfo.endCursor;
	}
	countDays(days, created, closed);
	const d = first!;
	for (const i of d.openIssues.nodes) if (i.labels.nodes.length) labeled.set(i.number, toIssue(i));
	// CI runs come from the REST API; a repo without Actions just has none.
	const runsRes = await run(["gh", "api", `repos/${repo}/actions/runs?per_page=60`], root, 30_000);
	const ghRuns = runsRes.ok ? ((JSON.parse(runsRes.out) as { workflow_runs?: GhRun[] }).workflow_runs ?? []) : [];
	const runs: CiRun[] = ghRuns.map(r => ({
		id: r.id,
		workflow: r.name,
		title: r.display_title,
		branch: r.head_branch,
		number: r.run_number,
		status: r.status,
		conclusion: r.conclusion,
		started: r.run_started_at ?? r.created_at,
		updated: r.updated_at,
		url: r.html_url,
	}));
	const list: PrRow[] = d.pullRequests.nodes.map(p => ({
		n: p.number,
		title: p.title,
		draft: p.isDraft,
		branch: p.headRefName,
		author: p.author?.login ?? "ghost",
		age_h: ageHours(p.createdAt),
	}));
	return {
		kind: "github",
		repo,
		prs: { open: d.pullRequests.totalCount, drafts: list.filter(p => p.draft).length, list },
		issues: { total: d.open.totalCount + d.closed.totalCount, open: d.open.totalCount, closed: d.closed.totalCount, days },
		milestones: d.milestones.nodes.map(m => ({ title: m.title, open: m.openIssues.totalCount, closed: m.closedIssues.totalCount })),
		fetched: new Date().toISOString(),
		runs,
		labeled: [...labeled.values()],
		merges: mergeStats(
			d.merged.nodes.filter(p => p.mergedAt).map(p => ({ t: Math.floor(Date.parse(p.mergedAt!) / 1000), pr: p.number, title: p.title })),
		),
	};
}

async function giteaGet<T>(base: string, token: string | undefined, pathAndQuery: string): Promise<{ body: T; total?: number }> {
	const res = await fetch(`${base.replace(/\/$/, "")}/api/v1${pathAndQuery}`, {
		headers: { accept: "application/json", ...(token ? { authorization: `token ${token}` } : {}) },
		signal: AbortSignal.timeout(20_000),
	});
	if (!res.ok) throw new Error(`Gitea ${pathAndQuery}: HTTP ${res.status}`);
	const total = res.headers.get("x-total-count");
	// Shape documented by the Gitea v1 API for each endpoint; callers name the type.
	const body = (await res.json()) as T;
	return { body, total: total === null ? undefined : Number(total) };
}

async function collectGitea(cfg: ForgeConfig): Promise<ForgeData> {
	if (!cfg.url || !cfg.repo) throw new Error("gitea forge needs url and repo in config.json");
	const token = process.env[cfg.tokenEnv ?? "GITEA_TOKEN"];
	const base = `/repos/${cfg.repo}`;
	const prList: PrRow[] = [];
	for (let page = 1; page <= 5; page++) {
		const { body } = await giteaGet<GiteaPull[]>(cfg.url, token, `${base}/pulls?state=open&limit=50&page=${page}`);
		for (const p of body)
			prList.push({
				n: p.number,
				title: p.title,
				draft: Boolean(p.draft) || /^(WIP|\[WIP\]|Draft)/i.test(p.title),
				branch: p.head?.ref ?? "",
				author: p.user?.login ?? "",
				age_h: ageHours(p.created_at),
			});
		if (body.length < 50) break;
	}
	const open = (await giteaGet<unknown[]>(cfg.url, token, `${base}/issues?state=open&type=issues&limit=1`)).total ?? 0;
	const closedCount = (await giteaGet<unknown[]>(cfg.url, token, `${base}/issues?state=closed&type=issues&limit=1`)).total ?? 0;
	const days = dayBuckets(7);
	const since = `${days[0][0]}T00:00:00Z`;
	const created: string[] = [];
	const closed: string[] = [];
	const labeled = new Map<number, ForgeIssue>();
	const keep = (i: GiteaIssue) => {
		if (i.labels?.length)
			labeled.set(i.number, {
				n: i.number,
				title: i.title,
				url: i.html_url,
				state: i.state === "closed" ? "closed" : "open",
				labels: i.labels.map(l => l.name),
				created: i.created_at,
				...(i.closed_at ? { closed: i.closed_at } : {}),
			});
	};
	for (let page = 1; page <= 10; page++) {
		const { body } = await giteaGet<GiteaIssue[]>(cfg.url, token, `${base}/issues?state=all&type=issues&since=${since}&limit=50&page=${page}`);
		for (const i of body) {
			created.push(i.created_at);
			if (i.closed_at) closed.push(i.closed_at);
			keep(i);
		}
		if (body.length < 50) break;
	}
	countDays(days, created, closed);
	for (const i of (await giteaGet<GiteaIssue[]>(cfg.url, token, `${base}/issues?state=open&type=issues&limit=50`)).body) keep(i);
	const ms = (await giteaGet<GiteaMilestone[]>(cfg.url, token, `${base}/milestones?state=all&limit=50`)).body;
	const mergedPulls = (await giteaGet<GiteaPull[]>(cfg.url, token, `${base}/pulls?state=closed&sort=recentupdate&limit=50`)).body;
	return {
		kind: "gitea",
		repo: cfg.repo,
		prs: { open: prList.length, drafts: prList.filter(p => p.draft).length, list: prList },
		issues: { total: open + closedCount, open, closed: closedCount, days },
		milestones: ms.map(m => ({ title: m.title, open: m.open_issues, closed: m.closed_issues })),
		merges: mergeStats(
			mergedPulls.filter(p => p.merged_at).map(p => ({ t: Math.floor(Date.parse(p.merged_at!) / 1000), pr: p.number, title: p.title })),
		),
		fetched: new Date().toISOString(),
		// Gitea Actions run listing is not used yet; CI bindings apply to GitHub.
		runs: [],
		labeled: [...labeled.values()],
	};
}

export async function collectForge(root: string, cfg: ForgeConfig): Promise<ForgeData | undefined> {
	if (cfg.type === "none") return undefined;
	if (cfg.type === "gitea") return collectGitea(cfg);
	let repo = cfg.repo;
	if (!repo) {
		const det = await detectRepo(root);
		if (!det || det.host !== "github.com") throw new Error("github forge: set forge.repo (owner/name) in config.json");
		repo = det.repo;
	}
	return collectGithub(root, repo);
}
