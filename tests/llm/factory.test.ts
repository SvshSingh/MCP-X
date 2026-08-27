import { describe, expect, it } from "vitest";

import { createLlmClient } from "@llm/index";
import { FixtureLlmClient } from "@llm/fixture";
import { GeminiClient, DEFAULT_MODEL } from "@llm/gemini";
import { LlmError } from "@llm/types";

describe("createLlmClient", () => {
  it("returns a fixture client when PLANNER_MODE=fixture", () => {
    const client = createLlmClient({ env: { PLANNER_MODE: "fixture" } });

    expect(client).toBeInstanceOf(FixtureLlmClient);
    expect(client.name).toBe("fixture");
  });

  it("returns a fixture client when the mode is passed explicitly", () => {
    expect(createLlmClient({ env: {}, mode: "fixture" })).toBeInstanceOf(FixtureLlmClient);
  });

  it("an explicit mode overrides the environment", () => {
    const client = createLlmClient({
      env: { PLANNER_MODE: "fixture", GEMINI_API_KEY: "k" },
      mode: "gemini",
    });

    expect(client).toBeInstanceOf(GeminiClient);
  });

  it("returns a Gemini client with the default model", () => {
    const client = createLlmClient({ env: { GEMINI_API_KEY: "test-key" } });

    expect(client).toBeInstanceOf(GeminiClient);
    expect(client.name).toBe(DEFAULT_MODEL);
  });

  it("honours a GEMINI_MODEL override", () => {
    const client = createLlmClient({
      env: { GEMINI_API_KEY: "test-key", GEMINI_MODEL: "gemini-2.5-pro" },
    });

    expect(client.name).toBe("gemini-2.5-pro");
  });

  it("points at fixture mode when no API key is configured", () => {
    try {
      createLlmClient({ env: {} });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(LlmError);
      // The message has to name the escape hatch, or a contributor without a
      // key has no way to know the project runs without one.
      expect((error as LlmError).message).toContain("PLANNER_MODE=fixture");
      expect((error as LlmError).retryable).toBe(false);
    }
  });

  it("treats an unrecognised PLANNER_MODE as gemini", () => {
    expect(() => createLlmClient({ env: { PLANNER_MODE: "nonsense" } })).toThrow(LlmError);
  });

  it("loads fixtures from a custom directory", async () => {
    const client = createLlmClient({
      env: {},
      mode: "fixture",
      fixtureDir: "./fixtures/planner",
    });

    const result = await client.generate({
      prompt: "Goal: add 2 and 3 and tell me the answer",
    });

    expect(result.text).toContain("add_numbers");
  });
});
