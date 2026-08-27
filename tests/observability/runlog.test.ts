import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { deriveState } from "@kernel/blackboard";
import { runPlan } from "@kernel/orchestrator";
import { Plan, RunRecord } from "@kernel/schemas";
import {
  assertSafeRunId,
  isPartial,
  listRuns,
  loadRunRecord,
  modelOf,
  readRunLog,
  reconstructRunRecord,
  RunLogError,
  RunLogWriter,
  runLogPath,
  writeRunRecord,
} from "@obs/runlog";

const AT = "2026-08-27T10:00:00.000Z";
const now = () => new Date(AT);

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mcpx-runs-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const branching = Plan.parse({
  goal: "ship the thing",
  tasks: [
    { id: "root", description: "do root", dependsOn: [] },
    { id: "left", description: "do left", dependsOn: ["root"] },
    { id: "right", description: "do right", dependsOn: ["root"] },
    { id: "join", description: "do join", dependsOn: ["left", "right"] },
    { id: "report", description: "do report", dependsOn: ["join"] },
  ],
  createdAt: AT,
  revision: 0,
});

const runOnce = (failing = new Set<string>()) =>
  runPlan({
    plan: branching,
    runId: "run-1",
    now,
    maxAttemptsPerTask: 1,
    execute: (task) =>
      failing.has(task.id)
        ? { taskId: task.id, ok: false, error: `${task.id} exploded` }
        : { taskId: task.id, ok: true, output: `${task.id} ok`, tokensIn: 5, tokensOut: 3 },
  });

/* -------------------------------------------------------------------------- */

describe("assertSafeRunId", () => {
  it("accepts an ordinary id", () => {
    expect(() => assertSafeRunId("run-abc123")).not.toThrow();
  });

  it("rejects path traversal and separators", () => {
    for (const bad of ["", "../escape", "a/b", "a\\b", ".."]) {
      expect(() => assertSafeRunId(bad), bad).toThrow(RunLogError);
    }
  });
});

describe("writeRunRecord / readRunLog", () => {
  it("writes one JSON object per line", async () => {
    const { record } = await runOnce();
    const path = writeRunRecord(record, { dir, model: "stub-model" });

    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines.length).toBeGreaterThan(3);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
  });

  it("opens with a header and closes with a summary", async () => {
    const { record } = await runOnce();
    const lines = readRunLog(writeRunRecord(record, { dir, model: "stub-model" }));

    expect(lines[0]?.kind).toBe("header");
    expect(lines.at(-1)?.kind).toBe("summary");
  });

  it("records the model so a replay can price it", async () => {
    const { record } = await runOnce();
    const lines = readRunLog(writeRunRecord(record, { dir, model: "stub-model" }));

    expect(modelOf(lines)).toBe("stub-model");
  });

  it("omits the model when none was given", async () => {
    const { record } = await runOnce();

    expect(modelOf(readRunLog(writeRunRecord(record, { dir })))).toBeUndefined();
  });

  it("writes every plan revision and every event", async () => {
    const { record } = await runOnce();
    const lines = readRunLog(writeRunRecord(record, { dir }));

    expect(lines.filter((l) => l.kind === "plan")).toHaveLength(record.planRevisions.length);
    expect(lines.filter((l) => l.kind === "event")).toHaveLength(record.events.length);
  });
});

