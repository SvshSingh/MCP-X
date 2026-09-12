<h1 align="center">MCP-X</h1>

<p align="center">
  <strong>A multi-agent orchestrator over the Model Context Protocol</strong><br/>
  Decomposes a natural-language goal into a validated task DAG, routes each task to a specialist
  agent, executes independent work in parallel, repairs the plan when a task fails, and writes a
  durable, replayable record of everything it did  measured by its own evaluation harness.
</p>

<p align="center">
  <a href="https://github.com/SvshSingh/MCP-X/actions/workflows/ci.yml"><img src="https://github.com/SvshSingh/MCP-X/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/badge/tests-492%20passing-brightgreen" alt="492 tests passing">
  <img src="https://img.shields.io/badge/coverage-98.9%25-brightgreen" alt="98.9% statement coverage">
  <img src="https://img.shields.io/badge/node-20%2B-339933?logo=node.js&logoColor=white" alt="Node 20+">
  <img src="https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white" alt="TypeScript strict">
</p>

---

## What this is

MCP-X started as a minimal demo: one LLM, one flat list of MCP tools, one turn at a time. This
is what it became — an orchestrator built around a simple thesis: **a single model context
holding every tool doesn't scale, and neither does trusting an LLM's output without validating
it.** So the system is split into a planner that proposes a task graph, a scheduler that decides
what can run concurrently, specialist agents that each own a narrow slice of capability, and an
evaluator that runs the whole pipeline dozens of times and reports where it actually breaks.

Every one of those claims is backed by a test. This README doesn't show you a demo GIF and ask
you to trust it — it shows you real `npm run demo` output and the real evaluation report,
regenerated from the code in this repository.

## Architecture

```
User goal (natural language)
        │
        ▼
┌─────────────────┐
│    PLANNER      │  Gemini → Zod-validated DAG; every task binds a real tool,
│                 │  and each tool's data inputs must come from a direct dependency.
└────────┬────────┘  Any defect goes back to the model as a correction (≤3 attempts).
         │ Plan { tasks[ {tool, dependsOn} ] }
         ▼
┌─────────────────┐      ┌──────────────────┐
│  ORCHESTRATOR   │◄────►│    BLACKBOARD    │  append-only event log
│   + SCHEDULER   │      │                  │  state is DERIVED, never stored
└────────┬────────┘      └──────────────────┘
         │ dispatch every ready wave concurrently (Promise.allSettled)
         ▼
┌─────────────────┐
│   ROUTING       │  bound tool → its owner; otherwise hint → LLM → keyword
└────────┬────────┘
         ▼
┌──────────────────────────────────────────┐
│  SPECIALIST AGENTS                       │
│  research · compute · publish            │  a specialist can only invoke
│  each owns a disjoint set of MCP tools   │  the tools it owns
└────────┬─────────────────────────────────┘
         │ AgentResult { ok, output, data (structured), tokensIn, tokensOut }
         │ data flows into dependent tasks as their input
         ▼
   on failure: REPLANNER (bounded, ≤2 repairs, appends a revision)
         │
         ▼
   RunRecord → JSONL on disk → replayable with zero live calls → HTML report
```

Nothing in that diagram is aspirational — every box is a module with its own test file.

## What's real, what's stubbed

| Layer | Status |
|---|---|
| Planner (goal → validated, tool-bound DAG, schema-repair loop) | **Real.** Calls Gemini, retries on invalid output or mis-wired tool dependencies, falls back to recorded model output with zero network for tests, CI and the offline demo. |
| Scheduler & orchestrator (parallel dispatch, retry, blocked-subtree failure) | **Real.** |
| Routing (task → specialist) | **Real.** A task bound to a tool goes to that tool's owner. Unbound tasks use an LLM classifier with a deterministic keyword fallback whose accuracy is measured on a labelled set. |
| Tool execution — supply-chain workflow | **Real.** Six MCP tools do actual work against a local warehouse dataset: order-up-to reorder quantities, compliance rules (supplier hold, HAZMAT, cold chain, approval limit), purchase orders written to a local outbox. Each tool's structured output is passed to the tasks that depend on it. |
| Bounded adaptive replanning | **Real.** Enforces that completed work survives a repair and a failed task's id can never reappear. |
| Durable run records, replay, HTML report | **Real.** JSONL appended live; a finished run reconstructs from disk with no LLM client constructed. |
| MCP exposure | **Real.** Every tool is served over MCP/SSE and callable by any MCP client — covered by an end-to-end test using the official SDK client. |
| Evaluation harness | **Real.** 15 golden scenarios, run 3× each, scored on completion, plan validity, capability precision/recall, step efficiency and cross-run variance. |
| Side effects | **Deliberately local.** Purchase orders are files in `demo/outbox/`; nothing is emailed and no real ERP or supplier API is called. Swapping one in means implementing the same tool contract. |
| Tool execution — the original HN/`createPost` demo and the eval harness | **Stubbed.** Those exercise planning and orchestration; `createPost` is implemented against `twitter-api-v2` but untested live because write access needs a paid API tier. |

