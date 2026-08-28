<h1 align="center">MCP-X</h1>

<p align="center">
  <strong>A multi-agent orchestrator over the Model Context Protocol</strong><br/>
  Decomposes a natural-language goal into a validated task DAG, routes each task to a specialist
  agent, executes independent work in parallel, repairs the plan when a task fails, and writes a
  durable, replayable record of everything it did — measured by its own evaluation harness.
</p>

<p align="center">
  <a href="https://github.com/SvshSingh/MCP-X/actions/workflows/ci.yml"><img src="https://github.com/SvshSingh/MCP-X/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/badge/tests-407%20passing-brightgreen" alt="407 tests passing">
  <img src="https://img.shields.io/badge/coverage-98.7%25-brightgreen" alt="98.7% statement coverage">
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
you to trust it — it shows you the real `npm run execute` output and the real evaluation report,
regenerated from the code in this repository.

## Architecture

```
User goal (natural language)
        │
        ▼
┌─────────────────┐
│    PLANNER      │  Gemini → structured Plan (Zod-validated DAG of Tasks)
│                 │  schema-error retry loop, capped at 3 attempts
└────────┬────────┘
         │ Plan { tasks[], dependsOn[] }
         ▼
┌─────────────────┐      ┌──────────────────┐
│  ORCHESTRATOR   │◄────►│    BLACKBOARD    │  append-only event log
│   + SCHEDULER   │      │                  │  state is DERIVED, never stored
└────────┬────────┘      └──────────────────┘
         │ dispatch every ready wave concurrently (Promise.allSettled)
         ▼
┌─────────────────┐
│   CLASSIFIER    │  hint → LLM → keyword fallback, in that order
└────────┬────────┘
         ▼
┌──────────────────────────────────────────┐
│  SPECIALIST AGENTS                       │
│  research · compute · publish            │  tool ownership is enforced,
│  each owns a disjoint set of MCP tools   │  not just declared
└────────┬─────────────────────────────────┘
         │ AgentResult { ok, output, tokensIn, tokensOut }
         ▼
   on failure: REPLANNER (bounded, ≤2 attempts, appends a revision)
         │
         ▼
   RunRecord → JSONL on disk → replayable with zero live calls
```

Nothing in that diagram is aspirational — every box is a module with its own test file, listed
below with its actual coverage.

## What's real, what's stubbed

| Layer | Status |
|---|---|
| Planner (goal → validated DAG, schema-repair loop) | **Real.** Calls Gemini, retries on invalid output, falls back to fixtures with zero network for tests and CI. |
| Scheduler & orchestrator (parallel dispatch, retry, blocked-subtree failure) | **Real.** Runs against hand-built and planner-generated DAGs alike. |
| Classifier (task → specialist routing) | **Real.** LLM-based with a deterministic keyword fallback; accuracy measured on a labelled set, not asserted. |
| Bounded adaptive replanning | **Real.** Enforces that completed work survives a repair and a failed task's id can never reappear. |
| Durable run records + replay | **Real.** JSONL, appended live; a finished run reconstructs from disk with no LLM client constructed. |
| Evaluation harness | **Real.** 15 golden scenarios, run 3× each, scored on completion, plan validity, capability precision/recall, step efficiency, and cross-run variance. |
| Tool execution (`addTwoNumbers`, `createPost`) | **Stubbed in the orchestrator demo and the eval harness.** The orchestration layer is what's under test; wiring specialists to call real tools mid-run is the natural next phase. |
| `createPost` posting to X/Twitter | Implemented against `twitter-api-v2`, but write access needs a paid API tier — untested against the live API for that reason. |

If a claim isn't in this table, assume it isn't built. The project's phase-by-phase build log —
[`ORCHESTRATOR_PLAN.md`](ORCHESTRATOR_PLAN.md) — has the acceptance criterion and the actual
result for every phase, including deviations from the original plan and bugs the tests caught.

## Quickstart

```bash
git clone https://github.com/SvshSingh/MCP-X.git
cd MCP-X
npm install
cp .env.example .env          # PLANNER_MODE=fixture needs no key at all
npm test                      # 407 tests, no network, no API key
```

To see it plan and execute a goal without any credentials:

```bash
PLANNER_MODE=fixture npm run execute -- "post a summary of today's top HN story to Twitter"
```

To run it against a real model, put a [Gemini API key](https://aistudio.google.com/apikey) in
`.env` and drop `PLANNER_MODE`:

```bash
npm run plan -- "check warehouse stock and notify the supplier"
```

### All commands

```bash
npm run plan -- "<goal>"          # goal -> validated task DAG
npm run execute -- "<goal>"       # plan it, then run it, with retry and replanning
npm run replay -- <runId>         # reconstruct a finished run from disk, no live calls
npm run replay                    # list runs on disk
npm run serve                     # MCP server over SSE, on :3001
npm run eval                      # 15 golden scenarios x 3 runs, fixture replay (what CI runs)
npm run eval:live                 # against the real model (quota-limited, see below)
npm test                          # 407 tests
npm run coverage                  # tests + coverage report
```

## See it work

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
| Scenario pass rate | **12/15 (80%)** |
| Task completion rate | 100% |
| Plan validity (valid DAG, first try) | 100% |
| Capability F1 | 0.96 |
| Step efficiency | 0.95 |
| Tokens (fixture replay) | 17,166 in / 9,948 out |

### The harness has now found two real bugs, in two different modules

**Round one: the planner padded trivial goals.** For *"add 2 and 3 and tell me the answer"*, an
earlier version of the planner produced three tasks, inventing a `research` step to fetch
numbers already in the prompt — because its system prompt said `"Prefer 3 to 8 tasks"`, and the
model was simply obeying it. Reproduced under two different Gemini models, which is what ruled
out the model and implicated the instruction. **Fixed**: the floor is gone, replaced with an
instruction to use as few tasks as the goal genuinely needs. `add-two-numbers` now plans as 2
tasks and passes.

**Round two: fixing that surfaced a different, unrelated gap.** All 15 golden fixtures were
re-recorded against the corrected prompt, and three *new* scenarios started failing —
`compare-suppliers`, `compliance-check`, `shipment-eta-notify`. Tracing it by running the
classifier directly against the exact task descriptions the fixed prompt now produces: it's not
the planner this time, it's the keyword classifier's vocabulary. `"Cross-reference the records
against the compliance rules to identify any breaches"` routes to `research` — because
`"identify"` is a research keyword and no compute keyword matches `"cross-reference"`.
`"Generate and distribute a compliance report"` routes to `compute` — `"generate"` is a compute
keyword, and neither `"distribute"` nor `"report"` is in the publish vocabulary. **Left
unfixed, on purpose, for the same reason as round one**: it's a distinct, separately-scoped
problem, tracked rather than chased into an open-ended tuning pass in the same sitting.

Two bugs, two different root causes, both diagnosed by tracing the actual generated output
through the actual routing code rather than guessing — that's a stronger result than a clean
15/15 would have been, and it's why the number below moved from 14 to 12 between one commit and
the next instead of climbing to a tidy 15.

<details>
<summary>Full per-scenario table (fixture replay)</summary>

| Scenario | Result | Complete | Valid DAG | Recall | Precision | Steps | Efficiency |
|---|---|---|---|---|---|---|---|
| `add-two-numbers` | pass | 100% | 100% | 100% | 100% | 2.0 / 3 | 0.50 |
| `backlog-triage` | pass | 100% | 100% | 100% | 100% | 3.0 / 6 | 1.00 |
| `compare-suppliers` | **FAIL** | 100% | 100% | 100% | 67% | 3.0 / 7 | 1.00 |
| `compliance-check` | **FAIL** | 100% | 100% | 67% | 100% | 4.0 / 8 | 1.00 |
| `expense-summary` | pass | 100% | 100% | 100% | 100% | 3.0 / 6 | 1.00 |
| `hn-summary-to-twitter` | pass | 100% | 100% | 100% | 100% | 3.0 / 8 | 1.00 |
| `incident-postmortem` | pass | 100% | 100% | 100% | 100% | 4.0 / 9 | 1.00 |
| `inventory-audit` | pass | 100% | 100% | 100% | 100% | 4.0 / 7 | 0.75 |
| `newsletter-curation` | pass | 100% | 100% | 100% | 100% | 4.0 / 9 | 1.00 |
| `price-monitor-alert` | pass | 100% | 100% | 100% | 100% | 4.0 / 8 | 1.00 |
| `release-announcement` | pass | 100% | 100% | 100% | 100% | 4.0 / 8 | 1.00 |
| `shipment-eta-notify` | **FAIL** | 100% | 100% | 67% | 100% | 3.0 / 8 | 1.00 |
| `standup-digest` | pass | 100% | 100% | 100% | 100% | 4.0 / 8 | 1.00 |
| `supplier-scorecard` | pass | 100% | 100% | 100% | 100% | 3.0 / 7 | 1.00 |
| `warehouse-restock` | pass | 100% | 100% | 100% | 100% | 3.0 / 8 | 1.00 |

Regenerate this table yourself: `npm run eval` writes it to `eval/report.md`.

</details>

### CI gates on a floor, not on 15/15

`npm run eval` runs in CI on every push and pull request. It gates on the suite's pass rate
staying at or above **80%** — today's exact result — not on every scenario passing. Demanding
100% would leave the build permanently red for the tracked classifier gap above and turn the CI
badge at the top of this file into a lie. The floor still does the one thing that matters: a
change that further degrades planning or routing drops the rate below 80% and turns CI red,
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

## Project layout

```
MCP-X/
├── src/
│   ├── kernel/
│   │   ├── schemas.ts        # Zod contracts: Task, Plan, AgentResult, Event, RunRecord
│   │   ├── planner.ts        # goal -> validated Plan, schema-repair retry loop
│   │   ├── json.ts           # recovers JSON from imperfect model output
│   │   ├── scheduler.ts      # topological readiness, parallel wave dispatch
│   │   ├── orchestrator.ts   # the execution loop: retry, blocked-subtree failure, replanning
│   │   ├── blackboard.ts     # append-only event log + derived state
│   │   ├── classifier.ts     # task -> specialist routing (hint -> LLM -> keyword)
│   │   └── replanner.ts      # bounded adaptive replanning
│   ├── agents/
│   │   └── registry.ts       # specialist definitions + enforced tool ownership
│   ├── mcp/                  # MCP server over SSE + the tool registry
│   ├── llm/                  # LlmClient interface: Gemini backend + deterministic fixtures
│   ├── observability/        # JSONL run persistence + token/cost accounting
│   └── cli/                  # plan / execute / replay entry points
├── eval/                     # golden scenarios, scoring, markdown report generator
├── fixtures/                 # recorded model completions (planner demos + eval golden set)
├── tests/                    # Vitest, mirrors src/ 1:1
├── docs/ARCHITECTURE.md      # module-by-module design rationale
└── ORCHESTRATOR_PLAN.md      # the phase-by-phase build log: criteria, results, deviations
```

## Testing & CI

```bash
npm run typecheck   # tsc --noEmit, strict mode
npm run lint        # ESLint 9, typescript-eslint
npm test            # 407 tests, zero network calls, zero API keys required
npm run coverage    # v8 coverage; core modules held to an 85% floor that fails the build
npm run eval        # 15 golden scenarios; fails the build below an 80% pass-rate floor
```

All five run on every push and pull request. Both gates **fail the build**, not just report it:
coverage is currently at 98.7% statements / 93.0% branches against an 85% floor (headroom, not
the target); the eval pass rate is pinned exactly to today's honest 80% result, so it catches a
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

- Close the classifier's keyword-coverage gap the fixed planner prompt surfaced — the three
  scenarios currently failing on capability precision/recall (`compare-suppliers`,
  `compliance-check`, `shipment-eta-notify`).
- Wire specialist agents to real tool execution end-to-end, rather than the current stubbed
  runner used to isolate orchestration from tool-call variance during evaluation.
- The optional domain reskin: swap the demo tools for a supply-chain-flavoured toy workflow.

## Origin

This began as a minimal MCP server-and-client demo — one `addTwoNumbers` tool, one `createPost`
tool, one Gemini chat loop. That code is still readable in the git history; every module above
was built by porting, testing, and then deliberately outgrowing it. Basically it started from a little fun and now I'm having more of it.