describe("reconstructRunRecord", () => {
  // The Phase 5 acceptance criterion.
  it("rebuilds a record identical to the original", async () => {
    const { record } = await runOnce();
    writeRunRecord(record, { dir });

    const restored = loadRunRecord("run-1", dir);

    expect(restored).toEqual(record);
  });

  it("rebuilds a failed run identically, blocked subtree and all", async () => {
    const { record, state } = await runOnce(new Set(["left"]));
    writeRunRecord(record, { dir });

    const restored = loadRunRecord("run-1", dir);
    const plan = restored.planRevisions.at(-1);
    const restoredState = deriveState(plan!, restored.events);

    expect(restored).toEqual(record);
    // State derives identically from disk, which is the actual guarantee:
    // replay is the same function over the same events, not a reimplementation.
    expect([...restoredState.tasks.entries()]).toEqual([...state.tasks.entries()]);
  });

  it("produces a schema-valid RunRecord", async () => {
    const { record } = await runOnce();
    writeRunRecord(record, { dir });

    expect(() => RunRecord.parse(loadRunRecord("run-1", dir))).not.toThrow();
  });

  it("survives a JSON round trip through the file", async () => {
    const { record } = await runOnce();
    writeRunRecord(record, { dir });

    const first = loadRunRecord("run-1", dir);
    const second = loadRunRecord("run-1", dir);

    expect(second).toEqual(first);
  });

  it("reconstructs a crashed run that has no summary line", () => {
    // A run that dies mid-flight is exactly the interesting one; the format
    // must leave a readable prefix rather than nothing.
    const writer = new RunLogWriter("partial", dir);
    writer.write({ kind: "header", runId: "partial", goal: "ship the thing", startedAt: AT });
    writer.write({ kind: "plan", plan: branching });
    writer.write({
      kind: "event",
      event: {
        type: "task_completed",
        runId: "partial",
        at: AT,
        taskId: "root",
        result: { taskId: "root", ok: true, toolCalls: [], tokensIn: 11, tokensOut: 7 },
      },
    });

    const lines = readRunLog(writer.path);
    expect(isPartial(lines)).toBe(true);

    const record = reconstructRunRecord(lines);
    // Totals recomputed from events, since no summary recorded them.
    expect(record.totalTokens).toEqual({ in: 11, out: 7 });
    expect(record.completedAt).toBeUndefined();
  });

  it("reports a complete run as not partial", async () => {
    const { record } = await runOnce();

    expect(isPartial(readRunLog(writeRunRecord(record, { dir })))).toBe(false);
  });

  it("rejects a log with no header", () => {
    const path = join(dir, "bad.jsonl");
    writeFileSync(path, `${JSON.stringify({ kind: "plan", plan: branching })}\n`, "utf8");

    expect(() => reconstructRunRecord(readRunLog(path))).toThrow(/no header/);
  });

  it("rejects a log with no plan", () => {
    const path = join(dir, "bad.jsonl");
    writeFileSync(
      path,
      `${JSON.stringify({ kind: "header", runId: "x", goal: "g", startedAt: AT })}\n`,
      "utf8",
    );

    expect(() => reconstructRunRecord(readRunLog(path))).toThrow(/contains no plan/);
  });
});

describe("readRunLog — malformed input", () => {
  it("names the line number for malformed JSON", () => {
    const path = join(dir, "broken.jsonl");
    writeFileSync(
      path,
      `${JSON.stringify({ kind: "header", runId: "x", goal: "g", startedAt: AT })}\nnot json\n`,
      "utf8",
    );

    expect(() => readRunLog(path)).toThrow(/line 2/);
  });

  it("names the line number for a schema-invalid line", () => {
    const path = join(dir, "invalid.jsonl");
    writeFileSync(path, `${JSON.stringify({ kind: "nonsense" })}\n`, "utf8");

    expect(() => readRunLog(path)).toThrow(/line 1/);
  });

  it("ignores blank lines", async () => {
    const { record } = await runOnce();
    const path = writeRunRecord(record, { dir });
    writeFileSync(path, `${readFileSync(path, "utf8")}\n\n\n`, "utf8");

    expect(() => readRunLog(path)).not.toThrow();
  });

  it("throws a clear error for a missing file", () => {
    expect(() => readRunLog(join(dir, "nope.jsonl"))).toThrow(RunLogError);
  });
});

describe("listRuns", () => {
  it("returns an empty list for a directory that does not exist", () => {
    expect(listRuns(join(dir, "nothing-here"))).toEqual([]);
  });

  it("lists run ids without the extension", async () => {
    const { record } = await runOnce();
    writeRunRecord(record, { dir });

    expect(listRuns(dir)).toEqual(["run-1"]);
  });

  it("ignores non-jsonl files", async () => {
    const { record } = await runOnce();
    writeRunRecord(record, { dir });
    writeFileSync(join(dir, "notes.txt"), "hello", "utf8");

    expect(listRuns(dir)).toEqual(["run-1"]);
  });
});

describe("runLogPath", () => {
  it("builds the path from the run id", () => {
    expect(runLogPath("run-1", "runs")).toBe(join("runs", "run-1.jsonl"));
  });
});
