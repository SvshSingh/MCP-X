# MCP-X → Agentic Orchestrator: Build Plan

**Goal:** Evolve MCP-X from an LLM tool-calling CLI into a multi-agent orchestrator with a
planner, a scheduler, specialist agents, durable run records, and an evaluation harness.

**Why:** Target role — Agentic AI Engineer @ TraceLink (Pune, 0–2 yrs) and other junior AI
Engineer openings. Those JDs ask for multi-step agent workflows (planning, tool use,
iteration), understanding of non-deterministic LLM behavior, test automation, CI/CD, and
validation of agentic systems. The original MCP-X demonstrates tool use only. This plan closes
planning, orchestration, and validation.

**Stack:** TypeScript / Node 20+, Zod, MCP SDK, SSE, Google Gemini. Add: Vitest, GitHub Actions.

> **Correction to the original plan:** the stack was described as "unchanged from MCP-X", but
> MCP-X was plain JavaScript ESM with no build step, no tests, and Zod only as a server-side
> dependency. Phase 0 therefore includes a JS→TS migration and is closer to a full day than a
> half. The destination is unchanged.

---

## Reference architectures

| Source | What we take from it |
|---|---|
| **r331/agent-orchestrator** (primary) | Orchestration *strategies* as pluggable, separately-testable modules: role queue, event-sourced blackboard, hierarchical planner, market/bidding scheduler. Also: one test suite per strategy + an implementation playbook doc. |
| **open-multi-agent** (6.8k, TS, MCP-native) | Runtime task-DAG generation from a goal; durable run records (status, deps, token usage, tool calls) that are inspectable and replayable; checkpoint/resume; append-only plan repair. |
| **awslabs/agent-squad** (7.7k) | Classifier → Agent → Orchestrator routing. A classifier picks the specialist rather than one LLM holding every tool. SupervisorAgent for parallel sub-agent fan-out. |
| **Bambushu/sextant** (~820 LOC, TS, Zod) | Bounded adaptive replanning — rebuild the plan mid-run within a hard limit instead of failing. Small legible kernel, high test coverage, cost transparency per run. |

**Design rule:** we are not cloning any of these. We build the smallest kernel that honestly
demonstrates each pattern, with tests proving it works.

---

## Target architecture

```
User goal (natural language)
        │
        ▼
┌─────────────────┐
│    PLANNER      │  Gemini → structured Plan (Zod-validated DAG of Tasks)
└────────┬────────┘
         │ Plan { tasks[], edges[] }
         ▼
┌─────────────────┐      ┌──────────────────┐
│  ORCHESTRATOR   │◄────►│    BLACKBOARD    │  shared state, append-only event log
│   + SCHEDULER   │      │  (run record)    │
└────────┬────────┘      └──────────────────┘
         │ dispatch ready tasks (deps satisfied), in parallel
         ▼
┌─────────────────┐
│   CLASSIFIER    │  route task → best specialist agent
└────────┬────────┘
         ▼
┌──────────────────────────────────────────┐
│  SPECIALIST AGENTS (thin wrappers)       │
│  each owns a subset of MCP tools         │
└────────┬─────────────────────────────────┘
         │ results / failures
         ▼
   REPLANNER (bounded)  →  SYNTHESIZER  →  final answer + RunRecord
```

---

## Repo layout

```
MCP-X/
├── src/
│   ├── kernel/
│   │   ├── schemas.ts          # Zod: Task, Plan, AgentResult, RunRecord, Event
│   │   ├── planner.ts          # goal → Plan (DAG)
│   │   ├── orchestrator.ts     # execution loop
│   │   ├── scheduler.ts        # topological + parallel dispatch
│   │   ├── classifier.ts       # task → agent routing
│   │   ├── replanner.ts        # bounded adaptive replanning
│   │   └── blackboard.ts       # shared state + append-only event log
│   ├── agents/
│   │   ├── registry.ts         # agent → capabilities/tools manifest
│   │   └── specialists/        # one file per specialist agent
│   ├── mcp/                    # EXISTING MCP server + tool defs (ported from server/)
│   ├── llm/                    # Gemini client, retry, token accounting (from client/)
│   └── observability/
│       ├── runlog.ts           # persist RunRecord to disk (JSONL)
│       └── cost.ts             # token + $ per run
├── eval/
│   ├── scenarios/              # golden dataset: goal + expected outcome
│   ├── runner.ts               # execute all scenarios, score, report
│   └── metrics.ts              # completion rate, step accuracy, tool precision
├── tests/                      # Vitest, mirrors src/
└── docs/
    ├── ARCHITECTURE.md
    └── IMPLEMENTATION_PLAYBOOK.md
```

