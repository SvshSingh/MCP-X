# Demo runbook

A 6–8 minute live walkthrough of MCP-X on a screen share, plus what to do when
something goes wrong. Every command below is typed exactly as shown in
PowerShell, cmd or bash; none of them need environment variables.

## Ten minutes before

```bash
npm install
npm run demo:reset
npm run doctor
```

`doctor` checks Node, dependencies, the dataset, the recorded fixtures and your
console encoding. It also **runs both demo scenarios end to end** in a scratch
folder, so "Ready." means the demo you are about to show actually works right now.

If you plan to show the live model, check your quota too. This spends one call
per model:

```bash
npm run doctor -- --live
```

Then:

- **Do not rehearse `demo:live` repeatedly.** The Gemini free tier allows 20
  requests per day per model, and a live run spends 2–4 of them.
- Bump the terminal font size up and close unrelated tabs.
- If `doctor` warns about the console code page, add `--plain` to every demo
  command (ASCII only, no colour).
- Have the repo open in a browser tab: <https://github.com/SvshSingh/MCP-X>.

## The walkthrough

### 1. Frame it (30 seconds)

> MCP-X is a multi-agent orchestrator. You give it a goal in plain English; a
> planner turns that into a validated graph of tasks, each bound to a real tool;
> specialist agents that each own a narrow set of tools execute it in parallel
> where they can; if something fails, it repairs its own plan; and every run is
> recorded so it can be replayed and scored.

### 2. The happy path (about 2 minutes)

```bash
npm run demo
```

Point at, in order:

- **PLAN.** The model produced this DAG. Every task names a real tool, and wave
  2 runs two tasks **in parallel**. The planner validated the data wiring
  before anything ran: `compute_reorder_qty` consumes inventory, so it *must*
  depend on `check_inventory`, or the plan is rejected and repaired.
- **EXECUTE.** Each tool goes to the specialist that owns it: research reads,
  compute calculates, publish is the only agent that can send anything. The two
  wave-2 tasks start before either finishes — that is real concurrency. The
  numbers are real, computed from `demo/warehouse.json`.
- **RESULT.** Six lines computed, three **held back** by compliance: a hazardous
  item from a supplier without HAZMAT certification, a supplier on hold, and a
  $14,400 line above the auto-approval limit. Two purchase orders were written.

The HTML report opens in the browser automatically. Scroll through the plan
waves, the reorder table with each line's decision, and the event log.

### 3. The failure path (about 2 minutes) — the strongest segment

```bash
npm run demo:fail
```

This takes Nova Medical Supply's ordering portal down. Point at:

- `notify_supplier` **fails, retries once, fails again.** Note the message:
  *no purchase orders were sent*. The send is all-or-nothing, so there is never
  a half-sent state to clean up.
- **REPLAN.** The replanner proposes a new route ending in
  `queue_manual_review`, and states why.
- **Completed tasks are not re-run.** Inventory, supplier lookup, reorder
  quantities and compliance all carry forward; only the new task executes.
- In the report, show the two plan revisions side by side: revision 0
  superseded, revision 1 executed.

Open the file it wrote, from the path printed under **Outbox**:

```bash
notepad demo\outbox\<runId>\manual-review.md
```

### 4. Replay from disk (30 seconds)

```bash
npm run replay -- <runId>
```

> No model is called here. The whole timeline is rebuilt from the append-only
> event log, using the same state-derivation function the orchestrator used
> while running, so a replay cannot disagree with the run it replays.

### 5. It really is MCP (45 seconds)

```bash
npm run mcp:demo
```

> These are ordinary MCP tools. This starts the server, connects a real MCP
> client over SSE, lists the tools, and drives the same workflow by hand. The
> orchestrator does exactly this, except the model decides the order and the
> runtime wires each tool's output into the next.

### 6. How it is validated (about 1 minute)

```bash
npm run eval
```

> Fifteen golden scenarios, each run three times, scored on completion, plan
> validity, capability precision and recall, step efficiency and cross-run
> variance. It passes 14 of 15, and the one failure is understood and
> documented. CI runs this on every pull request and fails the build if the pass
> rate drops below 93%.

### 7. Optional: the live model (1 minute)

Only if `npm run doctor -- --live` passed:

```bash
npm run demo:live -- --fail
```

> Same run, but the plan and the repair come from Gemini right now rather than
> from a recording. The offline demo you saw first replays what the model
> actually said on a real run; `npm run demo:record` captured it.

## Questions you are likely to get

**"Is the offline mode faked?"**
No. The fixtures are the model's real responses, captured during a live run by
a recording client, and replayed. The tools, the scheduler, the compliance
rules, the files written and the replan logic all run for real in both modes;
only the model's answer comes from disk. That is what makes the demo — and CI —
reproducible.

**"What's stubbed?"**
The tools act on a local dataset and write to a local outbox. Nothing calls a
real ERP or emails a real supplier. The orchestration, routing, validation,
repair and recording are real. The README has a table of exactly what is and
isn't.

**"How do you handle LLM non-determinism?"**
Three layers. Every plan is schema-validated as a DAG with its tool wiring
checked, and mistakes go back to the model as specific corrections. Execution is
deterministic once a plan exists. And the evaluation harness measures behaviour
across repeated runs, comparing graph *shape* rather than task names, because
the model renames steps between runs while keeping the same structure.

**"Why can't a specialist just call any tool?"**
Because then the split would be decoration. A task routed to the compute agent
physically cannot reach `notify_supplier`; there is a test for it. Side effects
happen in exactly one place.

**"What would you build next?"**
Put a real integration behind the same tool contract — a supplier API or an ERP
read — and let the LLM classifier handle routing in the evaluation suite, which
resolves the one remaining scenario failure.

## If something goes wrong

| Symptom | Do this |
|---|---|
| Boxes, ticks or arrows show as garbage | Add `--plain`, e.g. `npm run demo -- --plain` |
| Browser doesn't open | Copy the path printed after **Report** into the browser |
| `demo:live` says the quota is exhausted | `npm run demo:live -- --model gemini-3.1-flash-lite`, or switch to `npm run demo:fail` |
| `No recorded demo fixtures yet` | `npm run demo:record` (needs a key; spends 2–4 calls) |
| Outbox is cluttered from rehearsal | `npm run demo:reset` |
| Anything else | `npm run doctor` tells you which check fails |
