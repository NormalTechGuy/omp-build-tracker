---
name: build-tracker
description: Use when a project has a live build tracker (.omp/tracker) or the user asks for one: drawing the system map, posting tests, issues, blockers, decisions and progress with tracker_update.
---

# Live build tracker

The owner watches a live dashboard of the work: a **system map** of what is being
built (boxes and containers, colored by state), tests running and their results,
issues found per box, the critical path, timeline, chunks, agents, PRs, trends,
decisions, environment facts and items waiting on the owner. Your omp session
already reports your status, model, last tool call and todo list automatically.
Post what only you know with `tracker_update`; read with `tracker_view`.

It works for any long-running effort, not only infrastructure: a code base
(services, packages, modules), a research programme (questions, experiments,
datasets), a migration (sources, targets, cut-over steps), a document set.

## Setup (lead agent, once)

1. `/tracker init [title]` (user) or `omp-tracker init` creates `.omp/tracker/`.
   GitHub repos are detected; Gitea needs `forge: {type: "gitea", url, repo, tokenEnv}` in `config.json`.
2. Draw the map. Boxes are `items`; a box with children is a container.
   Keep ids short and stable; reuse them in every later post.

```json
{"ops":[
 {"type":"project","headline":"Rewrite checkout: cart live on staging, payments under test.","subtitle":"build tracker"},
 {"type":"map","view":"now",
  "edge_kinds":{"api":{"color":"blue","label":"API calls"},"events":{"color":"fg","style":"dashed","label":"events"}},
  "items":[
   {"id":"platform","label":"API platform"},
   {"id":"cart","label":"Cart","parent":"platform"},
   {"id":"payments","label":"Payments","parent":"platform","sub":"Stripe + Adyen"},
   {"id":"data","label":"Data","break":true},
   {"id":"pg","label":"Postgres","parent":"data"}],
  "edges":[{"from":"cart","to":"pg","kind":"api"}]},
 {"type":"node","id":"cart","state":"live","note":"p99 41 ms on staging"},
 {"type":"area","name":"Payments","pct":40,"state":"building","note":"Adapters done; ledger next"},
 {"type":"step","step":"Payments failover drill","state":"queued","eta":"tomorrow","owner":"WP-PAY"}
]}
```

3. Optionally draw the target design: `{"type":"map","view":"future", ...}` with
   item `state` built | progress | planned | future, `ref` (issue), `desc`, and
   `now` (id of the matching now-map box, for the "See it live" link).

Layout is automatic: containers wrap their children left to right and stack
vertically on narrow screens. `break: true` starts a new row, `wide: true` takes
the full width, `flow: "column"` stacks a container's children.

## Automate first: let the server keep it current

Anything a machine can check should be wired once, not posted repeatedly. The
tracker server then updates the dashboard (and the Funnel / Cloudflare copies)
by itself, with no agent in the loop.

```json
{"ops":[
 {"type":"probe","node":"cart","name":"cart healthz","http":"https://staging.example.com/cart/healthz","expect_status":200,"every_s":60},
 {"type":"probe","node":"pg","name":"postgres port","tcp":"db.internal:5432"},
 {"type":"probe","node":"jobs","name":"queue drained","cmd":"./scripts/queue-depth --max 100","every_s":120},
 {"type":"node","id":"ci","ci":"CI@main, e2e*@main"},
 {"type":"node","id":"mobile","label":"area:mobile"},
 {"type":"area","name":"Data platform","map":"data"},
 {"type":"area","name":"Payments","milestone":"Payments v2"},
 {"type":"project","headline":"auto"}
]}
```

- `probe`: http (URL; passes on status < 400 or `expect_status`), tcp (host:port) or cmd (shell command in the project root; passes on exit 0).
  Optional `expect_text`, `every_s` (default 60), `timeout_s` (10). By default probes **set the box state**: all pass → live, any fail → blocked,
  and every pass↔fail flip is posted as a test (a failure resolves itself when the probe passes again). `drives_state: false` only records tests.
- `node` `ci`: GitHub Actions workflow globs, optionally `@branch`; each run becomes a test on the box (running → testing now).
- `node` `label`: forge issues with that label show as the box's issues (closed ones as fixed for a week).
- `area` `milestone`: % from a forge milestone, tracker chunk or todo phase with that title. `area` `map`: % = live boxes under that container.
- `project` `headline: "auto"`: the headline is composed from the data (parts live/blocked, failing tests, what is running now).

Never put secrets in probe commands or URLs; use environment variables or scripts.

## What to post, and when

| Moment | Op |
|---|---|
| A box changes state | `{"type":"node","id":"payments","state":"testing","note":"Load test at 400 rps"}` — states: live (done and working), testing, building, planned, blocked |
| You start a test, check, benchmark, migration step | `{"type":"test","node":"payments","name":"failover drill","result":"running","lane":"WP-PAY","where":"staging"}` |
| It ends | same `node` + `name`, `result` pass / fail / stopped; on failure add `why` (list, most important first) and `next` |
| You find a problem on a box | `{"type":"issue","node":"payments","what":"Webhook replay double-books refunds","status":"open","lane":"WP-PAY"}`; later `{"type":"issue","node":"payments","id":"<id>","status":"fixed","fix":"Dedup table"}` |
| Something blocks you | `{"type":"post","kind":"blocker","text":"…"}` |
| A decision or owner direction | `{"type":"post","kind":"decision","text":"…"}` |
| You need the owner | `{"type":"owner_item","key":"Approve","text":"…"}`; remove with `"remove":true` once done |
| Progress moves | `area` (pct/state), `step` (critical path), `estimate` (label, when, optional start/end dates for the timeline), `phase` (completed phase with start/end/items) |
| You learn what is actually stood up on a box | `{"type":"inventory","node":"cart","summary":"…","items":[{"what":"cart-api","detail":"3 replicas","state":"live"}]}` |
| Facts about the environment | `{"type":"fact","key":"Postgres","value":"16.4, primary + replica"}` |
| Your role or assignment | `{"type":"agent","kind":"reviewer","focus":"Review payments PRs"}` |

Rules:

- Post state changes when they happen, not on a timer. One `tracker_update` call can carry many ops.
- Use the same test `name` for the running post and the outcome; a later pass resolves an earlier failure with that name.
  A running test with no outcome after 3 h shows as "no result".
- Text is for the owner: short, factual, no jargon they did not use. Say what changed and what is next.
- Never post secrets, tokens or credentials.
- `live` means done and verified, not merely merged.

## Outside omp

Agents that are not omp sessions (Codex, Claude Code, scripts, CI) post with the CLI or HTTP:

```sh
omp-tracker post --agent ci '{"type":"test","node":"cart","name":"e2e","result":"pass"}'
omp-tracker agent --id codex-7 --name "WP7: search" --engine gpt --status running --now "re-indexing"
curl -X POST localhost:<port>/api/ops -d '{"agent":"ci","ops":[{"type":"post","kind":"note","text":"nightly green"}]}'
```
