import { describe, expect, it, vi } from "vitest";

import {
  addTwoNumbers,
  makeCreatePost,
  readTwitterCredentials,
  TOOLS,
  toolsByCapability,
  TWEET_MAX_LENGTH,
} from "@mcp/tools";
import { resolvePort, DEFAULT_PORT } from "@mcp/server";

const creds = {
  TWITTER_API_KEY: "k",
  TWITTER_API_SECRET: "s",
  TWITTER_ACCESS_TOKEN: "t",
  TWITTER_ACCESS_TOKEN_SECRET: "ts",
};

describe("addTwoNumbers", () => {
  it("adds and reports the sum", async () => {
    const result = await addTwoNumbers.handler({ a: 2, b: 3 });

    expect(result.content[0]?.text).toBe("The sum of 2 and 3 is 5");
    expect(result.isError).toBeUndefined();
  });

  it("handles negatives and zero", async () => {
    expect((await addTwoNumbers.handler({ a: -4, b: 4 })).content[0]?.text).toContain("is 0");
  });

  it("is classed as a compute capability", () => {
    expect(addTwoNumbers.capability).toBe("compute");
  });
});

describe("readTwitterCredentials", () => {
  it("returns credentials when all four are present", () => {
    expect(readTwitterCredentials(creds)).toEqual({
      appKey: "k",
      appSecret: "s",
      accessToken: "t",
      accessSecret: "ts",
    });
  });

  it("returns null when any one is missing", () => {
    for (const key of Object.keys(creds)) {
      const partial = { ...creds, [key]: "" };
      expect(readTwitterCredentials(partial), `missing ${key}`).toBeNull();
    }
  });

  it("returns null for an empty environment", () => {
    expect(readTwitterCredentials({})).toBeNull();
  });
});

describe("createPost", () => {
  it("posts and confirms", async () => {
    const post = vi.fn().mockResolvedValue(undefined);
    const tool = makeCreatePost({ env: creds, post });

    const result = await tool.handler({ status: "hello world" });

    expect(post).toHaveBeenCalledWith("hello world", expect.objectContaining({ appKey: "k" }));
    expect(result.content[0]?.text).toBe("Tweeted: hello world");
    expect(result.isError).toBeUndefined();
  });

  it("reports missing credentials as a tool error rather than throwing", async () => {
    const post = vi.fn();
    const tool = makeCreatePost({ env: {}, post });

    const result = await tool.handler({ status: "hello" });

    // The orchestrator can route around a failed tool; it cannot route around
    // a module that throws at import time, which is what the original did.
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("TWITTER_API_KEY");
    expect(post).not.toHaveBeenCalled();
  });

  it("rejects an over-length status before calling the API", async () => {
    const post = vi.fn();
    const tool = makeCreatePost({ env: creds, post });

    const result = await tool.handler({ status: "x".repeat(TWEET_MAX_LENGTH + 1) });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("281");
    expect(post).not.toHaveBeenCalled();
  });

  it("accepts a status exactly at the limit", async () => {
    const post = vi.fn().mockResolvedValue(undefined);
    const tool = makeCreatePost({ env: creds, post });

    const result = await tool.handler({ status: "x".repeat(TWEET_MAX_LENGTH) });

    expect(result.isError).toBeUndefined();
    expect(post).toHaveBeenCalledOnce();
  });

  it("turns an API failure into a tool error", async () => {
    const post = vi.fn().mockRejectedValue(new Error("rate limited"));
    const tool = makeCreatePost({ env: creds, post });

    const result = await tool.handler({ status: "hello" });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("rate limited");
  });

  it("is classed as a publish capability", () => {
    expect(makeCreatePost().capability).toBe("publish");
  });
});

describe("tool registry", () => {
  it("exposes both ported tools", () => {
    expect(TOOLS.map((t) => t.name).sort()).toEqual(["addTwoNumbers", "createPost"]);
  });

  it("groups tools by the capability the classifier will route on", () => {
    expect(toolsByCapability()).toEqual({
      research: [],
      compute: ["addTwoNumbers"],
      publish: ["createPost"],
    });
  });
});

describe("resolvePort", () => {
  it("defaults when unset", () => {
    expect(resolvePort({})).toBe(DEFAULT_PORT);
  });

  it("reads MCP_PORT, then PORT", () => {
    expect(resolvePort({ MCP_PORT: "4000" })).toBe(4000);
    expect(resolvePort({ PORT: "5000" })).toBe(5000);
    expect(resolvePort({ MCP_PORT: "4000", PORT: "5000" })).toBe(4000);
  });

  it("falls back to the default for nonsense values", () => {
    for (const raw of ["", "abc", "0", "-1", "70000", "3.5"]) {
      expect(resolvePort({ MCP_PORT: raw }), `raw "${raw}"`).toBe(DEFAULT_PORT);
    }
  });
});
