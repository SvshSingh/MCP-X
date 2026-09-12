/**
 * Pre-flight check for a live demo.
 *
 *   npm run doctor            everything that needs no network (~1 second)
 *   npm run doctor -- --live  also spends one API call per model to check quota
 *
 * Run it a few minutes before sharing a screen. Every check here is something
 * that would otherwise be discovered by an audience: a missing install, stale
 * fixtures, a console that garbles the output, or a free-tier quota that ran
 * out during rehearsal.
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GoogleGenAI } from "@google/genai";

import { DEMO_FIXTURE_DIR, runSupplyChainDemo } from "../demo/supply-chain.js";
import { loadWarehouse } from "../domain/supply-chain/warehouse.js";
import { createLlmClient, ensureDotenv } from "../llm/index.js";

type Status = "PASS" | "WARN" | "FAIL";
const results: { status: Status; name: string; detail: string }[] = [];
const record = (status: Status, name: string, detail: string) => {
  results.push({ status, name, detail });
  console.log(`  ${status === "PASS" ? "PASS" : status === "WARN" ? "WARN" : "FAIL"}  ${name.padEnd(26)} ${detail}`);
};

async function check(name: string, fn: () => Promise<[Status, string]> | [Status, string]) {
  try {
    const [status, detail] = await fn();
    record(status, name, detail);
  } catch (error) {
    record("FAIL", name, error instanceof Error ? error.message : String(error));
  }
}

async function main(): Promise<number> {
  const live = process.argv.includes("--live");
  ensureDotenv();

  console.log("MCP-X demo pre-flight\n");

  await check("Node version", () => {
    const major = Number(process.versions.node.split(".")[0]);
    return major >= 20 ? ["PASS", `v${process.versions.node}`] : ["FAIL", `v${process.versions.node}; needs 20+`];
  });

  await check("Dependencies installed", () =>
    existsSync(join("node_modules", "zod")) && existsSync(join("node_modules", "@google", "genai"))
      ? ["PASS", "node_modules present"]
      : ["FAIL", "run: npm install"],
  );

  await check("Warehouse dataset", () => {
    const w = loadWarehouse();
    return ["PASS", `${w.warehouse}: ${w.skus.length} SKUs, ${w.suppliers.length} suppliers`];
  });

  await check("Offline demo fixtures", () => {
    if (!existsSync(DEMO_FIXTURE_DIR)) return ["FAIL", "missing; record with: npm run demo:record"];
    const files = readdirSync(DEMO_FIXTURE_DIR);
    const hasPlan = files.includes("plan.json");
    const hasReplan = files.some((f) => f.startsWith("replan-"));
    if (hasPlan && hasReplan) return ["PASS", files.join(", ")];
    return ["FAIL", `incomplete (${files.join(", ") || "empty"}); re-record with: npm run demo:record`];
  });

  await check("Output folders writable", () => {
    for (const dir of ["runs", join("demo", "outbox")]) {
      mkdirSync(dir, { recursive: true });
      const probe = join(dir, `.doctor-${process.pid}`);
      writeFileSync(probe, "ok", { flag: "w" });
      rmSync(probe);
    }
    return ["PASS", "runs/ and demo/outbox/"];
  });

  // The real proof: run both scenarios end to end, offline, in a scratch folder.
  for (const fail of [false, true]) {
    await check(fail ? "Dry run: portal down" : "Dry run: normal", async () => {
      const scratch = mkdtempSync(join(tmpdir(), "mcpx-doctor-"));
      try {
        const result = await runSupplyChainDemo({
          llm: createLlmClient({ mode: "fixture", fixtureDir: DEMO_FIXTURE_DIR, env: {} }),
          failPortal: fail,
          outboxDir: join(scratch, "outbox"),
          runDir: join(scratch, "runs"),
        });
        if (!result.ok) return ["FAIL", "run did not succeed"];
        if (fail && result.record.planRevisions.length < 2) return ["FAIL", "expected a replan and none happened"];
        return [
          "PASS",
          fail
            ? `replanned to ${result.finalPlan.tasks.at(-1)?.tool ?? "?"} in ${result.elapsedMs}ms`
            : `${result.notification?.orders.length ?? 0} purchase orders in ${result.elapsedMs}ms`,
        ];
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    });
  }

  await check("Console encoding", () => {
    if (process.platform !== "win32") return ["PASS", "not Windows"];
    const page = /(\d+)/.exec(execSync("chcp", { encoding: "utf8" }))?.[1];
    return page === "65001"
      ? ["PASS", "UTF-8 code page"]
      : ["WARN", `code page ${page ?? "?"}: symbols may garble; add --plain, or run "chcp 65001" first`];
  });

  const key = process.env["GEMINI_API_KEY"];
  await check("Gemini API key", () =>
    key ? ["PASS", "set (live demo available)"] : ["WARN", "not set: offline demo only, which needs no key"],
  );

  if (live && key) {
    const ai = new GoogleGenAI({ apiKey: key });
    for (const model of [process.env["GEMINI_MODEL"] ?? "gemini-3.6-flash", "gemini-3.1-flash-lite"]) {
      await check(`Live quota: ${model}`, async () => {
        try {
          await ai.models.generateContent({ model, contents: "Reply with the single word ok." });
          return ["PASS", "responding"];
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (/PerDay/.test(message)) return ["WARN", "daily free-tier quota used up; use the other model or go offline"];
          if (/PerMinute/.test(message)) return ["WARN", "per-minute limit hit; wait a minute"];
          return ["FAIL", message.slice(0, 90)];
        }
      });
    }
  } else if (!live) {
    console.log(`  ....  ${"Live quota".padEnd(26)} skipped (add --live to spend one call per model)`);
  }

  const failed = results.filter((r) => r.status === "FAIL").length;
  const warned = results.filter((r) => r.status === "WARN").length;
  console.log(
    `\n${failed === 0 ? "Ready." : "Not ready."} ${results.length - failed - warned} passed, ${warned} warning(s), ${failed} failure(s).`,
  );
  if (failed === 0) {
    console.log("\nDemo commands:  npm run demo   |   npm run demo:fail   |   npm run demo:live");
  }
  return failed === 0 ? 0 : 1;
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
