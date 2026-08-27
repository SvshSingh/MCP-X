import { beforeEach, describe, expect, it, vi } from "vitest";

const generateContent = vi.fn();

// Mock the SDK so the retry policy can be tested without a network or a key.
vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    models = { generateContent };
  },
}));

const { GeminiClient, isRetryable, statusOf } = await import("@llm/gemini");
const { LlmError } = await import("@llm/types");

const ok = (text: string, tokensIn = 10, tokensOut = 5) => ({
  text,
  usageMetadata: { promptTokenCount: tokensIn, candidatesTokenCount: tokensOut },
});

const withStatus = (status: number) => Object.assign(new Error(`boom ${status}`), { status });

/** No real delays: the client's backoff is injected. */
const client = (over: Record<string, unknown> = {}) =>
  new GeminiClient({
    apiKey: "test-key",
    sleep: () => Promise.resolve(),
    ...over,
  });

beforeEach(() => {
  generateContent.mockReset();
});

/* -------------------------------------------------------------------------- */

describe("statusOf", () => {
  it("reads a numeric status property", () => {
    expect(statusOf({ status: 429 })).toBe(429);
  });

  it("reads code and statusCode too", () => {
    expect(statusOf({ code: 503 })).toBe(503);
    expect(statusOf({ statusCode: 500 })).toBe(500);
  });

  it("reads a nested response.status", () => {
    expect(statusOf({ response: { status: 502 } })).toBe(502);
  });

  it("falls back to scanning the message", () => {
    expect(statusOf(new Error("got a 429 Too Many Requests"))).toBe(429);
  });

  it("returns undefined when there is no status", () => {
    expect(statusOf(new Error("socket hang up"))).toBeUndefined();
    expect(statusOf(null)).toBeUndefined();
    expect(statusOf("string")).toBeUndefined();
  });

  it("ignores out-of-range numbers", () => {
    expect(statusOf({ status: 99 })).toBeUndefined();
    expect(statusOf({ status: 600 })).toBeUndefined();
  });
});

describe("isRetryable", () => {
  it("retries rate limits and server errors", () => {
    for (const status of [408, 429, 500, 502, 503, 504]) {
      expect(isRetryable(withStatus(status)), `status ${status}`).toBe(true);
    }
  });

  it("does not retry client errors", () => {
    for (const status of [400, 401, 403, 404, 422]) {
      expect(isRetryable(withStatus(status)), `status ${status}`).toBe(false);
    }
  });

  it("retries transport failures that never reached the server", () => {
    expect(isRetryable(new Error("ECONNRESET"))).toBe(true);
    expect(isRetryable(new Error("request timed out"))).toBe(true);
    expect(isRetryable(new Error("fetch failed"))).toBe(true);
  });

  it("does not retry an unrecognised error", () => {
    expect(isRetryable(new Error("something odd"))).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */

describe("GeminiClient", () => {
  it("refuses to construct without an API key", () => {
    expect(() => new GeminiClient({ apiKey: "" })).toThrow(LlmError);
  });

  it("returns text and token counts on success", async () => {
    generateContent.mockResolvedValueOnce(ok("hello", 42, 7));

    const result = await client().generate({ prompt: "hi" });

    expect(result).toEqual({ text: "hello", tokensIn: 42, tokensOut: 7 });
  });

  it("defaults token counts to zero when usage is absent", async () => {
    generateContent.mockResolvedValueOnce({ text: "hello" });

    const result = await client().generate({ prompt: "hi" });

    expect(result).toMatchObject({ tokensIn: 0, tokensOut: 0 });
  });

  it("requests JSON mode and temperature when asked", async () => {
    generateContent.mockResolvedValueOnce(ok("{}"));

    await client().generate({ prompt: "hi", json: true, temperature: 0, system: "be terse" });

    const config = generateContent.mock.calls[0]?.[0]?.config;
    expect(config.responseMimeType).toBe("application/json");
    expect(config.temperature).toBe(0);
    expect(config.systemInstruction).toBe("be terse");
  });

  it("omits JSON mode when not asked", async () => {
    generateContent.mockResolvedValueOnce(ok("hi"));

    await client().generate({ prompt: "hi" });

    expect(generateContent.mock.calls[0]?.[0]?.config.responseMimeType).toBeUndefined();
  });

  it("retries a 503 and succeeds", async () => {
    generateContent
      .mockRejectedValueOnce(withStatus(503))
      .mockResolvedValueOnce(ok("recovered"));

    const result = await client().generate({ prompt: "hi" });

    expect(result.text).toBe("recovered");
    expect(generateContent).toHaveBeenCalledTimes(2);
  });

  it("does not retry a 401", async () => {
    generateContent.mockRejectedValue(withStatus(401));

    await expect(client().generate({ prompt: "hi" })).rejects.toThrow(LlmError);
    // A bad key will still be bad on the third try; failing fast is the point.
    expect(generateContent).toHaveBeenCalledTimes(1);
  });

  it("gives up after maxAttempts and reports the status", async () => {
    generateContent.mockRejectedValue(withStatus(429));

    try {
      await client({ maxAttempts: 3 }).generate({ prompt: "hi" });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(LlmError);
      expect((error as InstanceType<typeof LlmError>).status).toBe(429);
      expect((error as InstanceType<typeof LlmError>).retryable).toBe(true);
      expect((error as InstanceType<typeof LlmError>).attempts).toBe(3);
    }
    expect(generateContent).toHaveBeenCalledTimes(3);
  });

  it("backs off exponentially between attempts", async () => {
    const delays: number[] = [];
    generateContent.mockRejectedValue(withStatus(503));

    await client({
      maxAttempts: 4,
      baseDelayMs: 100,
      sleep: (ms: number) => {
        delays.push(ms);
        return Promise.resolve();
      },
    })
      .generate({ prompt: "hi" })
      .catch(() => undefined);

    expect(delays).toEqual([100, 200, 400]);
  });

  it("treats an empty completion as retryable", async () => {
    generateContent.mockResolvedValueOnce({ text: "   " }).mockResolvedValueOnce(ok("real"));

    const result = await client().generate({ prompt: "hi" });

    // Usually a safety block or truncated stream; the same prompt often works.
    expect(result.text).toBe("real");
    expect(generateContent).toHaveBeenCalledTimes(2);
  });

  it("names itself after the model, for the run record", () => {
    expect(client({ model: "gemini-2.5-pro" }).name).toBe("gemini-2.5-pro");
  });
});
