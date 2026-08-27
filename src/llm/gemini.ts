/**
 * Gemini implementation of {@link LlmClient}.
 *
 * Ported from the original `client/index.js`, which called the SDK inline in a
 * chat loop with no retry and no token accounting. Both are added here because
 * the orchestrator needs them: a transient 503 mid-run should not fail a task
 * that would succeed on the next attempt, and Phase 5 cannot price a run
 * without per-call token counts.
 */

import { GoogleGenAI } from "@google/genai";

import { LlmError, type LlmClient, type LlmRequest, type LlmResponse } from "./types.js";

export const DEFAULT_MODEL = "gemini-2.0-flash";

/** Statuses worth retrying: rate limits, and the server-side 5xx family. */
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

export interface GeminiClientOptions {
  apiKey: string;
  model?: string;
  /** Total attempts including the first. */
  maxAttempts?: number;
  /** Base delay for exponential backoff, doubled per attempt. */
  baseDelayMs?: number;
  /** Injectable so tests do not actually wait. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Best-effort extraction of an HTTP status from an SDK error. The SDK does not
 * expose a stable typed error, so this reads the shapes it is known to
 * produce and falls back to scanning the message.
 */
export function statusOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;

  const record = error as Record<string, unknown>;

  for (const key of ["status", "code", "statusCode"]) {
    const value = record[key];
    if (typeof value === "number" && value >= 100 && value < 600) return value;
  }

  const nested = record["response"];
  if (typeof nested === "object" && nested !== null) {
    const status = (nested as Record<string, unknown>)["status"];
    if (typeof status === "number") return status;
  }

  const message = typeof record["message"] === "string" ? record["message"] : "";
  const match = /\b(4\d{2}|5\d{2})\b/.exec(message);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

export function isRetryable(error: unknown): boolean {
  // An LlmError has already classified itself - trust it over any heuristic.
  if (error instanceof LlmError) return error.retryable;

  const status = statusOf(error);
  if (status !== undefined) return RETRYABLE_STATUSES.has(status);

  // No status at all usually means the request never landed - DNS, socket
  // reset, timeout. Those are worth one more try.
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return /timeout|timed out|econnreset|enotfound|econnrefused|socket hang up|fetch failed|network/.test(
    message,
  );
}

export class GeminiClient implements LlmClient {
  readonly name: string;

  readonly #ai: GoogleGenAI;
  readonly #model: string;
  readonly #maxAttempts: number;
  readonly #baseDelayMs: number;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(options: GeminiClientOptions) {
    if (!options.apiKey) {
      throw new LlmError("GEMINI_API_KEY is not set", { retryable: false });
    }

    this.#model = options.model ?? DEFAULT_MODEL;
    this.#maxAttempts = options.maxAttempts ?? 3;
    this.#baseDelayMs = options.baseDelayMs ?? 500;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#ai = new GoogleGenAI({ apiKey: options.apiKey });
    this.name = this.#model;
  }

  async generate(request: LlmRequest): Promise<LlmResponse> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.#maxAttempts; attempt++) {
      try {
        return await this.#callOnce(request);
      } catch (error) {
        lastError = error;

        if (!isRetryable(error) || attempt === this.#maxAttempts) break;

        // Exponential backoff: 500ms, 1s, 2s...
        await this.#sleep(this.#baseDelayMs * 2 ** (attempt - 1));
      }
    }

    const status = statusOf(lastError);
    throw new LlmError(
      `Gemini request failed after ${this.#maxAttempts} attempt(s): ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`,
      {
        retryable: isRetryable(lastError),
        attempts: this.#maxAttempts,
        cause: lastError,
        ...(status === undefined ? {} : { status }),
      },
    );
  }

  async #callOnce(request: LlmRequest): Promise<LlmResponse> {
    const response = await this.#ai.models.generateContent({
      model: this.#model,
      contents: request.prompt,
      config: {
        temperature: request.temperature ?? 0,
        ...(request.system === undefined ? {} : { systemInstruction: request.system }),
        ...(request.json === true ? { responseMimeType: "application/json" } : {}),
        ...(request.maxOutputTokens === undefined
          ? {}
          : { maxOutputTokens: request.maxOutputTokens }),
      },
    });

    const text = response.text;
    if (text === undefined || text.trim() === "") {
      // An empty completion is usually a safety block or a truncated stream.
      // Retryable: the same prompt often succeeds on a second call.
      throw new LlmError("Gemini returned an empty completion", { retryable: true });
    }

    const usage = response.usageMetadata;

    return {
      text,
      tokensIn: usage?.promptTokenCount ?? 0,
      tokensOut: usage?.candidatesTokenCount ?? 0,
    };
  }
}