If a claim isn't in this table, assume it isn't built. The phase-by-phase build log —
[`ORCHESTRATOR_PLAN.md`](ORCHESTRATOR_PLAN.md) — has the acceptance criterion and the actual
result for every phase, including deviations from the original plan and bugs the tests caught.

## Quickstart

```bash
git clone https://github.com/SvshSingh/MCP-X.git
cd MCP-X
npm install
npm run doctor      # checks the environment and dry-runs the demo end to end
npm run demo        # the full workflow, offline: no API key, no network
```

That's it — no `.env` needed. `npm run demo` replays the model's recorded answers, runs every
tool for real, prints the run as it happens, and opens an HTML report in your browser.

```bash
npm run demo:fail   # a supplier portal goes down; watch the run repair itself
npm run mcp:demo    # a real MCP client lists the tools and drives the workflow over SSE
npm run eval        # the 15-scenario evaluation suite CI runs
```

To use the live model, put a [Gemini API key](https://aistudio.google.com/apikey) in `.env`
(copy `.env.example`), then:

```bash
npm run demo:live -- --fail
```

Presenting it to someone? [`DEMO.md`](DEMO.md) is a timed walkthrough with talking points,
likely questions and fixes for anything that goes wrong on a call.

### All commands

Every command works as typed in PowerShell, cmd and bash.

```bash
npm run demo                      # supply-chain run, offline replay, opens the HTML report
npm run demo:fail                 # same, with a supplier portal down -> replan
npm run demo:live                 # plan against the live model (add -- --fail, -- --model <name>)
npm run demo:record               # live run whose model answers become the offline fixtures
npm run demo:reset                # clear demo/outbox and runs
npm run doctor                    # pre-flight check; add -- --live to test API quota
npm run mcp:demo                  # MCP server + real SDK client, one terminal
npm run serve                     # MCP server over SSE on :3001, for your own client
npm run plan -- "<goal>"          # goal -> validated task DAG
npm run execute -- "<goal>"       # plan and run a free-form goal with stubbed agents
npm run replay -- <runId>         # reconstruct a finished run from disk, no live calls
npm run eval                      # 15 golden scenarios x 3 runs, fixture replay (what CI runs)
npm run eval:live                 # against the real model (quota-limited)
npm test                          # 492 tests
npm run coverage                  # tests + coverage report
```

`plan`, `execute` and `eval` read `PLANNER_MODE=fixture` from `.env` to run offline; in
PowerShell a one-off override is `$env:PLANNER_MODE="fixture"; npm run execute -- "<goal>"`.

## See it work

A pharmaceutical distribution centre needs restocking. The goal is one sentence; everything
after it is the system. This is the run where a supplier's ordering portal is down, because it
shows the most — real output from `npm run demo:fail`, with no API key and no network:

```
────────────────────────────────────────────────────────────────────────
MCP-X  ·  multi-agent supply-chain orchestration
────────────────────────────────────────────────────────────────────────
Goal      Check warehouse stock levels, work out reorder quantities, make sure every order is compliant, and notify the suppliers
Planner   recorded model output (offline replay: no API key, no network)
Scenario  SUP-NOVA's ordering portal is DOWN

1  PLAN  valid DAG on attempt 1 · 5 tasks · 4 waves
   wave 1  check_inventory        → research
   wave 2  lookup_suppliers       → research ┐ in parallel
           compute_reorder_qty    → compute  ┘
   wave 3  validate_compliance    → compute
   wave 4  notify_supplier        → publish

2  EXECUTE
   ▶ check_inventory on research
     ✓ 6 of 8 SKUs at or below reorder point: AMX-500, INS-GLA, ETH-70, SYR-5ML, MAB-100, ORS-21 1ms
   ▶ lookup_suppliers on research
   ▶ compute_reorder_qty on compute
     ✓ Found 3 supplier record(s): SUP-ACME (active), SUP-NOVA (active), SUP-ORBIT (on_hold) 30ms
     ✓ 6 order line(s), $17,376.00 total: AMX-500 x800, INS-GLA x100, ETH-70 x60, SYR-5ML x2000, MAB-100 x30, ORS-21 x200 30ms
   ▶ validate_compliance on compute
     ✓ 3 line(s) approved ($2,664.00), 3 breach(es): ETH-70 hazmat_certification, SYR-5ML supplier_on_hold, MAB-100 approval_threshold 1ms
   ▶ notify_supplier on publish
     ✗ Supplier portal unreachable for SUP-NOVA; no purchase orders were sent 0ms
     ↻ retrying
   ▶ notify_supplier on publish · attempt 2
     ✗ Supplier portal unreachable for SUP-NOVA; no purchase orders were sent 0ms

   ⟲ REPLAN  revision 0 → 1
     Direct supplier portal notification failed due to connection issues with SUP-NOVA, so purchase orders are now queued for manual buyer review.
     new route: check_inventory → lookup_suppliers → compute_reorder_qty → validate_compliance → queue_manual_review
     completed tasks are kept and not re-run

   ▶ queue_manual_review on publish
     ✓ Queued 3 line(s) and 3 breach(es) for manual review 3ms

3  RESULT
   Reorder lines
   AMX-500       800 units      $144.00  SUP-NOVA   approved
   INS-GLA       100 units    $2,450.00  SUP-ACME   approved
   ETH-70         60 units      $192.00  SUP-NOVA   held: hazmat certification
   SYR-5ML      2000 units      $120.00  SUP-ORBIT  held: supplier on hold
   MAB-100        30 units   $14,400.00  SUP-ACME   held: approval threshold
   ORS-21        200 units       $70.00  SUP-NOVA   approved

   Queued for manual review demo\outbox\run-mtz0mxdv\manual-review.md

────────────────────────────────────────────────────────────────────────
SUCCEEDED  run-mtz0mxdv · 0.08s · 17 events · 2 plan revision(s) · 2589 tokens
   Report   runs\run-mtz0mxdv.html
   Outbox   demo\outbox\run-mtz0mxdv
   Replay   npm run replay -- run-mtz0mxdv
────────────────────────────────────────────────────────────────────────
```

What to notice:

- **The model chose the tools and the order; the runtime checked it.** Every task names a real
  tool. `compute_reorder_qty` consumes inventory data, so the plan is rejected and repaired
  unless that task depends directly on `check_inventory` — caught before anything runs.
- **Wave 2 is genuinely concurrent.** Both tasks start before either finishes.
- **The numbers are computed, not narrated.** Order-up-to quantities from demand, lead time,
  review period and safety stock, rounded up to case packs; three lines held back by rules a
  pharmaceutical distributor actually has.
- **The send is all-or-nothing, and the repair keeps finished work.** Nothing was half-sent, and
  only the new `queue_manual_review` task ran after the replan.
- **Routing is by tool ownership.** Only `publish` owns the tools that write anything; a compute
  task physically cannot reach them.

`npm run demo` (without `:fail`) runs the same plan to completion and writes two purchase orders.
Both commands open a self-contained HTML report of the run: the plan as waves, every revision,
each order line's compliance decision, and the full event log.

The offline answers are not hand-written. `npm run demo:record` ran the live model, and a
recording client saved exactly what it said; the demo replays it while everything else —
scheduling, routing, tools, compliance, files, replanning — runs for real.

<details>
<summary>The original free-form demo: <code>npm run execute</code> with stubbed agents</summary>

A goal that decomposes into a parallel branch, executed against recorded fixtures (no API
key, no network — this is exactly what `npm test` and CI exercise):

```
$ PLANNER_MODE=fixture npm run execute -- "post a summary of today's top HN story to Twitter"

[run-mtdiq2in] Plan: 6 tasks in 5 wave(s)
[run-mtdiq2in]   wave 1: fetch_top_story
[run-mtdiq2in]   wave 2: fetch_story_content, fetch_story_comments  <- 2 in parallel
[run-mtdiq2in]   wave 3: summarise_story
[run-mtdiq2in]   wave 4: compose_tweet
[run-mtdiq2in]   wave 5: publish_tweet

[run-mtdiq2in]   -> fetch_top_story [research] attempt 1
[run-mtdiq2in]   -> fetch_story_content [research] attempt 1
[run-mtdiq2in]   -> fetch_story_comments [research] attempt 1
[run-mtdiq2in]   -> summarise_story [compute] attempt 1
[run-mtdiq2in]   -> compose_tweet [compute] attempt 1
[run-mtdiq2in]   -> publish_tweet [publish] attempt 1

[run-mtdiq2in] Result:
[run-mtdiq2in]   OK    fetch_top_story
[run-mtdiq2in]   OK    fetch_story_content
[run-mtdiq2in]   OK    fetch_story_comments
[run-mtdiq2in]   OK    summarise_story
[run-mtdiq2in]   OK    compose_tweet
[run-mtdiq2in]   OK    publish_tweet

[run-mtdiq2in] Run succeeded in 251ms, 14 events, 652 in / 337 out (412/187 planning) unpriced
[run-mtdiq2in] Saved to runs\run-mtdiq2in.jsonl   replay with: npm run replay -- run-mtdiq2in
```

Every line is tagged `[run-mtdiq2in]` — that's the structured logging Phase 8 added, so output
from two runs interleaved in one terminal or CI job is never ambiguous about which run produced
which line.

Now force a mid-plan tool failure. Watch the sibling branch complete anyway, the failing task
retry once, and — because a replanner is wired in — the run repair itself and finish via an
alternate route instead of ending in a blocked subtree:

```
$ FAIL_TASK=fetch_story_content PLANNER_MODE=fixture \
  npm run execute -- "post a summary of today's top HN story to Twitter"

[run-mtdiqfkc]   -> fetch_top_story [research] attempt 1
[run-mtdiqfkc]   -> fetch_story_content [research] attempt 1
[run-mtdiqfkc]   -> fetch_story_comments [research] attempt 1
[run-mtdiqfkc]   -> fetch_story_content [research] attempt 2

[run-mtdiqfkc]   ** replan: revision 0 -> 1 (failure)
[run-mtdiqfkc]      The article URL could not be fetched directly, so the alternate route reads the cached copy instead.

[run-mtdiqfkc]   -> fetch_story_from_cache [research] attempt 1
[run-mtdiqfkc]   -> summarise_story_v2 [compute] attempt 1
[run-mtdiqfkc]   -> compose_tweet_v2 [compute] attempt 1
[run-mtdiqfkc]   -> publish_tweet_v2 [publish] attempt 1

[run-mtdiqfkc] Result (revision 1 of 1):
[run-mtdiqfkc]   OK    fetch_top_story
[run-mtdiqfkc]   OK    fetch_story_comments
[run-mtdiqfkc]   OK    fetch_story_from_cache
[run-mtdiqfkc]   OK    summarise_story_v2
[run-mtdiqfkc]   OK    compose_tweet_v2
[run-mtdiqfkc]   OK    publish_tweet_v2

[run-mtdiqfkc] Run succeeded in 362ms, 19 events, 1172 in / 577 out (932/427 planning) unpriced
```

`fetch_top_story` and `fetch_story_comments` were **not** re-executed after the repair — their
results carried forward from the first revision. That's not incidental: it's an invariant the
replanner enforces on every proposed revision (see [Design notes](#design-notes)).

</details>

## Evaluation harness

This is the part most "I built an agent" projects skip, and the part the target role's JD
actually asks for: **validating** a non-deterministic system, not just building one.

`npm run eval` runs 15 golden scenarios, three times each, and scores every run on task
completion, whether the planner produced a valid DAG on the first attempt, precision/recall of
the specialist capabilities it routed to, how close the plan came to the fewest tasks the goal
genuinely needs, and — in live mode — whether repeated runs of the same goal agree on shape.

Current result, regenerated from this commit:

| Metric | Value |
|---|---|
| Scenario pass rate | **14/15 (93%)** |
| Task completion rate | 100% |
| Plan validity (valid DAG, first try) | 100% |
| Capability F1 | 0.99 |
| Step efficiency | 0.98 |
| Tokens (fixture replay) | 22,881 in / 8,598 out |

### The harness has found three real bugs so far, in three different modules

**The planner padded trivial goals.** Its prompt said `"Prefer 3 to 8 tasks"`, so *"add 2 and 3"*
came back as three tasks including an invented `research` step to fetch numbers already in the
prompt. The model was obeying instructions. **Fixed** — that goal now plans as a single task.

**The planner invented side effects.** For goals asking only for analysis it still appended a
delivery step nobody requested: `publish_ranked_list` for *"rank them by severity"*,
`publish_department_summary` for *"calculate the total per department"*. That is more than a
metric problem — an orchestrator that spontaneously adds a publishing step is spontaneously
adding a side effect, which is the exact thing the specialist split exists to make deliberate.
**Fixed**: a goal that asks to compare, rank, calculate, audit or summarise is finished once the
analysis exists, and returning the answer to the user is explicitly not publishing.

**Two of those bugs were cancelling each other out.** Four *passing* scenarios passed for the
wrong reason: the planner added a phantom `publish_*` task, and the keyword classifier
mis-routed it to `compute`, which happened to match the expectation. Fixing only the classifier
would have dropped the suite to **9/15** by exposing the planner over-reach underneath — measured
with a diagnostic before any fix was committed, not discovered afterwards.

<details>
<summary>Full per-scenario table (fixture replay)</summary>

| Scenario | Result | Complete | Valid DAG | Recall | Precision | Steps | Efficiency |
|---|---|---|---|---|---|---|---|
| `add-two-numbers` | pass | 100% | 100% | 100% | 100% | 1.0 / 3 | 1.00 |
| `backlog-triage` | pass | 100% | 100% | 100% | 100% | 3.0 / 6 | 1.00 |
| `compare-suppliers` | pass | 100% | 100% | 100% | 100% | 3.0 / 7 | 1.00 |
| `compliance-check` | pass | 100% | 100% | 100% | 100% | 3.0 / 8 | 1.00 |
| `expense-summary` | pass | 100% | 100% | 100% | 100% | 2.0 / 6 | 1.00 |
| `hn-summary-to-twitter` | pass | 100% | 100% | 100% | 100% | 3.0 / 8 | 1.00 |
| `incident-postmortem` | pass | 100% | 100% | 100% | 100% | 3.0 / 9 | 1.00 |
| `inventory-audit` | pass | 100% | 100% | 100% | 100% | 4.0 / 7 | 0.75 |
| `newsletter-curation` | **FAIL** | 100% | 100% | 67% | 100% | 3.0 / 9 | 1.00 |
| `price-monitor-alert` | pass | 100% | 100% | 100% | 100% | 4.0 / 8 | 1.00 |
| `release-announcement` | pass | 100% | 100% | 100% | 100% | 4.0 / 8 | 1.00 |
| `shipment-eta-notify` | pass | 100% | 100% | 100% | 100% | 3.0 / 8 | 1.00 |
| `standup-digest` | pass | 100% | 100% | 100% | 100% | 4.0 / 8 | 1.00 |
| `supplier-scorecard` | pass | 100% | 100% | 100% | 100% | 3.0 / 7 | 1.00 |
| `warehouse-restock` | pass | 100% | 100% | 100% | 100% | 3.0 / 8 | 1.00 |

Regenerate this table yourself: `npm run eval` writes it to `eval/report.md`.

</details>

### The one remaining failure is a ceiling, not an oversight

`newsletter-curation`'s last task is *"Format the summaries into a newsletter and publish it to
the designated platform"* — a single sentence that genuinely does both, scoring `format`
(compute) and `publish` (publish) exactly 1–1. Bag-of-words keyword scoring cannot resolve that.

Two principled tie-break rules were tried and **reverted**, each disproved by a counter-example
already in the test suite:

- *Break ties toward the side-effecting agent.* Reasonable — a task that drafts **and** sends must
  route to whoever owns sending. But `"Check that the post arrived"` ties research against
  publish because "post" is a **noun** there, and the rule would hand `createPost` to a task that
  only reads. Withholding a capability makes a task fail loudly; granting one it shouldn't have
  fails silently, so ties should break toward *lower* privilege.
- *Treat the task id's leading token as the primary verb.* Fixes `publish_newsletter`, breaks
  `post_process_results` — same unsafe direction.

Resolving this correctly is the LLM classifier's job. The suite disables it by default only
because it costs one call per task against a 20-request-per-day free tier.

### CI gates on a floor, not on 15/15

`npm run eval` runs in CI on every push and pull request. It gates on the suite's pass rate
staying at or above **93%** — today's exact result — not on every scenario passing. Demanding
100% would leave the build permanently red for the tracked classifier gap above and turn the CI
badge at the top of this file into a lie. The floor still does the one thing that matters: a
change that further degrades planning or routing drops the rate below 93% and turns CI red,
while a change that doesn't regress anything never will. That claim isn't just asserted — there's
a test that builds a synthetic two-scenario suite, shows it passing at the default floor, then
shows the identical result failing once the floor is raised to 100%, so "it passes" isn't a
tautology.

### Why variance is reported as "unmeasurable," not "zero"

Fixture mode replays a recorded completion, so every one of the three repeats per scenario is
byte-identical by construction. Reporting "0% unstable" from that would describe the replay
mechanism, not the model. The harness says so explicitly instead:

> **Variance was not measured in this run.** Planner responses were replayed from recorded
> fixtures... Run `npm run eval:live` to measure real cross-run variance.

Against the real API, three separate runs of the same goal did produce different task ids on
every run — `post_to_twitter`, `post_summary_to_twitter`, `post_tweet` — while keeping the exact
same graph shape and capability sequence each time. That's why the harness's structural
signature deliberately **excludes task ids**: scoring on them would report the model's love of
synonyms as instability.

**A hard constraint worth knowing about:** Google's free tier caps `generate_content` at 20
requests per day, per model. A full live suite is 45 planning calls before routing even starts,
so `npm run eval:live` defaults to keyword-only routing and supports `EVAL_ONLY=id1,id2` to
scope a run to what the day's quota allows.

## Design notes

A few decisions worth calling out, because they're the parts that would be easy to get wrong
and weren't obviously right the first time:

**State is derived from an append-only event log, never stored beside it.** Task status, retry
counts, and token totals are all recomputed from the events on every orchestrator iteration. The
payoff: replaying a finished run from disk uses the *exact same function* the live orchestrator
used, so a replay can never disagree with the run it's replaying — it isn't a second
implementation that could drift.

**A plan is a validated DAG, not a list.** An LLM will cheerfully emit a cyclic dependency graph
or a task that references an id that doesn't exist. The `Plan` schema catches every structural
defect — duplicate ids, dangling references, cycles — in a *single* validation pass, so the
planner's repair loop can fix everything wrong with one model round-trip instead of one round-trip
per defect.

**A replan must keep every completed task's id, and must never reuse the failed one.** Because
state is replayed over the *current* plan, dropping a completed id silently discards its result
and redoes the work; keeping the failed task's id means its `task_failed` event replays against
the new plan and marks the "fix" failed the instant it's added. Both are enforced by the
replanner, not left as a hope.

**Tool ownership is enforced at runtime, not just declared.** Asking the `compute` specialist to
invoke `createPost` throws. Without that, "specialists" would be a naming convention, and the
actual argument for splitting them — that a read-only context can never trigger a side effect —
would rest on nothing.

**An unpriced model reports `unpriced`, never `$0.00`.** The cost-accounting rate table ships
empty on purpose. A plausible-looking number baked into source for a model whose real price
wasn't checked is worse than an honest gap, because the fake number gets trusted.

**A plan binds tools, and its data wiring is checked before anything runs.** Each tool declares
the kind of data it produces and consumes. A task whose tool consumes `inventory` must depend
*directly* on a task whose tool produces it — directly, because the runtime hands a tool only its
direct dependencies' output, so a producer two hops away would pass a looser check and still
leave the tool empty-handed at run time. A mis-wired plan goes back to the model as a specific
correction, through the same loop that repairs cycles.

**Once a plan exists, execution is deterministic.** The model decides what to do; the runtime
invokes each tool with its dependencies' structured output. That split is what lets a run be
replayed exactly, and what lets the demo run offline from recorded model output with every other
part of the system executing for real.

**Publishing is all-or-nothing.** `notify_supplier` checks every supplier's portal before sending
any order. A half-sent batch is the one outcome a replan cannot cleanly repair.

## Project layout

```
MCP-X/
|-- src/
|   |-- kernel/
|   |   |-- schemas.ts        # Zod contracts: Task (incl. bound tool), Plan, AgentResult, Event, RunRecord
|   |   |-- planner.ts        # goal -> validated Plan, schema + tool-wiring repair loop
|   |   |-- tool-catalog.ts   # tool catalog shown to the planner; plan-time data-wiring check
|   |   |-- tool-runner.ts    # executes bound tools via their owning specialist; ownership routing
|   |   |-- scheduler.ts      # topological readiness, parallel wave dispatch
|   |   |-- orchestrator.ts   # the execution loop: retry, blocked-subtree failure, replanning
|   |   |-- blackboard.ts     # append-only event log + derived state
|   |   |-- classifier.ts     # routing for unbound tasks (hint -> LLM -> keyword)
|   |   |-- replanner.ts      # bounded adaptive replanning
|   |   `-- json.ts           # recovers JSON from imperfect model output
|   |-- domain/supply-chain/  # warehouse dataset model, reorder + compliance logic, the six tools
|   |-- demo/                 # the end-to-end supply-chain run the CLI and tests both drive
|   |-- agents/registry.ts    # specialist definitions + enforced tool ownership
|   |-- mcp/                  # MCP server over SSE + the tool registry
|   |-- llm/                  # LlmClient: Gemini, deterministic fixtures, recording client
|   |-- observability/        # JSONL runs, cost accounting, run-id logging, HTML run report
|   `-- cli/                  # demo, doctor, mcp:demo, plan, execute, replay
|-- demo/warehouse.json       # the toy distribution centre the tools operate on
|-- eval/                     # golden scenarios, scoring, markdown report generator
|-- fixtures/                 # recorded model output: demo, eval golden set, planner examples
|-- tests/                    # Vitest, mirrors src/
|-- DEMO.md                   # screen-share runbook
|-- docs/ARCHITECTURE.md      # module-by-module design rationale
`-- ORCHESTRATOR_PLAN.md      # the phase-by-phase build log: criteria, results, deviations
```

## Testing & CI

```bash
npm run typecheck   # tsc --noEmit, strict mode
npm run lint        # ESLint 9, typescript-eslint
npm test            # 492 tests, zero network calls, zero API keys required
npm run coverage    # v8 coverage; core modules held to an 85% floor that fails the build
npm run eval        # 15 golden scenarios; fails the build below a 93% pass-rate floor
```

All five run on every push and pull request. Both gates **fail the build**, not just report it:
coverage is currently at 98.9% statements / 91.4% branches against an 85% floor (headroom, not
the target); the eval pass rate is pinned exactly to today's honest 93% result, so it catches a
future regression without demanding a perfection this project doesn't currently have.

Every line `npm run execute` prints is tagged `[runId]`, generated before anything else can
print — so a failure before a plan even exists is still attributable, and output from two
concurrent runs never gets silently interleaved into one anonymous stream.

## Tech stack

TypeScript (strict), Node.js 20+, Zod, the official [MCP SDK](https://modelcontextprotocol.io/),
Express + SSE for the MCP transport, Google Gemini for planning/classification/replanning,
Vitest for testing, GitHub Actions for CI.

## What's next

Tracked in detail in [`ORCHESTRATOR_PLAN.md`](ORCHESTRATOR_PLAN.md):

- Put a real integration behind the existing tool contract -- a supplier API or an ERP read --
  in place of the local dataset and outbox.
- Resolve the one remaining evaluation failure by letting the LLM classifier route the eval
  suite, rather than adding a third keyword heuristic after two were disproved.
- Add tool-bound scenarios to the evaluation suite, so planning quality *with* the tool catalog
  is measured across repeated live runs, not only demonstrated.

## Origin

This began as a minimal MCP server-and-client demo — one `addTwoNumbers` tool, one `createPost`
tool, one Gemini chat loop. That code is still readable in the git history; every module above
was built by porting, testing, and then deliberately outgrowing it. Basically it started from a little fun and now I'm having more of it.
