/**
 * Reconstruct a finished run from disk.
 *
 *   npm run replay -- <runId>
 *   npm run replay            # lists what is on disk
 *
 * No LLM client is constructed and no network call is made. The timeline is
 * rebuilt entirely from the event log, using the same `deriveState` the
 * orchestrator used while running — replay cannot drift from execution
 * because it is the same function over the same events.
 */

import { deriveState } from "../kernel/blackboard.js";
import { blockedByFailures } from "../kernel/orchestrator.js";
import { formatCost, priceRun, ratesFromEnv } from "../observability/cost.js";
import {
  isPartial,
  listRuns,
  modelOf,
  readRunLog,
  reconstructRunRecord,
  runLogPath,
  RunLogError,
  DEFAULT_RUN_DIR,
} from "../observability/runlog.js";

const STATUS_MARK: Record<string, string> = {
  completed: "OK  ",
  failed: "FAIL",
  blocked: "BLOK",
  pending: "....",
  running: "RUN ",
};

const clock = (iso: string): string => iso.slice(11, 23);

function describeEvent(event: { type: string } & Record<string, unknown>): string {
  switch (event.type) {
    case "plan_created":
      return `plan created (revision ${String(event["revision"])}, ${String(
        event["taskCount"],
      )} tasks)`;
    case "task_started":
      return `start   ${String(event["taskId"])} [${String(event["agent"])}] attempt ${String(
        event["attempt"],
      )}`;
    case "task_completed":
      return `done    ${String(event["taskId"])}`;
    case "task_failed":
      return `failed  ${String(event["taskId"])} attempt ${String(event["attempt"])}${
        event["willRetry"] === true ? " (will retry)" : ""
      }: ${String(event["error"])}`;
    case "replan":
      return `replan  revision ${String(event["fromRevision"])} -> ${String(
        event["toRevision"],
      )}: ${String(event["reason"])}`;
    case "run_completed":
      return `run ${event["ok"] === true ? "succeeded" : "failed"}`;
    default:
      return event.type;
  }
}

function main(): number {
  const runId = process.argv[2]?.trim();
  const dir = process.env["RUN_DIR"] ?? DEFAULT_RUN_DIR;

  if (runId === undefined || runId === "") {
    const runs = listRuns(dir);
    if (runs.length === 0) {
      console.error(`No runs found in "${dir}". Execute something first:`);
      console.error('  npm run execute -- "<goal>"');
      return 2;
    }
    console.log(`Runs in "${dir}":`);
    for (const id of runs) console.log(`  ${id}`);
    console.log();
    console.log("Replay one with: npm run replay -- <runId>");
    return 0;
  }

  let lines;
  try {
    lines = readRunLog(runLogPath(runId, dir));
  } catch (error) {
    console.error(error instanceof RunLogError ? error.message : String(error));
    return 1;
  }

  const partial = isPartial(lines);
  const model = modelOf(lines);

  let record;
  try {
    record = reconstructRunRecord(lines);
  } catch (error) {
    console.error(error instanceof RunLogError ? error.message : String(error));
    return 1;
  }

  const plan = record.planRevisions.at(-1);
  if (!plan) {
    console.error("Run has no plan revision");
    return 1;
  }

  const state = deriveState(plan, record.events);

  console.log(`Run:     ${record.runId}${partial ? "   (INCOMPLETE - no summary line)" : ""}`);
  console.log(`Goal:    ${record.goal}`);
  console.log(`Model:   ${model ?? "(not recorded)"}`);
  console.log(`Started: ${record.startedAt}`);
  if (record.completedAt !== undefined) console.log(`Ended:   ${record.completedAt}`);
  console.log();

  console.log(`Timeline (${record.events.length} events):`);
  for (const event of record.events) {
    console.log(
      `  ${clock(event.at)}  ${describeEvent(event as { type: string } & Record<string, unknown>)}`,
    );
  }
  console.log();

  console.log(`Plan revisions: ${record.planRevisions.length}`);
  console.log("Final task states:");
  for (const task of plan.tasks) {
    const taskState = state.tasks.get(task.id);
    const mark = STATUS_MARK[taskState?.status ?? "pending"] ?? "????";
    const attempts = taskState?.attempts ?? 0;
    const reason = taskState?.error === undefined ? "" : `  (${taskState.error})`;
    console.log(
      `  ${mark}  ${task.id}${attempts > 1 ? ` x${attempts}` : ""}${reason}`,
    );
  }

  const blocked = blockedByFailures(plan, state);
  if (blocked.size > 0) {
    console.log();
    for (const [failedId, downstream] of blocked) {
      console.log(`  "${failedId}" blocked ${downstream.length}: ${downstream.join(", ")}`);
    }
  }

  const rates = ratesFromEnv(model ?? "unknown");
  const priced = priceRun(record, model, rates);

  console.log();
  console.log("Cost:");
  console.log(
    `  total     ${priced.tokens.in} in / ${priced.tokens.out} out   ${formatCost(priced.cost)}`,
  );
  console.log(`  overhead  ${priced.overhead.in} in / ${priced.overhead.out} out   (planning, routing)`);

  for (const task of priced.byTask) {
    if (task.tokens.in === 0 && task.tokens.out === 0) continue;
    console.log(
      `  ${task.taskId.padEnd(28)} ${task.tokens.in} in / ${task.tokens.out} out   ${formatCost(
        task.cost,
      )}`,
    );
  }

  if (!priced.cost.priced) {
    console.log();
    console.log(
      `  No rate known for "${model ?? "unknown"}". Set ${"LLM_PRICE_IN_PER_MTOK"} and ` +
        `${"LLM_PRICE_OUT_PER_MTOK"} to price this run.`,
    );
  }

  if (record.finalOutput !== undefined && record.finalOutput !== "") {
    console.log();
    console.log("Final output:");
    for (const line of record.finalOutput.split("\n")) console.log(`  ${line}`);
  }

  return 0;
}

process.exitCode = main();
