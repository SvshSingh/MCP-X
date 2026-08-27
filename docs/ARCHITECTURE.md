# MCP-X Architecture

MCP-X started as a Gemini tool-calling CLI over MCP: one model, one flat list of
tools, one turn at a time. This document describes what it is becoming — a
multi-agent orchestrator that decomposes a natural-language goal into a
validated task DAG, routes each task to a specialist agent, executes ready
tasks in parallel, repairs the plan when a task fails, and writes a durable,
replayable record of everything it did.

## Target shape

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

## Module map

| Module | Responsibility | Phase | Status |
|---|---|---|---|
| `src/kernel/schemas.ts` | Zod contracts: `Task`, `Plan`, `AgentResult`, `Event`, `RunRecord` | 1 | **built** |
| `src/kernel/json.ts` | recovers JSON from imperfect model output | 2 | **built** |
| `src/kernel/planner.ts` | goal → validated `Plan`, with schema-error retry loop | 2 | **built** |
| `src/llm/` | `LlmClient` interface, Gemini client with retry + token accounting, fixture client | 2 | **built** |
| `src/mcp/` | MCP server over SSE + tool registry | 2 | **built** |
| `src/cli/plan.ts` | plan a goal from the command line | 2 | **built** |
| `src/kernel/blackboard.ts` | append-only event log + derived state | 3 | **built** |
| `src/kernel/scheduler.ts` | topological readiness + parallel dispatch | 3 | **built** |
| `src/kernel/orchestrator.ts` | execution loop, retry and failure policy | 3 | **built** |
| `src/cli/run.ts` | plan then execute, with stubbed agents | 3 | **built** |
| `src/agents/registry.ts` | agent manifest + enforced tool ownership | 4 | **built** |
| `src/kernel/classifier.ts` | task → specialist routing | 4 | **built** |
| `src/kernel/replanner.ts` | bounded adaptive replanning | 6 | **built** |
| `src/observability/runlog.ts` | JSONL persistence + reconstruction | 5 | **built** |
| `src/observability/cost.ts` | token and cost accounting, per task and per run | 5 | **built** |
| `src/cli/replay.ts` | rebuild a run from disk, no live calls | 5 | **built** |
| `eval/metrics.ts` | scoring: completion, validity, precision/recall, variance | 7 | **built** |
| `eval/runner.ts` | executes every scenario N times | 7 | **built** |
| `eval/report.ts` | renders the markdown report | 7 | **built** |

`client/` and `server/` still hold the original plain-JS demo, kept as a
reference against the port. `src/llm/` and `src/mcp/` supersede them.

## Running it

```bash
npm run plan -- "<goal>"          # goal -> validated task DAG (needs GEMINI_API_KEY)
npm run execute -- "<goal>"       # plan, then run it with stubbed agents
npm run serve                     # MCP server on :3001
npm run replay -- <runId>         # rebuild a finished run from disk
npm run replay                    # list runs on disk
npm run eval                      # 15 golden scenarios x 3, fixture replay
npm run eval:live                 # against the real model (quota-limited)
npm run eval:record               # re-record golden fixtures

PLANNER_MODE=fixture npm run execute -- "post a summary of today's top HN story to Twitter"
PLANNER_MODE=fixture FAIL_TASK=fetch_story_content npm run execute -- "post a summary of today's top HN story to Twitter"
```

## Design decisions

**Contracts first.** `schemas.ts` landed before any executing code, because
every other module is defined in terms of it. Zod validates at the boundary and
TypeScript types are inferred from the same declarations, so the runtime check
and the compile-time type cannot drift apart.

**A plan is a validated DAG, not a list.** An LLM will cheerfully emit a task
graph containing a cycle or a dangling dependency, and the orchestrator would
deadlock on either. `Plan` rejects both at parse time. All structural checks
(duplicate ids, unresolved references, cycles) run and report *together*, so a
single parse tells the planner everything wrong with its output — which matters
because Phase 2 feeds those errors back to the model on retry. A one-issue-at-a-
time error would cost one model round-trip per defect.

**`blocked` is not `failed`.** When an upstream task fails, its descendants
never got the chance to run. Collapsing the two would report N
indistinguishable failures instead of one root cause and N blocked
descendants.

**A failure always carries a reason.** `AgentResult` refuses `{ ok: false }`
with no `error`. Without that invariant, a silently-empty failure becomes an
unexplained blocked subtree several phases downstream.

**Events are a discriminated union.** An exhaustive `switch` over `event.type`
is checked by the compiler, so adding a seventh event type breaks every
consumer that has not handled it — at compile time rather than at replay time.

**Tokens are tracked in and out separately.** Input and output tokens bill at
different rates; a single scalar total cannot produce a correct cost. This is a
deliberate deviation from the one-field `totalTokens` in the original plan.

**The kernel depends on an `LlmClient` interface, never on a vendor SDK.**
Beyond the usual portability argument: planning is the least deterministic part
of the system, so tests asserting *plan shape* must not also be testing whether
Gemini felt cooperative. `PLANNER_MODE=fixture` replays recorded completions,
which is why CI needs no API key and a red planner test always means the
parsing or retry logic broke.

