/**
 * A deterministic {@link LlmClient} that replays recorded completions.
 *
 * This is what makes the planner testable. Planning is the least
 * deterministic part of the system, so the tests that assert *plan shape* must
 * not also be testing whether Gemini felt cooperative that morning. CI never
 * needs an API key, and a failing planner test always means the parsing or
 * retry logic broke rather than the weather.
 *
 * A fixture may hold several responses. They are returned in order and the
 * last one repeats, which is how the schema-retry loop is exercised
 * deterministically: record an invalid plan followed by a valid one.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { LlmError, type LlmClient, type LlmRequest, type LlmResponse } from "./types.js";

export const Fixture = z
  .object({
    /** Identifies the fixture, and is the default text matched in the prompt. */
    goal: z.string().min(1),
    /**
     * Overrides what is matched against the prompt.
     *
     * Needed because the goal appears in the planner's prompt *and* the
     * replanner's, so a replan fixture must key on something only the
     * replanner says — otherwise one fixture would answer both.
     */
    match: z.string().min(1).optional(),
    /** A single response, or several returned in order (the last repeats). */
    response: z.string().optional(),
    responses: z.array(z.string()).optional(),
    tokensIn: z.number().int().min(0).default(0),
    tokensOut: z.number().int().min(0).default(0),
  })
  .superRefine((fixture, ctx) => {
    const hasOne = fixture.response !== undefined;
    const hasMany = fixture.responses !== undefined && fixture.responses.length > 0;

    if (hasOne === hasMany) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "a fixture needs exactly one of `response` or a non-empty `responses`",
      });
    }
  });

export type Fixture = z.infer<typeof Fixture>;

const normalise = (text: string): string => text.toLowerCase().replace(/\s+/g, " ").trim();

export class FixtureLlmClient implements LlmClient {
  readonly name = "fixture";

  readonly #fixtures: Fixture[];
  readonly #calls = new Map<string, number>();

  constructor(fixtures: readonly Fixture[]) {
    this.#fixtures = [...fixtures];
  }

  /** Number of times a given goal's fixture has been served. */
  callCount(goal: string): number {
    return this.#calls.get(normalise(goal)) ?? 0;
  }

  // `async` so a missing fixture rejects rather than throwing synchronously -
  // an LlmClient must be safe to call with `.catch()`, not only `try/await`.
  async generate(request: LlmRequest): Promise<LlmResponse> {
    const haystack = normalise(`${request.system ?? ""} ${request.prompt}`);

    const matchTextOf = (fixture: Fixture): string => fixture.match ?? fixture.goal;

    // An explicit `match` outranks one defaulting to the goal, then longer
    // beats shorter. Length alone is not enough: a replanner's prompt restates
    // the goal, so a long goal would otherwise capture every replan fixture
    // keyed on a shorter, deliberately chosen marker.
    const fixture = [...this.#fixtures]
      .sort((a, b) => {
        const explicit = Number(b.match !== undefined) - Number(a.match !== undefined);
        return explicit !== 0 ? explicit : matchTextOf(b).length - matchTextOf(a).length;
      })
      .find((candidate) => haystack.includes(normalise(matchTextOf(candidate))));

    if (!fixture) {
      throw new LlmError(
        `No fixture matches this prompt. Known goals: ${
          this.#fixtures.map((f) => `"${f.goal}"`).join(", ") || "(none loaded)"
        }`,
        { retryable: false },
      );
    }

    const key = normalise(fixture.goal);
    const seen = this.#calls.get(key) ?? 0;
    this.#calls.set(key, seen + 1);

    const sequence = fixture.responses ?? [fixture.response ?? ""];
    // Clamp rather than wrap: a retry loop that overruns the recorded script
    // should keep seeing the final answer, not silently restart it.
    const text = sequence[Math.min(seen, sequence.length - 1)] ?? "";

    return { text, tokensIn: fixture.tokensIn, tokensOut: fixture.tokensOut };
  }
}

export const DEFAULT_FIXTURE_DIR = join(process.cwd(), "fixtures", "planner");

/** Loads and validates every `*.json` fixture in a directory. */
export function loadFixtures(dir: string = DEFAULT_FIXTURE_DIR): Fixture[] {
  let entries: string[];

  try {
    entries = readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch (error) {
    throw new LlmError(`Cannot read fixture directory "${dir}"`, {
      retryable: false,
      cause: error,
    });
  }

  return entries.map((name) => {
    const path = join(dir, name);
    const parsed = Fixture.safeParse(JSON.parse(readFileSync(path, "utf8")));

    if (!parsed.success) {
      throw new LlmError(
        `Invalid fixture "${path}": ${parsed.error.issues.map((i) => i.message).join("; ")}`,
        { retryable: false },
      );
    }

    return parsed.data;
  });
}
