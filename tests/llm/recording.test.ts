import { describe, expect, it } from "vitest";

import { RecordingLlmClient } from "../../src/llm/recording.js";
import type { LlmClient } from "../../src/llm/types.js";

const echo: LlmClient = {
  name: "echo-model",
  generate: (request) => Promise.resolve({ text: `re: ${request.prompt}`, tokensIn: 3, tokensOut: 2 }),
};

describe("RecordingLlmClient", () => {
  it("passes calls through and keeps each exchange in order", async () => {
    const recorder = new RecordingLlmClient(echo);

    const first = await recorder.generate({ prompt: "one", system: "A" });
    await recorder.generate({ prompt: "two", system: "B" });

    expect(first.text).toBe("re: one");
    expect(recorder.exchanges.map((e) => e.request.prompt)).toEqual(["one", "two"]);
  });

  it("reports the wrapped client's name, so run records show the real model", () => {
    expect(new RecordingLlmClient(echo).name).toBe("echo-model");
  });

  it("filters exchanges by system prompt", async () => {
    const recorder = new RecordingLlmClient(echo);
    await recorder.generate({ prompt: "p1", system: "planner" });
    await recorder.generate({ prompt: "r1", system: "replanner" });
    await recorder.generate({ prompt: "p2", system: "planner" });

    expect(recorder.bySystem("planner").map((e) => e.request.prompt)).toEqual(["p1", "p2"]);
  });

  it("records nothing for a call that failed", async () => {
    const failing = new RecordingLlmClient({ name: "x", generate: () => Promise.reject(new Error("quota")) });

    await expect(failing.generate({ prompt: "p" })).rejects.toThrow("quota");
    expect(failing.exchanges).toEqual([]);
  });
});
