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

### Phase 6 — Bounded adaptive replanning ✅ DONE
- [x] On task failure, invoke replanner with the failure context and remaining tasks
- [x] Hard cap (`MAX_REPLANS=2`); append the new plan revision rather than mutating
- [x] Emit a `replan` event so the run record shows exactly what changed and why

**Done when:** a deliberately broken tool triggers exactly one replan, the run completes via an
alternate path, and both plan revisions are visible in the run record. ✅
*342 tests, 98.6% statements / 92.0% branches.*

**Two invariants fall out of event sourcing and are enforced, not hoped for.** State is derived
by replaying events over the *current* plan, so:

- A completed task keeps its result only while its id survives into the new revision. Drop the
  id and the work is silently redone. `validateRevision` rejects that.
- The failed task's id must **not** reappear. Its `task_failed` event is still in the log and
  would replay against the new plan, marking the task failed the instant it is added — an
  alternate path built on the same id could never run. Also rejected.

Both problems are fed back to the model as specific instructions ("give the alternate route a
different id"), reusing the planner's repair-loop pattern.

**A replanner that throws is reported, not swallowed.** The first cut caught the error silently
and ended the run, which is indistinguishable from having no replanner configured — precisely
the wrong thing to debug blind. `onReplanError` surfaces it.

**Fixture matching needed an explicit `match` key.** The replanner restates the goal in its
prompt, so a goal-keyed fixture captured every replan prompt for the same goal. Longest-match
ordering did not save it: the HN goal (48 chars) outranked the replan marker (40). Explicit
`match` now outranks a defaulted goal. Caught by the demo failing to replan at all.

---

### Phase 7 — Evaluation harness ✅ DONE
- [x] `eval/scenarios/*.json`: **15** golden scenarios
- [x] `eval/runner.ts`: runs every scenario N times, collects results
- [x] `eval/metrics.ts`: completion rate, plan validity rate, capability precision/recall,
      step efficiency, cross-run variance
- [x] Markdown report written to `eval/report.md` with a pass/fail summary table

**Done when:** `npm run eval` produces a report showing per-scenario pass rate across 3
repeated runs, and flags any scenario whose behaviour varies between runs. ✅
*388 tests, 98.7% statements. Suite result: **14/15 scenarios pass.***

**Deviation: capabilities, not tools.** The plan specified `expectedTools[]`. Tool execution is
still stubbed, so scoring tool calls would measure the stub rather than the system. What the
system genuinely decides is *which specialist each task is routed to*, so scenarios declare
`expectedCapabilities` and precision/recall are scored on those. Tool-level scoring becomes
meaningful once agents really invoke tools.

**Golden fixtures are recorded model output, not hand-written JSON.** A set I invented would
test the harness against my idea of what the planner does — the exact thing the harness exists
to find out. `npm run eval:record` captures real completions. Five were recorded against
`gemini-3.6-flash` and ten against `gemini-3.1-flash-lite`, because the first model's daily
quota ran out mid-recording.

**Variance is reported as unmeasurable under fixture replay.** Every repeat is identical by
construction there, so a stability figure would be an artefact of the replay. The report says
so explicitly rather than printing a flattering "0 unstable". Live mode measures it for real.

**Precision is a gate, not just a number.** Recall alone asks "did it do everything the goal
needs", which a padded plan passes trivially.

---

## The harness's first real finding

`add-two-numbers` fails, and the cause is a defect in **our own planner prompt**, not the model.

For the goal *"add 2 and 3 and tell me the answer"* the planner emits three tasks:

```
extract_operands [research]: Extract the numerical operands 2 and 3 from the prompt.
calculate_sum    [compute]:  Add the numbers 2 and 3 together to obtain the sum.
report_result    [publish]:  Format and deliver the calculated sum to the user.
```

Capability precision 50%, step efficiency 0.33. The root cause is line 45 of
`src/kernel/planner.ts`:

> `- Prefer 3 to 8 tasks.`

The model is obeying instructions, inventing a `research` step to reach the floor of three. The
same failure reproduces under both `gemini-3.6-flash` (recorded) and `gemini-3.1-flash-lite`
(live), which is what rules out the model and implicates the prompt.

**Left unfixed deliberately, for now.** Changing the prompt invalidates all 15 recorded
fixtures, and re-recording needs quota that is exhausted for today. The fix is to replace the
floor with "use as few tasks as the goal genuinely needs", then re-record. Tracked as the first
item for Phase 8.

> **Resolved in Phase 8.** `add-two-numbers` now plans as 2 tasks instead of 3, with no
> invented step, and passes. Fixing it surfaced three *different* scenarios failing for an
> unrelated reason — the classifier's keyword vocabulary, not the planner. See Phase 8 below.

## Free-tier quota is the binding constraint on live evaluation

`generativelanguage.googleapis.com/generate_content_free_tier_requests` is capped at **20
requests per day, per model**. A full live suite (15 scenarios × 3 repeats) is 45 planning
calls before any routing, so it cannot run on the free tier. Consequences:

- Fixture replay is the default and is what CI runs.
- Live mode defaults to *keyword* routing; LLM routing costs a call per task and would multiply
  the suite into the hundreds of calls. `EVAL_ROUTING=llm` opts in.
- `EVAL_ONLY=id1,id2` restricts the suite, which is how the live variance check above was run
  within quota.

This also exposed a real bug: the retry loop treated the quota 429 as retryable and burned three
attempts on an error no backoff could clear. `isDailyQuotaExhausted` now fails it fast.

---

### Phase 8 — CI + observability ✅ DONE
- [x] Add `npm run eval` (fixture mode) to the GitHub Actions matrix
- [x] Fail the build if completion rate drops below a threshold
- [x] Structured logging with a `runId` on every line

**Done when:** a PR that degrades agent behaviour turns CI red. ✅
*407 tests, 98.7% statements / 93.0% branches.*

**Fixed the padding bug carried over from Phase 7.** The planner prompt's `"Prefer 3 to 8
tasks"` floor was replaced with an instruction to use as few tasks as the goal genuinely
needs, and never invent one merely to pad the count. Verified live: *"add 2 and 3 and tell
me the answer"* now plans as 2 tasks instead of 3, with no invented `research` step. All 15
golden fixtures were re-recorded against the corrected prompt — 13 against `gemini-3.6-flash`,
2 against `gemini-3.1-flash-lite` after the primary model's daily quota ran out mid-recording
(same fallback pattern as Phase 7).

**Recording 15 scenarios back-to-back hit a *second*, stricter quota** the daily cap hadn't
surfaced: 5 requests per minute. `eval/record-fixtures.ts` now paces calls 13s apart
(`RECORD_DELAY_MS`) and continues past one scenario's failure instead of aborting the whole
run, so a mid-recording rate limit doesn't discard fixtures already captured.

**Fixing the padding bug surfaced three new, different failures — a real second finding,
not a regression.** `compare-suppliers`, `compliance-check` and `shipment-eta-notify` now
fail on capability precision/recall. Root cause traced with the classifier run directly
against the exact generated task descriptions: the fixed prompt produces more varied,
naturalistic phrasing ("Cross-reference... to identify any breaches", "Generate and
distribute a compliance report") than the keyword classifier's Phase 4 vocabulary anticipated.
`validate_shipments` routes to `research` because "identify" is a research keyword and no
compute keyword matches "cross-reference"; `report_breaches` routes to `compute` because
"generate" is a compute keyword and neither "distribute" nor "report" is in the publish
list. **Left unfixed on purpose, same reasoning as the original padding bug**: it is a
distinct, separately-scoped gap (classifier vocabulary, not planner prompting), tracked
rather than chased into an open-ended tuning pass in the same session. Suite result: 12/15.

**The CI gate is a pass-rate floor pinned to today's honest result (80%, i.e. 12/15), not
"every scenario must pass."** Gating on 100% would leave the build permanently red for the
tracked classifier gap above and make the CI badge lie. The floor still does exactly what
the phase asks: a change that further degrades planning or routing drops the rate below 80%
and turns CI red; a change that doesn't regress anything never will. Proven with a test suite
built on synthetic scenarios, not just asserted — including one showing the same 12/15 result
flips to failing if the floor is raised to 100%, so the "it passes" claim isn't a tautology.

**Structured logging** (`src/observability/log.ts`) tags every line `npm run execute` prints
with `[runId]`, including blank spacing lines, generated before anything else can print so a
failure before a plan even exists is still attributable.

---

## Closing the classifier gap Phase 8 left open

Phase 8 documented three scenarios failing on the keyword classifier and deferred them. Working
the problem properly moved the suite from **12/15 to 14/15** and produced a more useful result
than the number alone: two attempted fixes were tried and **reverted** after each was disproved,
which is what the remaining failure now documents.

### The planner was inventing side effects

The padding fix in Phase 8 stopped the planner over-decomposing, but not over-*reaching*: for
goals that only asked for analysis it still appended a delivery step nobody requested —
`publish_ranked_list` for "rank them by severity", `publish_department_summary` for "calculate
the total per department". That is worse than a metric problem. **An orchestrator that invents a
publishing step is inventing a side effect**, and the whole point of the specialist split is that
side effects are deliberate. The planner prompt now states that a goal asking to compare, rank,
calculate, audit, validate or summarise is finished once that analysis exists, and that returning
the answer to the user is explicitly *not* a publishing step.

Effect, measured: `add-two-numbers` went from 2 tasks to **1**, and `expense-summary` and
`compare-suppliers` stopped emitting phantom publish steps.

### Two bugs were cancelling each other out

Before this, four *passing* scenarios passed for the wrong reason. The planner added a spurious
`publish_*` task, and the classifier then mis-routed it to `compute` — which happened to match
the expectation. Fixing only the classifier would have *dropped* the suite to 9/15 by exposing
the planner over-reach underneath, which is exactly what a diagnostic run confirmed before any
fix was committed.

### Two tie-break rules, both tried, both reverted

Six of nine routing disagreements were exact score ties, resolved by whichever agent happened to
be registered first.

*Rejected: break ties toward the side-effecting agent.* Defensible in the abstract — a task that
both drafts and sends must route to whoever owns sending. But the existing labelled set contains
"Check that the post arrived", which ties research against publish because "post" appears as a
**noun**. That rule would hand `createPost` to a task that only reads. Withholding a capability
makes a task fail visibly; granting one it should not have fails silently, so the safe tie-break
is toward *lower* privilege — which is what registry order already does. Reverted, and the
reasoning is now a comment in `classifier.ts` so it is not re-attempted.

*Rejected: treat the task id's leading token as the primary verb.* Works for
`publish_newsletter`, breaks on `post_process_results`, where "post" leads a compound verb and
the rule again grants publish rights to compute work. Same unsafe direction. Not adopted.

### What was actually changed

- **Plural keyword matching.** Whole-word matching meant "email" missed "notification emails"
  and "alert" missed "price alerts" — a task routed differently for writing its noun in the
  plural. Only the regular `+s`/`+es` forms; this is not a stemmer.
- **Four genuinely missing verbs**: `cross-reference` and `reconcile` (analysis, were scoring as
  research), `list` and `tabulate` (were scoring **zero** everywhere, so `list_discrepancies`
  fell through to the default agent), and `distribute` (delivery).

### One scenario expectation was corrected, deliberately

`compliance-check` expected `research → compute → publish` for the goal *"validate this week's
shipment records against compliance rules and report any breaches"*. It now expects
`research → compute`.

This is a changed goalpost, so the reasoning is stated rather than buried: every other
publish-terminal scenario names a recipient — "email the customers", "alert the team", "publish
the newsletter". "Report any breaches" names none, so under the project's own rule that returning
the answer to the user is not a publishing step, the goal ends at analysis. The original
expectation was written in Phase 7 against padding-era output and encoded that behaviour as
correct.

### What still fails, and why it is left alone

`newsletter-curation`'s last task is *"Format the summaries into a newsletter and publish it to
the designated platform"* — one sentence that genuinely does both, scoring `format` (compute) and
`publish` (publish) exactly 1–1. Bag-of-words scoring has no way to resolve that, and both
principled tie-breaks were disproved above. This is the **documented ceiling of deterministic
keyword routing**, which is precisely why the LLM classifier exists; the suite disables it by
default only because it costs one call per task against a 20-per-day free tier.

The CI floor is raised from 80% to **93%** to lock in the gain, so the two scenarios recovered
here cannot silently regress.

**Fixtures re-recorded** against the corrected prompt — all 15 on `gemini-3.1-flash-lite` this
time, which makes the golden set *more* internally consistent than the previous 13/2 split across
two models. 407 tests, 98.7% statements.

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