**The planner assumes the model will be wrong.** It asks for JSON, validates
against `Plan`, and on failure hands the *specific* validation errors back and
asks again, capped at three attempts. The repair prompt restates what the model
produced and what was wrong with it, because a bare "that was invalid, try
again" tends to reproduce the same output. Attempts and their token costs are
retained even on failure — a failed planning run still cost money and the
record must show it.

**JSON extraction degrades through three strategies** — direct parse, fence
stripping, then a balanced-brace scan that tracks string literals. Even asked
for `application/json`, a model will occasionally prepend "Sure! Here you go:",
and burning a retry on that would be waste.

**Tools are declared as data, not as registration side effects.** The original
server called `server.tool(...)` inline at startup, which means the tool set
exists only inside a running server. Phase 4 has to partition tools across
specialists, so `tools.ts` exports a registry with a `capability` on each entry
— the seam the classifier routes on.

**State is derived from the log, never stored beside it.** The event log is the
only writable thing in a run. Task status, attempt counts and token totals are
recomputed by `deriveState` on every loop iteration rather than mutated in
place. That costs a cheap replay per wave and buys an invariant worth far more:
what the orchestrator believes and what the durable record says cannot drift
apart. It also means Phase 5's replay is not a second implementation of the
orchestrator — it is this same pure function applied to events read off disk.

**`blocked` is computed, not recorded.** There is deliberately no
`task_blocked` event. A task is blocked when any dependency failed terminally,
or when a dependency is itself blocked. The propagation is a fixpoint pass
rather than a single sweep, so a failure three levels up still blocks the whole
subtree beneath it.

**A failing task must not cancel its siblings.** Waves dispatch through
`Promise.allSettled`, not `Promise.all`. When one branch fails, the other may
be the only work that can still make progress, and abandoning it would turn one
failure into two.

**The orchestrator refuses to spin.** If no task is ready, none is running, and
work remains, it throws. With a validated DAG and correct blocking that is
unreachable — but the alternative failure mode is a process that hangs
silently, which is far worse to diagnose than an explicit error naming the
stuck tasks.

**Tool ownership is enforced, not documented.** `SpecialistAgent.invoke`
throws when asked for a tool its definition does not declare, and a test
asserts every tool has exactly one owner. Without enforcement, "specialists"
would be a naming convention, and the reason to split them at all — that a
publish action cannot originate from a context meant only to read — would rest
on nothing.

**Routing degrades rather than fails.** The classifier prefers a planner hint
naming a registered agent, then an LLM answer, then deterministic keyword
scoring. An LLM answer naming an agent that does not exist is discarded rather
than trusted: a classifier that can invent a destination is worse than one
that is occasionally wrong, because the orchestrator would dispatch into
nothing. The keyword path is not only an outage fallback — it is what makes
routing accuracy measurable with no network, so a routing regression shows up
as a number rather than a vague sense that the agent got worse.

**Replay is the same function as execution.** `deriveState` reconstructs
state from events whether those events are in memory or read off disk, so a
replay cannot disagree with the run it replays. A test asserts the
reconstructed state map is identical to the live one rather than merely
equivalent.

**An unknown price is reported as unknown, never as zero.** The rate table
ships empty on purpose — model pricing changes and is not worth guessing at.
An unpriced model yields `unpriced`, not `$0.00`, because a cost report that
quietly under-reports is worse than no report at all: it gets trusted.

**Run logs are appended as the run happens.** A crashed run is exactly the one
worth inspecting, so the format leaves a readable prefix rather than nothing.
Reconstruction treats a missing summary line as a crash and recomputes totals
from the events.

**Replanning is bounded, and its constraints are enforced.** A terminal task
failure triggers a repair attempt within a hard cap, so a goal that cannot be
reached fails in bounded time rather than generating plans forever. Because
state is replayed over the current plan, a revision must keep every completed
task's id (or its result is silently discarded and the work redone) and must
not reuse the failed task's id (or the replayed `task_failed` event marks the
alternate route failed the moment it is added). Both are validated and fed
back to the model as specific corrections.

**The evaluation harness measures what the system decides, not what a stub
returns.** Tool execution is stubbed, so scoring tool calls would score the
stub. Scenarios declare `expectedCapabilities` and precision/recall are scored
on routing, which is a real decision the system makes.

**Golden fixtures are recorded model output.** A hand-written set would test
the harness against an author's idea of what the planner does — the exact
thing the harness exists to find out.

**Variance is reported as unmeasurable under fixture replay**, rather than as
zero. Every repeat is identical by construction there, so a stability figure
would describe the replay rather than the model. Only live mode can observe it.

**A run's signature excludes task ids.** Repeated live runs of one goal produce
identical structure under different names; keying variance on ids would report
noise as instability.

**Plan revisions are append-only.** A replan appends a revision rather than
mutating the last one, so the run record shows what changed and why.
`RunRecord` enforces that revisions are contiguous from 0 and that every
revision serves the same goal.

## Verification

`npm run typecheck && npm run lint && npm run coverage` is the local gate, and
the same three steps run in CI on every push and pull request. Coverage
thresholds are enforced at 85% on `src/kernel/**` — the build fails below that
rather than merely reporting it.

From Phase 7 the eval harness joins the gate: golden scenarios run N times each,
and CI fails if the task-completion rate drops below threshold. That is the part
that covers *validation* of a non-deterministic system, as opposed to testing a
deterministic one.