---

## Phases

### Phase 0 — Scaffolding ✅ DONE
- [x] TypeScript `strict: true`; path aliases (`@kernel/*`, `@agents/*`, `@llm/*`, `@mcp/*`, `@obs/*`)
- [x] Vitest + coverage (`v8`), threshold enforced at ≥85% on `src/kernel/`
- [x] GitHub Actions: typecheck → lint → test → coverage upload
- [x] `docs/ARCHITECTURE.md` with the diagram above

**Done when:** `npm test` and CI both green on an empty kernel. ✅

---

### Phase 1 — Typed contracts ✅ DONE
Defined in `src/kernel/schemas.ts` with Zod, exporting inferred TS types:
- [x] `Task` — `{ id, description, agentHint?, dependsOn: string[], status, attempts }`
- [x] `Plan` — `{ goal, tasks: Task[], createdAt, revision }` + DAG-validity refinement
- [x] `AgentResult` — `{ taskId, ok, output?, error?, toolCalls[], tokensIn, tokensOut }`
- [x] `Event` — discriminated union: `plan_created | task_started | task_completed | task_failed | replan | run_completed`
- [x] `RunRecord` — `{ runId, goal, planRevisions[], events[], totalTokens, costUsd, finalOutput }`

**Done when:** schema unit tests pass, including rejecting a cyclic plan. ✅
*53 tests, 100% lines / 97.5% branches on `src/kernel/`.*

**Deviation:** `totalTokens` is `{ in, out }` rather than a scalar — input and output tokens
bill at different rates, so a single total cannot produce a correct cost in Phase 5.

---

### Phase 2 — Planner ✅ DONE
- [x] Port `client/index.js` → `src/llm/` (Gemini client, retry, token accounting) and
      `server/` → `src/mcp/`, converting both to TypeScript
- [x] Prompt Gemini to emit a task DAG as JSON; parse with the `Plan` schema
- [x] Retry-on-invalid-schema loop (max 3), feeding the validation error back to the model
- [x] Deterministic fixture mode (`PLANNER_MODE=fixture`) so tests never call the API

**Done when:** given "post a summary of today's top HN story to Twitter", the planner emits ≥3
tasks with correct dependencies. Tested against fixtures. ✅
*Emits 6 tasks including a parallel branch. 146 tests, 98% statements / 92% branches.*

**Notes:**
- `@google/genai` upgraded from `^0.7.0` to `2.19.0`; the response shape changed, and the
  client now uses native JSON mode (`responseMimeType`) rather than scraping fenced blocks.
- Two defects were found and fixed by the new tests: `isRetryable` ignored `LlmError.retryable`
  so retryable empty completions never retried, and `FixtureLlmClient.generate` threw
  synchronously instead of rejecting.
- `createPost` no longer builds a Twitter client at import time. Missing credentials are
  reported as a normal tool error the orchestrator can route around.

---

### Phase 3 — Scheduler + Orchestrator ✅ DONE
- [x] `scheduler.ts`: return all tasks whose `dependsOn` are complete → parallel dispatch via `Promise.allSettled`
- [x] `orchestrator.ts`: loop until all tasks terminal; write every transition to the blackboard
- [x] Failure policy: retry `n` times → mark failed → mark dependents blocked
- [x] `blackboard.ts`: append-only event log + derived state snapshot

**Done when:** a 5-task plan with 2 parallel branches executes in correct order with stubbed
agents; a forced mid-plan failure blocks only the dependent subtree. ✅
*217 tests, 97.8% statements / 91.4% branches.*

**Key decision — state is derived, never stored.** The event log is the only writable thing;
task status, attempt counts and token totals are recomputed by `deriveState` on every loop
iteration. That costs a cheap replay per wave and buys the guarantee that what the orchestrator
believes and what the record says cannot diverge. Phase 5's replay is not a second
implementation — it is this same function applied to events read off disk.

**`blocked` is computed, not recorded.** There is no `task_blocked` event. A task is blocked
when any dependency failed terminally or is itself blocked, resolved by a fixpoint pass so a
failure three levels up still blocks the entire subtree beneath it.

**Added `npm run execute`** to demonstrate the loop end-to-end against a planner-generated DAG.
`FAIL_TASK=<id>` forces a failure so the blocked-subtree policy is visible without breaking a
real tool.

