/**
 * The supply-chain demo, narrated for a live audience.
 *
 *   npm run demo                 offline: replays recorded model output, no key, no network
 *   npm run demo:fail            offline, with a supplier portal down -> the run repairs itself
 *   npm run demo:live            plans against the real model
 *   npm run demo:live -- --fail  live, with the failure
 *   npm run demo:record          live with the failure, saving the model's answers as the offline fixtures
 *
 * Flags rather than environment variables, so every command works as typed in
 * PowerShell, cmd and bash alike: --live --fail --record --open --goal "<text>" --model <name>
 */

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { defaultRegistry } from "../agents/registry.js";
import { DEMO_FIXTURE_DIR, DEMO_GOAL, FAILING_SUPPLIER, runSupplyChainDemo, type DemoEvent, type DemoResult } from "../demo/supply-chain.js";
import { PLANNER_SYSTEM_PROMPT } from "../kernel/planner.js";
import { REPLANNER_SYSTEM_PROMPT } from "../kernel/replanner.js";
import { createLlmClient } from "../llm/index.js";
import { RecordingLlmClient } from "../llm/recording.js";
import { LlmError, type LlmClient } from "../llm/types.js";


/* -------------------------------------------------------------------------- */
/* Arguments                                                                  */
/* -------------------------------------------------------------------------- */

interface Flags {
  live: boolean;
  fail: boolean;
  record: boolean;
  open: boolean;
  plain: boolean;
  goal?: string;
  model?: string;
}

function parseFlags(argv: readonly string[]): Flags {
  const flags: Flags = { live: false, fail: false, record: false, open: false, plain: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--live") flags.live = true;
    else if (arg === "--fail") flags.fail = true;
    else if (arg === "--open") flags.open = true;
    else if (arg === "--plain") flags.plain = true;
    else if (arg === "--record") {
      flags.record = true;
      flags.live = true;
    } else if (arg === "--goal") {
      const value = argv[++i];
      if (value !== undefined) flags.goal = value;
    } else if (arg === "--model") {
      const value = argv[++i];
      if (value !== undefined) flags.model = value;
    }
  }
  return flags;
}

/* -------------------------------------------------------------------------- */
/* Presentation                                                               */
/* -------------------------------------------------------------------------- */

/**
 * `--plain` swaps every glyph for ASCII and turns colour off. A legacy Windows
 * console on a non-UTF-8 code page renders box-drawing and tick characters as
 * garbage, and that is exactly the kind of thing that surfaces for the first
 * time on a screen share.
 */
const PLAIN = process.argv.includes("--plain");
const colour = !PLAIN && process.stdout.isTTY === true && process.env["NO_COLOR"] === undefined;
const G = PLAIN
  ? { rule: "-", play: ">", ok: "+", fail: "x", retry: "~", replan: "@", mail: "*", arrow: "->", top: "\\", mid: "|", bottom: "/", dot: "|" }
  : { rule: "─", play: "▶", ok: "✓", fail: "✗", retry: "↻", replan: "⟲", mail: "✉", arrow: "→", top: "┐", mid: "│", bottom: "┘", dot: "·" };
const paint = (code: string) => (text: string) => (colour ? `\u001b[${code}m${text}\u001b[0m` : text);
const bold = paint("1");
const dim = paint("2");
const green = paint("32");
const red = paint("31");
const yellow = paint("33");
const cyan = paint("36");
const magenta = paint("35");

