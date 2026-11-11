# omp-build-tracker

A live build tracker for [omp](https://omp.sh): a **system map** of what is being
built, colored by state, plus a live feed of what every agent is doing to it.
It reproduces the "freerange build tracker" dashboard as a reusable omp plugin
that works for any long-running agent effort: software, infrastructure,
migrations, research.

![tabs](https://img.shields.io/badge/tabs-10-a6e22e) Overview · Map (now and future state) · Critical path ·
Chunks · Agents · PRs · Trends · Decisions · Infrastructure/Environment · Your items.

## How it works

```
omp sessions (lead + subagents) ──heartbeats──┐
tracker_update tool / omp-tracker CLI / HTTP ─┼─▶ .omp/tracker/ (files) ──watch──▶ server ──SSE──▶ browser
git (mainline) + GitHub (gh) / Gitea (REST) ──┘                                     └─▶ static export (one HTML file)
```

- **Automatic, no agent effort:** every omp session in a tracked project reports
  its status (running/idle/closed/error), model, thinking level, role, assignment,
  last tool call, latest message and todo list. Subagents are named from the task
  call and typed by agent (task, scout, reviewer…). Git and forge data (merges per
  hour, open PRs, issues opened/closed per day, milestones) are collected by the server.
- **Posted by agents** with the `tracker_update` tool: the map, box states, tests
  (running → pass/fail/stopped with why/next), issues found per box, inventory of
  what is stood up, progress areas, critical path, completed phases, estimates,
  owner items, environment facts, blockers, decisions, notes.
- **Live:** the server watches `.omp/tracker/` and pushes a fresh snapshot over
  server-sent events within ~250 ms of any change. A history point is recorded
  every 5 minutes for the Trends tab.

## Install

```sh
omp plugin install github:NormalTechGuy/omp-build-tracker   # extension + bundled skill
```

The plugin is inert in projects without a tracker: tools stay discoverable-only
and no prompt text is added. Then, inside a project: `/tracker init [title]`.

Optional `omp-tracker` CLI (needs [Bun](https://bun.sh)), for running the
dashboard without an omp session and for agents outside omp:

```sh
ln -s ~/.omp/plugins/node_modules/omp-build-tracker/src/cli.ts ~/.local/bin/omp-tracker
```

Requirements: omp. Optional: `gh` (GitHub data), Tailscale (Funnel link),
Node/`npx` (Cloudflare deploy via wrangler).

Local development: `omp plugin link /path/to/checkout`.

## Use

In omp, inside the project:

```
/tracker init [title]     create .omp/tracker/, detect GitHub, start the dashboard, open it
/tracker                  start (if needed) and open the dashboard
/tracker status           text summary
/tracker export [file]    self-contained HTML snapshot (shareable, no server)
/tracker stop             stop the server owned by this session
```

The lead session starts the server automatically (`autostart`); agents get a
short system-prompt note pointing them at `tracker_update` and the
`build-tracker` skill (`promptHint`). Ask the lead to draw the map first, e.g.
"Draw the tracker map of what we are building, then keep it updated."

Standalone (no omp session needed):

```sh
omp-tracker init --title atlas [--forge github|gitea|none] [--repo owner/name] [--url http://gitea:3000]
omp-tracker serve --open
omp-tracker demo            # seeded example at /tmp/omp-tracker-demo, served live
omp-tracker post --agent ci '{"type":"test","node":"cart","name":"e2e","result":"pass"}'
omp-tracker agent --id codex-7 --name "WP7: search" --engine gpt --status running --now "re-indexing"
omp-tracker view map
omp-tracker export tracker.html
```

Agents outside omp (Codex, Claude Code, CI) can also `POST /api/ops`
(`{"agent":"id","ops":[…]}`) and `POST /api/agent` (heartbeat) on the server.

## What updates itself

The server keeps the dashboard current from deterministic sources; agents only
wire them once (see the `build-tracker` skill):

| Source | What it drives |
|---|---|
| omp sessions (lead + subagents) | agent cards: status, model, role, assignment, last tool call, latest message, todos |
| todo lists | chunks, critical path fallback, overall % fallback |
| git mainline / forge PR merges | merges per hour, recent merges |
| GitHub (`gh`) / Gitea | open PRs, issues per day, milestones |
| `probe` ops (http / tcp / cmd, run on a schedule) | box state (all pass → live, any fail → blocked), pass↔fail tests, health checks in the side panel |
| `node` `ci` binding (`workflow[@branch]` globs) | GitHub Actions runs as tests on the box, running runs as "testing now" |
| `node` `label` binding | forge issues with the label as the box's issues |
| `area` `milestone` / `map` binding | area % from a milestone, or from live boxes under a map container |
| `headline: "auto"` | headline composed from the data |
| Tailscale Funnel, Cloudflare | re-applied on server start; pushed on every change |
| Test / typecheck / lint commands agents run in bash (`bun test`, `pytest`, `cargo test`, `tsc --noEmit`, `eslint`, …) | posted as tests with pass/fail and the failing lines (`autoTests`) |
| Questions agents ask you (`ask` tool) | listed under "Waiting on you" until answered (`autoAsks`) |

Probe results live in `.omp/tracker/probes.json`; flips are recorded in `events.jsonl`.

### Keeping the map honest

Box states can update themselves; the map's *structure* (which boxes exist)
changes only when an agent posts it. Three things keep it from drifting:

- **End-of-run nudge** (`stopNudge`, on by default): when the lead session is
  about to finish a run that edited files or committed but posted nothing to the
  tracker, it is asked once to update it (or say nothing is affected).
- **Stale-map hint**: the lead's tracker note says when there is no map yet, or
  when the map is 12 h+ old and 5+ commits have landed since.
- **Curator** (opt-in): a cheap omp agent the tracker server runs after
  activity, at most every `curator.minMinutes` (10). It reads a digest of what
  every session did since its last run (agent status and todos, commits and
  changed files, tracker posts) and reconciles the tracker: map boxes, states,
  notes, critical path, areas, phases, blockers. It only has the tracker tools
  plus read/grep/glob, never edits the project, and does nothing when there was
  no activity.

  ```
  /tracker curator on [model]   default model: @smol (your fast role)
  /tracker curator run          run once now
  /tracker curator off | status
  ```

## Share a link (Tailscale)

```
/tracker share            public read-only link via Tailscale Funnel (same as: share funnel)
/tracker share tailnet    only your tailnet devices (full dashboard incl. write API, for remote agents)
/tracker share rotate     new link; the old one stops working
/tracker share off        stop sharing
/tracker share status
```

CLI: `omp-tracker share funnel|tailnet|off|rotate|status`, or `omp-tracker serve --share funnel`.

- **Funnel = anyone with the link can view, from anywhere.** The link is
  `https://<machine>.<tailnet>.ts.net/t-<random>/`; the random path is the key.
  Funnel traffic goes to a separate **read-only** listener (GET only, no write
  API, no export) that serves a **redacted** view: tokens, keys, bearer/basic
  auth, `password=`/`token=` values, URL credentials and private keys are
  replaced with `[redacted]`, and agent pid/host are dropped. Static exports get
  the same redaction.
- The mapping lives in tailscaled and survives restarts: the link shows an
  error while no tracker server runs and comes back when one starts (the lead
  omp session or `omp-tracker serve`).
- Funnel works per HTTPS port. If something else is already served to your
  tailnet on 443, sharing refuses rather than publishing it; set
  `share.httpsPort` to 8443 or 10000.
- One-time setup so omp can change serve config without sudo:
  `sudo tailscale set --operator=$USER`. Funnel must be allowed for the node in
  the tailnet policy (it is when `tailscale funnel` works by hand).

## Always-on copy (Cloudflare)

Funnel only works while your machine and a tracker server are up. The
Cloudflare copy keeps the last state online when they are not.

```
/tracker share cloudflare           deploy (first time) and print the link
/tracker share cloudflare rotate    new link; the old one stops working
/tracker share cloudflare off       delete the Worker and its data
/tracker share cloudflare status
```

CLI: `omp-tracker share cloudflare [on|off|rotate|status]`. One-time setup: `npx wrangler login`.

- Deploys a Worker (`omp-tracker-<title>-xxxx.<account>.workers.dev`) with the
  dashboard as static assets and a SQLite Durable Object holding the latest
  snapshot. Link: `https://…workers.dev/t-<random>/`; everything else is 404.
- The tracker server pushes the same redacted, read-only view Funnel serves,
  on change at most every `cloudflare.minIntervalSeconds` (5) and at least every
  `heartbeatSeconds` (60). Pushes need the bearer token in
  `.omp/tracker/cloudflare/secrets.json` (git-ignored, mode 600).
- Viewers poll every 8 s. When no push arrived for 3 minutes the page says
  "source offline" and keeps showing the last state.
- Free plan fits: ≤ 17k Durable Object writes/day at the 5 s minimum; each
  viewer adds ~11k requests/day of the 100k free.

## Data and configuration

`.omp/tracker/`:

| File | Content |
|---|---|
| `state.json` | curated state: map (now/future), box states, issues, inventory, areas, critical path, phases, estimates, owner items, facts, chunks |
| `events.jsonl` | append-only posts: tests, blockers, decisions, notes, op summaries (rotated at 16 MiB) |
| `agents/<session>.json` | one heartbeat file per agent session |
| `history.jsonl` | trend points |
| `config.json` | settings below |
| `server.json` | URL and pid of the running server |

`config.json`:

```json
{
  "port": 47123,
  "host": "127.0.0.1",
  "git": { "branch": "main", "disabled": false },
  "forge": { "type": "github", "repo": "owner/name" },
  "refresh": { "gitSeconds": 30, "forgeSeconds": 120, "historyMinutes": 5 },
  "windows": { "testsHours": 6, "noResultHours": 3, "blockersHours": 6, "agentsHours": 48 },
  "autostart": true,
  "promptHint": true,
  "stopNudge": true,
  "autoTests": true,
  "autoAsks": true,
  "curator": { "enabled": false, "model": "@smol", "minMinutes": 10 },
  "share": { "mode": "funnel", "path": "/t-AbC…", "httpsPort": 443 }
}
```

Gitea: `"forge": {"type": "gitea", "url": "http://localhost:3000", "repo": "owner/name", "tokenEnv": "GITEA_TOKEN"}`.
Without `port`, a stable port in 47100–47899 is derived from the tracker path.
The server binds to localhost; the write API has no authentication, so do not
bind it to a public interface.

## Map layout

Maps are defined as data, not coordinates: `items` (boxes; a box whose id is
another box's `parent` is a container) and `edges` with `edge_kinds` for color,
line style and legend. Containers wrap their children left to right, rows of
leaves stretch to fill, and the whole map re-flows to the screen width (wide on
desktop, stacked on phones). `break`, `wide` and `flow: "column"` steer it. Edge
labels that do not fit in the gap become hover titles.

Box states on the now map: live, testing, building, planned, blocked, plus
overlays for tests (count badge colored by latest result, pulsing while running),
testing now (cyan pulsing outline + count) and open issues (pink `!n`). The
future map uses built, in progress, planned, future with an issue ref and a
"See it live" link to the now map.

## Develop

```sh
bun install && bunx tsc -p .     # typecheck
omp -e . -p "…"                   # load the extension from the checkout
```

Chart.js 4.4.1 (MIT) is vendored in `web/vendor/`.