**Note:** `AgentRunner` returns the *input* shape of `AgentResult`, not the parsed one. The
orchestrator parses every result anyway, and requiring agents to spell out `toolCalls: []` and
zeroed token counts just to report success was friction with no benefit. Caught by typecheck
while the tests were already passing.

---

### Phase 4 — Classifier + specialist agents ✅ DONE
- [x] `registry.ts`: each agent declares `{ name, description, capability, tools[], keywords[] }`
- [x] `classifier.ts`: given a `Task` + registry, pick the agent (LLM-based, with a keyword fallback for determinism in tests)
- [x] Refactor MCP-X tools into 3 specialists: `research`, `compute`, `publish`

**Done when:** each task routes to the right specialist; classifier accuracy measured on a
fixed set of 20 labelled tasks. ✅
*Keyword classifier: **18/20 = 90%** (research 6/7, compute 6/7, publish 6/6). 267 tests,
98.3% statements / 91.9% branches.*

**The labelled set is deliberately adversarial.** Two of the twenty have surface vocabulary
pointing the wrong way — `extract_publish_date` (reads data, contains "publish") and
`post_process_results` ("post-process" is not posting). Both are the misroutes. Without them
the score would be a tautology: keywords I wrote, graded against tasks I wrote. A test asserts
*which* two fail, so "fixing" them by over-fitting keywords has to edit that expectation
explicitly.

**Ownership is enforced, not documented.** `SpecialistAgent.invoke` throws if asked for a tool
the agent does not declare. Without that, "specialists" would be a naming convention and a
read-only context could still reach a side-effecting tool. A test asserts every tool has
exactly one owner and that no non-publish agent holds a publish tool.

**An LLM answer naming an unregistered agent is discarded**, and keyword routing stands in. A
classifier that can invent a destination is worse than one that is occasionally wrong, because
the orchestrator would dispatch into nothing.

**`Classifier` is now allowed to be async.** Keyword routing is synchronous but LLM routing is
not, and Phase 6's replanning can introduce tasks mid-run that have never been routed —
pre-classifying the plan up front would not cover that.

---

### Phase 5 — Run records + replay ✅ DONE
- [x] Persist `RunRecord` as JSONL under `runs/<runId>.jsonl`
- [x] `npm run replay -- <runId>` reconstructs the full timeline from events
- [x] Token + cost accounting per task and per run

**Done when:** any completed run can be fully reconstructed from disk with no live LLM calls. ✅
*312 tests, 98.6% statements / 92.6% branches. `runlog.ts` and `cost.ts` both 100% lines.*

**Replay is not a second implementation.** It calls the same `deriveState` the orchestrator
used while running, so the two cannot drift. A test asserts the reconstructed state map is
identical to the live one, not merely equivalent.

**An unknown price is reported as unknown, never as zero.** `DEFAULT_RATES` ships empty on
purpose: model pricing changes and is not something to guess at. A run on an unpriced model
reports `unpriced` rather than `$0.00`, because a cost report that quietly under-reports is
worse than none — it gets trusted. Set `LLM_PRICE_IN_PER_MTOK` and `LLM_PRICE_OUT_PER_MTOK`
to price a run.

**Planner tokens were silently missing from the record.** `runPlan` summed only what tasks
consumed, so planning spend vanished. Added `priorUsage`, and the run summary now separates
task spend from overhead — a real run showed `492 in / 237 out (412/187 planning)`, i.e. most
of the cost was the planner, which the record previously did not show at all.

**JSONL is appended as the run happens, not written at the end.** A run that dies mid-flight
is exactly the one worth inspecting; a write-at-the-end format would leave nothing.
`reconstructRunRecord` therefore treats a missing summary line as a crashed run and recomputes
totals from the events rather than failing.

---

### Phase 6 — Bounded adaptive replanning (½ day)
- [ ] On task failure, invoke replanner with the failure context and remaining tasks
- [ ] Hard cap (`MAX_REPLANS=2`); append the new plan revision rather than mutating
- [ ] Emit a `replan` event so the run record shows exactly what changed and why

**Done when:** a deliberately broken tool triggers exactly one replan, the run completes via an
alternate path, and both plan revisions are visible in the run record.

---

