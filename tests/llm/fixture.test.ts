import { describe, expect, it } from "vitest";

import { Fixture, FixtureLlmClient, loadFixtures } from "@llm/fixture";
import { LlmError } from "@llm/types";

const fixture = (over: Partial<Fixture> & { goal: string }): Fixture =>
  Fixture.parse({ response: "{}", ...over });

describe("Fixture schema", () => {
  it("accepts a single response", () => {
    expect(Fixture.safeParse({ goal: "g", response: "{}" }).success).toBe(true);
  });

  it("accepts a response sequence", () => {
    expect(Fixture.safeParse({ goal: "g", responses: ["{}", "{}"] }).success).toBe(true);
  });

  it("rejects a fixture with neither response nor responses", () => {
    expect(Fixture.safeParse({ goal: "g" }).success).toBe(false);
  });

  it("rejects a fixture with both", () => {
    expect(Fixture.safeParse({ goal: "g", response: "{}", responses: ["{}"] }).success).toBe(
      false,
    );
  });

  it("rejects an empty responses array", () => {
    expect(Fixture.safeParse({ goal: "g", responses: [] }).success).toBe(false);
  });
});

describe("FixtureLlmClient", () => {
  it("matches a fixture by goal appearing in the prompt", async () => {
    const client = new FixtureLlmClient([fixture({ goal: "ship it", response: "OK" })]);

    const result = await client.generate({ prompt: "Goal: ship it\n\nPlan please." });

    expect(result.text).toBe("OK");
  });

  it("matches case- and whitespace-insensitively", async () => {
    const client = new FixtureLlmClient([fixture({ goal: "Ship  It", response: "OK" })]);

    const result = await client.generate({ prompt: "goal: ship it" });

    expect(result.text).toBe("OK");
  });

  it("also searches the system prompt", async () => {
    const client = new FixtureLlmClient([fixture({ goal: "ship it", response: "OK" })]);

    const result = await client.generate({ prompt: "x", system: "context: ship it" });

    expect(result.text).toBe("OK");
  });

  it("prefers the longest matching goal", async () => {
    const client = new FixtureLlmClient([
      fixture({ goal: "ship", response: "SHORT" }),
      fixture({ goal: "ship the thing", response: "LONG" }),
    ]);

    const result = await client.generate({ prompt: "Goal: ship the thing" });

    expect(result.text).toBe("LONG");
  });

  it("returns responses in order and repeats the last", async () => {
    const client = new FixtureLlmClient([
      fixture({ goal: "g", response: undefined, responses: ["first", "second"] }),
    ]);

    expect((await client.generate({ prompt: "g" })).text).toBe("first");
    expect((await client.generate({ prompt: "g" })).text).toBe("second");
    // Clamped, not wrapped: overrunning the script keeps the final answer.
    expect((await client.generate({ prompt: "g" })).text).toBe("second");
  });

  it("counts calls per goal", async () => {
    const client = new FixtureLlmClient([fixture({ goal: "g", response: "x" })]);

    await client.generate({ prompt: "g" });
    await client.generate({ prompt: "g" });

    expect(client.callCount("g")).toBe(2);
    expect(client.callCount("other")).toBe(0);
  });

  it("reports token counts from the fixture", async () => {
    const client = new FixtureLlmClient([
      fixture({ goal: "g", response: "x", tokensIn: 11, tokensOut: 22 }),
    ]);

    const result = await client.generate({ prompt: "g" });

    expect(result).toMatchObject({ tokensIn: 11, tokensOut: 22 });
  });

  it("throws a listing error when no fixture matches", async () => {
    const client = new FixtureLlmClient([fixture({ goal: "known goal", response: "x" })]);

    await expect(client.generate({ prompt: "something else" })).rejects.toThrow(
      /known goal/,
    );
  });
});

describe("loadFixtures", () => {
  it("loads and validates the repo's planner fixtures", () => {
    const fixtures = loadFixtures();

    expect(fixtures.length).toBeGreaterThanOrEqual(3);
    expect(fixtures.map((f) => f.goal)).toContain(
      "post a summary of today's top HN story to Twitter",
    );
  });

  it("throws a clear error for a missing directory", () => {
    expect(() => loadFixtures("./does-not-exist-anywhere")).toThrow(LlmError);
  });
});
