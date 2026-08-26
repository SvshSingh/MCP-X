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
| `src/kernel/planner.ts` | goal → validated `Plan`, with schema-error retry loop | 2 | pending |
| `src/kernel/scheduler.ts` | topological readiness + parallel dispatch | 3 | pending |
| `src/kernel/orchestrator.ts` | execution loop, retry and failure policy | 3 | pending |
| `src/kernel/blackboard.ts` | append-only event log + derived state snapshot | 3 | pending |
| `src/kernel/classifier.ts` | task → specialist routing | 4 | pending |
| `src/kernel/replanner.ts` | bounded adaptive replanning | 6 | pending |
| `src/agents/registry.ts` | agent → capability/tool manifest | 4 | pending |
| `src/mcp/` | MCP server + tool definitions (ported from `server/`) | 2 | pending |
| `src/llm/` | Gemini client, retry, token accounting (ported from `client/`) | 2 | pending |
| `src/observability/` | `RunRecord` persistence (JSONL) + cost accounting | 5 | pending |
| `eval/` | golden scenarios, scoring, variance report | 7 | pending |

`client/` and `server/` still hold the original plain-JS demo. They stay
runnable and untouched until Phase 2 ports them into `src/llm/` and `src/mcp/`.

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