### Phase 7 — Evaluation harness (1–1.5 days) ⭐ **the JD gap — do not skip**
- [ ] `eval/scenarios/*.json`: 12–15 golden scenarios — `{ goal, expectedTools[], expectedOutcome, maxSteps }`
- [ ] `eval/runner.ts`: run every scenario N times (non-determinism!), collect results
- [ ] `eval/metrics.ts`:
  - **task completion rate** (did it finish?)
  - **plan validity rate** (was the DAG well-formed first try?)
  - **tool precision/recall** vs expected tools
  - **step efficiency** (actual steps ÷ optimal steps)
  - **variance across runs** ← the honest non-determinism metric
- [ ] Markdown report written to `eval/report.md` with a pass/fail summary table

**Done when:** `npm run eval` produces a report showing per-scenario pass rate across 3
repeated runs, and flags any scenario whose behaviour varies between runs.

---

### Phase 8 — CI + observability (½ day)
- [ ] Add `npm run eval` (fixture mode) to the GitHub Actions matrix
- [ ] Fail the build if completion rate drops below a threshold
- [ ] Structured logging with a `runId` on every line

**Done when:** a PR that degrades agent behaviour turns CI red.

---

### Phase 9 — Domain reskin + README (½ day) — *optional, high payoff for TraceLink*
- [ ] Swap the demo tools to a supply-chain flavoured toy workflow:
      `check_inventory → compute_reorder_qty → validate_compliance → notify_supplier`
- [ ] README: architecture diagram, one animated demo GIF, eval report table, "how to run"

**Done when:** a stranger can read the README in 90 seconds and understand it's an
orchestrator, not a chatbot.

---

## Suggested cut lines

| Available time | Ship |
|---|---|
| **One weekend** | Phases 0–3 + 7 (planner, scheduler, orchestrator, eval harness) |
| **~1 week** | Phases 0–7 |
| **~10 days** | All phases including reskin + README polish |

Phase 7 is non-negotiable — it's the only phase that covers the *validation* half of the JD,
and it's what separates this from every other "I built an agent" project.

---

## Resume bullets this unlocks (write these only once the code is real)

> **MCP-X — Agentic Orchestrator** | TypeScript, Node.js, MCP, Zod, Gemini, Vitest
> - Built a multi-agent orchestrator that decomposes natural-language goals into a validated
>   task DAG, routes subtasks to specialist agents over MCP, and executes them in parallel with
>   dependency-aware scheduling and bounded adaptive replanning on failure.
> - Engineered an evaluation harness with 15 golden scenarios measuring task-completion rate,
>   tool precision, and cross-run variance in non-deterministic LLM workflows; wired into CI so
>   behavioural regressions fail the build. <N> tests, <N>% coverage.

---

## Working agreement

Work one phase per session. Each phase has a "Done when" — treat it as the acceptance test.
Do not start the next phase until the current phase's tests pass.

---

## Live-API findings (Phase 2, 2026-08-27)

Recorded from three consecutive real runs of the same goal against
`gemini-3.6-flash`. These are inputs to Phase 7's metric design.

**Structure is stable; identifiers are not.** All three runs produced 4 tasks
with an identical capability sequence (`research → research → compute →
publish`) and identical dependency shape. Task ids differed on every run:
`fetch_hn_top_story` vs `fetch_top_hn_story`, `generate_tweet_summary` vs
`summarize_story`, `post_to_twitter` vs `post_summary_to_twitter` vs
`post_tweet`.

*Consequence:* eval scoring must compare graph shape and capability sequence.
Any metric keyed on task id will report variance that is pure noise.

**Output token count varies slightly** (270 / 252 / 253 for identical input at
temperature 0) while input tokens are constant at 321. Cost per run is
therefore a distribution, not a number — Phase 5 should record actuals rather
than estimate from a fixed rate.

**The live model returns a linear chain, not a parallel branch.** The
`hn-summary-to-twitter` fixture is deliberately a diamond, so it is *more*
demanding than observed reality. The "exposes a parallel branch" test therefore
validates the scheduler's requirement, not the planner's behaviour. Phase 7
should measure how often real plans contain exploitable parallelism.

> **Revised in Phase 4.** This does not generalise. The goal *"check warehouse
> stock, work out reorder amounts, and notify the supplier"* produced a genuine
> parallel branch on the first live attempt (`fetch_inventory_data` and
> `fetch_reorder_rules` in one wave). Whether a plan contains exploitable
> parallelism appears to depend on the goal, not on a general preference of the
> model for chains — which makes it a per-scenario metric in Phase 7, not a
> single global rate.

**Models retire without warning.** `gemini-2.0-flash` and `gemini-2.5-flash`
both 404 for new users as of this date. Pinning is still correct (an alias
would corrupt variance measurement), but the pin needs periodic revisiting.
