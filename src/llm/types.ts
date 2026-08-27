/**
 * The LLM boundary.
 *
 * The kernel depends on this interface, never on a vendor SDK. Two reasons
 * beyond the usual: tests need a client that answers instantly and
 * deterministically, and the planner's retry loop needs token counts per call
 * so a run's cost is the sum of real measurements rather than an estimate.
 */

export interface LlmRequest {
  prompt: string;
  /** Steers the model's role. Sent separately from the user turn. */
  system?: string;
  /** Ask the provider for strict JSON rather than prose that contains JSON. */
  json?: boolean;
  /** 0 for planning: we want the most probable decomposition, not a creative one. */
  temperature?: number;
  maxOutputTokens?: number;
}

export interface LlmResponse {
  text: string;
  tokensIn: number;
  tokensOut: number;
}

export interface LlmClient {
  /** Identifies the provider in run records, e.g. "gemini-2.0-flash" or "fixture". */
  readonly name: string;
  generate(request: LlmRequest): Promise<LlmResponse>;
}

/**
 * Thrown when a provider fails in a way retrying cannot fix, or when retries
 * are exhausted. `retryable` lets callers distinguish "the model is
 * overloaded" from "your API key is wrong".
 */
export class LlmError extends Error {
  readonly retryable: boolean;
  readonly status: number | undefined;
  readonly attempts: number;

  constructor(
    message: string,
    options: { retryable: boolean; status?: number; attempts?: number; cause?: unknown },
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "LlmError";
    this.retryable = options.retryable;
    this.status = options.status;
    this.attempts = options.attempts ?? 1;
  }
}
