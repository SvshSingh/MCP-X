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
| `src/kernel/scheduler.ts` | topological readiness + parallel dispatch | 3 | pending |
| `src/kernel/orchestrator.ts` | execution loop, retry and failure policy | 3 | pending |
| `src/kernel/blackboard.ts` | append-only event log + derived state snapshot | 3 | pending |
| `src/kernel/classifier.ts` | task → specialist routing | 4 | pending |
| `src/agents/registry.ts` | agent → capability/tool manifest | 4 | pending |
| `src/kernel/replanner.ts` | bounded adaptive replanning | 6 | pending |
| `src/observability/` | `RunRecord` persistence (JSONL) + cost accounting | 5 | pending |
| `eval/` | golden scenarios, scoring, variance report | 7 | pending |

`client/` and `server/` still hold the original plain-JS demo, kept as a
reference against the port. `src/llm/` and `src/mcp/` supersede them.

## Running it

```bash
npm run plan -- "post a summary of today's top HN story to Twitter"   # needs GEMINI_API_KEY
PLANNER_MODE=fixture npm run plan -- "restock the warehouse for next week"
npm run serve                                                         # MCP server on :3001
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
