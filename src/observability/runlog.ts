/**
 * Durable run records, as JSONL.
 *
 * One JSON object per line, appended in the order things happened. The format
 * is chosen so a run that dies mid-flight still leaves a readable prefix: a
 * crashed run is exactly the interesting one to inspect, and a
 * single-JSON-blob-at-the-end format would leave nothing at all.
 *
 * Reconstruction leans on `deriveState` from the kernel rather than
 * reimplementing the loop, so replay cannot drift from execution — they are
 * the same function over the same events.
 *
 * Phase 5 of ORCHESTRATOR_PLAN.md.
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { Event, Plan, RunRecord, TokenUsage } from "../kernel/schemas.js";

export const DEFAULT_RUN_DIR = "runs";

export const RunLogLine = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("header"),
    runId: z.string().min(1),
    goal: z.string().min(1),
    startedAt: z.string().datetime({ offset: true }),
    model: z.string().optional(),
  }),
  z.object({ kind: z.literal("plan"), plan: Plan }),
  z.object({ kind: z.literal("event"), event: Event }),
  z.object({
    kind: z.literal("summary"),
    ok: z.boolean(),
    totalTokens: TokenUsage,
    costUsd: z.number().min(0).default(0),
    finalOutput: z.string().optional(),
    completedAt: z.string().datetime({ offset: true }),
  }),
]);
export type RunLogLine = z.infer<typeof RunLogLine>;

export class RunLogError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RunLogError";
  }
}

export const runLogPath = (runId: string, dir: string = DEFAULT_RUN_DIR): string =>
  join(dir, `${runId}.jsonl`);

/** Rejects ids that would escape the run directory. */
export function assertSafeRunId(runId: string): void {
  if (runId === "" || /[/\\]|\.\./.test(runId)) {
    throw new RunLogError(`Unsafe run id "${runId}"`);
  }
}

/* -------------------------------------------------------------------------- */
/* Writing                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Appends lines as they happen.
 *
 * Append rather than buffer-and-write, so the file on disk is always as
 * current as the run is.
 */
export class RunLogWriter {
  readonly path: string;

  constructor(
    readonly runId: string,
    dir: string = DEFAULT_RUN_DIR,
  ) {
    assertSafeRunId(runId);
    mkdirSync(dir, { recursive: true });
    this.path = runLogPath(runId, dir);
  }

  write(line: RunLogLine): void {
    appendFileSync(this.path, `${JSON.stringify(RunLogLine.parse(line))}\n`, "utf8");
  }
}

/** Writes a finished record in one pass. */
export function writeRunRecord(
  record: RunRecord,
  options: { dir?: string; model?: string } = {},
): string {
  const writer = new RunLogWriter(record.runId, options.dir ?? DEFAULT_RUN_DIR);

  writer.write({
    kind: "header",
    runId: record.runId,
    goal: record.goal,
    startedAt: record.startedAt,
    ...(options.model === undefined ? {} : { model: options.model }),
  });

  for (const plan of record.planRevisions) writer.write({ kind: "plan", plan });
  for (const event of record.events) writer.write({ kind: "event", event });

  const completed = record.events.find((event) => event.type === "run_completed");

  writer.write({
    kind: "summary",
    ok: completed?.type === "run_completed" ? completed.ok : false,
    totalTokens: record.totalTokens,
    costUsd: record.costUsd,
    ...(record.finalOutput === undefined ? {} : { finalOutput: record.finalOutput }),
    completedAt: record.completedAt ?? record.startedAt,
  });

  return writer.path;
}

/* -------------------------------------------------------------------------- */
/* Reading                                                                    */
/* -------------------------------------------------------------------------- */

export function readRunLog(path: string): RunLogLine[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    throw new RunLogError(`Cannot read run log "${path}"`, { cause: error });
  }

  return raw
    .split("\n")
    .map((line, index) => ({ line: line.trim(), index }))
    .filter(({ line }) => line !== "")
    .map(({ line, index }) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        throw new RunLogError(`Malformed JSON on line ${index + 1} of "${path}"`, {
          cause: error,
        });
      }

      const result = RunLogLine.safeParse(parsed);
      if (!result.success) {
        throw new RunLogError(
          `Invalid log line ${index + 1} of "${path}": ${result.error.issues
            .map((i) => i.message)
            .join("; ")}`,
        );
      }

      return result.data;
    });
}

/**
 * Rebuilds a `RunRecord` from log lines.
 *
 * A missing summary is not an error — it is a run that crashed before
 * finishing. Totals are recomputed from the events in that case, so the
 * partial run is still inspectable rather than unreadable.
 */
export function reconstructRunRecord(lines: readonly RunLogLine[]): RunRecord {
  const header = lines.find((line) => line.kind === "header");
  if (header?.kind !== "header") {
    throw new RunLogError("Run log has no header line");
  }

  const planRevisions = lines.flatMap((line) => (line.kind === "plan" ? [line.plan] : []));
  if (planRevisions.length === 0) {
    throw new RunLogError(`Run log for "${header.runId}" contains no plan`);
  }

  const events = lines.flatMap((line) => (line.kind === "event" ? [line.event] : []));
  const summary = lines.find((line) => line.kind === "summary");

  const derivedTokens = events.reduce<TokenUsage>(
    (sum, event) =>
      event.type === "task_completed"
        ? { in: sum.in + event.result.tokensIn, out: sum.out + event.result.tokensOut }
        : sum,
    { in: 0, out: 0 },
  );

  const record = {
    runId: header.runId,
    goal: header.goal,
    planRevisions,
    events,
    totalTokens: summary?.kind === "summary" ? summary.totalTokens : derivedTokens,
    costUsd: summary?.kind === "summary" ? summary.costUsd : 0,
    ...(summary?.kind === "summary" && summary.finalOutput !== undefined
      ? { finalOutput: summary.finalOutput }
      : {}),
    startedAt: header.startedAt,
    ...(summary?.kind === "summary" ? { completedAt: summary.completedAt } : {}),
  };

  return RunRecord.parse(record);
}

export function loadRunRecord(runId: string, dir: string = DEFAULT_RUN_DIR): RunRecord {
  assertSafeRunId(runId);
  return reconstructRunRecord(readRunLog(runLogPath(runId, dir)));
}

/** True when the log has no summary line — the run did not finish. */
export const isPartial = (lines: readonly RunLogLine[]): boolean =>
  !lines.some((line) => line.kind === "summary");

/** The model a run used, if the header recorded one. */
export const modelOf = (lines: readonly RunLogLine[]): string | undefined => {
  const header = lines.find((line) => line.kind === "header");
  return header?.kind === "header" ? header.model : undefined;
};

/** Run ids on disk, newest last by filename. */
export function listRuns(dir: string = DEFAULT_RUN_DIR): string[] {
  if (!existsSync(dir)) return [];

  return readdirSync(dir)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => name.slice(0, -".jsonl".length))
    .sort();
}
