/**
 * Wraps a real client and keeps every exchange, so a live run can be saved as
 * replay fixtures.
 *
 * This is how the offline demo stays honest. Its fixtures are what the model
 * actually said during a real run, captured in order — including any rejected
 * attempts the repair loop had to fix — rather than JSON written to look like
 * what a model might say.
 */

import type { LlmClient, LlmRequest, LlmResponse } from "./types.js";

export interface RecordedExchange {
  request: LlmRequest;
  response: LlmResponse;
}

export class RecordingLlmClient implements LlmClient {
  readonly name: string;
  readonly exchanges: RecordedExchange[] = [];

  constructor(private readonly inner: LlmClient) {
    this.name = inner.name;
  }

  async generate(request: LlmRequest): Promise<LlmResponse> {
    const response = await this.inner.generate(request);
    this.exchanges.push({ request, response });
    return response;
  }

  /** Exchanges whose system prompt is exactly `system`, in call order. */
  bySystem(system: string): RecordedExchange[] {
    return this.exchanges.filter((exchange) => exchange.request.system === system);
  }
}