const say = (line = "") => console.log(line);
const rule = () => say(dim(G.rule.repeat(72)));
const stage = (n: number, title: string) => {
  say();
  say(`${bold(cyan(String(n)))}  ${bold(title)}`);
};
const usd = (value: number) => `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function narrate(event: DemoEvent): void {
  const registry = defaultRegistry();

  switch (event.type) {
    case "planned": {
      stage(1, `PLAN  ${dim(`valid DAG on attempt ${event.attempts} ${G.dot} ${event.plan.tasks.length} tasks ${G.dot} ${event.waves.length} waves`)}`);
      event.waves.forEach((wave, index) => {
        wave.forEach((task, position) => {
          const owner = task.tool ? registry.ownerOf(task.tool)?.name ?? "?" : "?";
          const label = position === 0 ? `wave ${index + 1}` : "";
          const bracket = wave.length > 1 ? (position === 0 ? G.top : position === wave.length - 1 ? G.bottom : G.mid) : " ";
          const parallel = wave.length > 1 && position === 0 ? dim(" in parallel") : "";
          say(
            `   ${dim(label.padEnd(7))} ${magenta((task.tool ?? "no tool").padEnd(22))} ${dim(G.arrow)} ${owner.padEnd(8)} ${dim(bracket)}${parallel}`,
          );
        });
      });
      stage(2, "EXECUTE");
      break;
    }
    case "task_started":
      say(`   ${cyan(G.play)} ${bold(event.tool ?? event.taskId)} ${dim(`on ${event.agent}${event.attempt > 1 ? ` ${G.dot} attempt ${event.attempt}` : ""}`)}`);
      break;
    case "tool_result":
      say(`     ${event.ok ? green(G.ok) : red(G.fail)} ${event.ok ? event.text : red(event.text)} ${dim(`${event.durationMs}ms`)}`);
      break;
    case "task_failed":
      if (event.willRetry) say(`     ${yellow(`${G.retry} retrying`)}`);
      break;
    case "replan":
      say();
      say(`   ${yellow(bold(`${G.replan} REPLAN  revision ${event.fromRevision} ${G.arrow} ${event.toRevision}`))}`);
      say(`     ${yellow(event.reason)}`);
      say(`     ${dim(`new route: ${event.plan.tasks.map((t) => t.tool ?? t.id).join(` ${G.arrow} `)}`)}`);
      say(`     ${dim("completed tasks are kept and not re-run")}`);
      say();
      break;
    case "replan_error":
      say(`   ${red(`replanner could not produce a route: ${event.message}`)}`);
      break;
  }
}

function printResult(result: DemoResult): void {
  stage(3, "RESULT");

  if (result.reorder) {
    say(`   ${bold("Reorder lines")}`);
    for (const line of result.reorder.lines) {
      const breaches = result.compliance?.breaches.filter((b) => b.sku === line.sku) ?? [];
      const verdict =
        result.compliance === undefined
          ? dim("not validated")
          : breaches.length === 0
            ? green("approved")
            : red(`held: ${breaches.map((b) => b.rule.replace(/_/g, " ")).join(", ")}`);
      say(
        `   ${line.sku.padEnd(10)} ${String(line.qty).padStart(6)} units  ${usd(line.lineValueUsd).padStart(11)}  ${line.supplierId.padEnd(10)} ${verdict}`,
      );
    }
  }

  if (result.notification && result.notification.orders.length > 0) {
    say();
    say(`   ${bold("Purchase orders written")}`);
    for (const order of result.notification.orders) {
      say(`   ${green(G.mail)} ${order.supplierName.padEnd(26)} ${usd(order.valueUsd).padStart(10)}  ${dim(order.file)}`);
    }
  }

  if (result.manualReview) {
    say();
    say(`   ${yellow(bold("Queued for manual review"))} ${dim(result.manualReview.file)}`);
  }

  say();
  rule();
  const tokens = result.record.totalTokens;
  say(
    `${result.ok ? green(bold("SUCCEEDED")) : red(bold("FAILED"))}  ${result.runId} ${G.dot} ${(result.elapsedMs / 1000).toFixed(2)}s ${G.dot} ` +
      `${result.record.events.length} events ${G.dot} ${result.record.planRevisions.length} plan revision(s) ${G.dot} ${tokens.in + tokens.out} tokens`,
  );
  say(`   Report   ${cyan(resolve(result.reportPath))}`);
  say(`   Outbox   ${resolve(result.outboxDir)}`);
  say(`   Replay   npm run replay -- ${result.runId}`);
  rule();
}

function openInBrowser(path: string): void {
  const target = resolve(path);
  const [command, args] =
    process.platform === "win32"
      ? ["cmd", ["/c", "start", "", target]]
      : process.platform === "darwin"
        ? ["open", [target]]
        : ["xdg-open", [target]];
  spawn(command, args as string[], { detached: true, stdio: "ignore" }).unref();
}

/* -------------------------------------------------------------------------- */
/* Recording                                                                  */
/* -------------------------------------------------------------------------- */

function saveFixtures(recorder: RecordingLlmClient, goal: string): string[] {
  mkdirSync(DEMO_FIXTURE_DIR, { recursive: true });
  const written: string[] = [];

  const average = (values: number[]) =>
    values.length === 0 ? 0 : Math.round(values.reduce((s, v) => s + v, 0) / values.length);

  const planning = recorder.bySystem(PLANNER_SYSTEM_PROMPT);
  if (planning.length > 0) {
    const path = join(DEMO_FIXTURE_DIR, "plan.json");
    writeFileSync(
      path,
      `${JSON.stringify(
        {
          goal,
          responses: planning.map((e) => e.response.text),
          tokensIn: average(planning.map((e) => e.response.tokensIn)),
          tokensOut: average(planning.map((e) => e.response.tokensOut)),
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    written.push(path);
  }

  const byFailure = new Map<string, typeof planning>();
  for (const exchange of recorder.bySystem(REPLANNER_SYSTEM_PROMPT)) {
    const failed = /Failed and unusable: (\S+)/.exec(exchange.request.prompt)?.[1] ?? "unknown";
    byFailure.set(failed, [...(byFailure.get(failed) ?? []), exchange]);
  }

  for (const [failed, exchanges] of byFailure) {
    const path = join(DEMO_FIXTURE_DIR, `replan-${failed}.json`);
    writeFileSync(
      path,
      `${JSON.stringify(
        {
          goal: `replan after ${failed} fails`,
          // The goal line appears in the replanner's prompt too; an explicit
          // match keyed on the failure outranks the plan fixture's goal.
          match: `Failed and unusable: ${failed}`,
          responses: exchanges.map((e) => e.response.text),
          tokensIn: average(exchanges.map((e) => e.response.tokensIn)),
          tokensOut: average(exchanges.map((e) => e.response.tokensOut)),
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    written.push(path);
  }

  return written;
}

/* -------------------------------------------------------------------------- */
/* Main                                                                       */
/* -------------------------------------------------------------------------- */

async function main(): Promise<number> {
  const flags = parseFlags(process.argv.slice(2));
  const goal = flags.goal ?? DEMO_GOAL;

  let llm: LlmClient;
  let recorder: RecordingLlmClient | undefined;
  try {
    if (flags.live) {
      const env = flags.model === undefined ? process.env : { ...process.env, GEMINI_MODEL: flags.model };
      const client = createLlmClient({ mode: "gemini", env });
      recorder = flags.record ? new RecordingLlmClient(client) : undefined;
      llm = recorder ?? client;
    } else {
      llm = createLlmClient({ mode: "fixture", fixtureDir: DEMO_FIXTURE_DIR });
    }
  } catch (error) {
    say(red(error instanceof Error ? error.message : String(error)));
    if (!flags.live) say(`No recorded demo fixtures yet. Record them once with: ${bold("npm run demo:record")}`);
    return 1;
  }

  rule();
  say(bold(`MCP-X  ${G.dot}  multi-agent supply-chain orchestration`));
  rule();
  say(`Goal      ${goal}`);
  say(`Planner   ${flags.live ? `${llm.name} ${yellow("(live)")}` : `recorded model output ${dim("(offline replay: no API key, no network)")}`}`);
  say(`Scenario  ${flags.fail ? yellow(`${FAILING_SUPPLIER}'s ordering portal is DOWN`) : "all supplier portals up"}`);

  let result: DemoResult;
  try {
    result = await runSupplyChainDemo({ llm, goal, failPortal: flags.fail, onEvent: narrate });
  } catch (error) {
    say();
    const message = error instanceof Error ? error.message : String(error);
    if (/quota|RESOURCE_EXHAUSTED|429/i.test(message)) {
      say(red(bold("The Gemini free-tier quota is exhausted for this model.")));
      say(`Switch model:   ${bold("npm run demo:live -- --model gemini-3.1-flash-lite")}`);
      say(`Or go offline:  ${bold(flags.fail ? "npm run demo:fail" : "npm run demo")}`);
    } else if (error instanceof LlmError && /No fixture matches/.test(message)) {
      say(red("There is no recorded plan for that goal. Offline mode can only replay what was recorded."));
      say(`Use the live planner: ${bold(`npm run demo:live -- --goal "${goal}"`)}`);
    } else {
      say(red(message));
    }
    return 1;
  }

  printResult(result);

  if (recorder) {
    const written = saveFixtures(recorder, goal);
    say(green(`Recorded ${recorder.exchanges.length} model exchange(s) as offline fixtures:`));
    for (const path of written) say(`   ${path}`);
  }

  if (flags.open) openInBrowser(result.reportPath);
  return result.ok ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  },
);
