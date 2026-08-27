/**
 * Chooses the LLM client from the environment.
 *
 * `PLANNER_MODE=fixture` is the switch that lets the whole pipeline run - and
 * CI run it - with no API key and no network.
 */

import { config as loadDotenv } from "dotenv";

import { FixtureLlmClient, loadFixtures } from "./fixture.js";
import { GeminiClient } from "./gemini.js";
import { LlmError, type LlmClient } from "./types.js";

export * from "./types.js";
export { GeminiClient, DEFAULT_MODEL, isRetryable, statusOf } from "./gemini.js";
export { FixtureLlmClient, loadFixtures, DEFAULT_FIXTURE_DIR, Fixture } from "./fixture.js";

export type LlmMode = "gemini" | "fixture";

export interface CreateLlmOptions {
  env?: NodeJS.ProcessEnv;
  /** Overrides `PLANNER_MODE`. */
  mode?: LlmMode;
  fixtureDir?: string;
}

let dotenvLoaded = false;

/** Loads `.env` once per process, without clobbering real environment values. */
export function ensureDotenv(): void {
  if (dotenvLoaded) return;
  loadDotenv();
  dotenvLoaded = true;
}

export function createLlmClient(options: CreateLlmOptions = {}): LlmClient {
  ensureDotenv();

  const env = options.env ?? process.env;
  const mode = options.mode ?? (env["PLANNER_MODE"] === "fixture" ? "fixture" : "gemini");

  if (mode === "fixture") {
    return new FixtureLlmClient(loadFixtures(options.fixtureDir));
  }

  const apiKey = env["GEMINI_API_KEY"];
  if (!apiKey) {
    throw new LlmError(
      "GEMINI_API_KEY is not set. Add it to .env, or run with PLANNER_MODE=fixture to use recorded responses.",
      { retryable: false },
    );
  }

  return new GeminiClient({
    apiKey,
    ...(env["GEMINI_MODEL"] === undefined ? {} : { model: env["GEMINI_MODEL"] }),
  });
}
