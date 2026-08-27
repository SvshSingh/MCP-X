import { describe, expect, it } from "vitest";

import { extractJson, JsonExtractionError } from "@kernel/json";

describe("extractJson", () => {
  it("parses clean JSON", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it("parses JSON with surrounding whitespace", () => {
    expect(extractJson('\n\n  {"a":1}  \n')).toEqual({ a: 1 });
  });

  it("parses a top-level array", () => {
    expect(extractJson("[1,2,3]")).toEqual([1, 2, 3]);
  });

  it("strips a ```json fence", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it("strips a bare ``` fence", () => {
    expect(extractJson('```\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it("recovers JSON wrapped in prose", () => {
    const raw = 'Sure! Here is the plan:\n\n{"tasks":[]}\n\nLet me know if that works.';

    expect(extractJson(raw)).toEqual({ tasks: [] });
  });

  it("recovers JSON from a fence surrounded by prose", () => {
    const raw = 'Here you go:\n```json\n{"a":1}\n```\nHope that helps!';

    expect(extractJson(raw)).toEqual({ a: 1 });
  });

  it("is not fooled by braces inside string values", () => {
    const raw = 'Note: {"description":"use {curly} braces","ok":true}';

    expect(extractJson(raw)).toEqual({ description: "use {curly} braces", ok: true });
  });

  it("is not fooled by an escaped quote inside a string", () => {
    const raw = 'x {"description":"say \\"hi\\" loudly","ok":true}';

    expect(extractJson(raw)).toEqual({ description: 'say "hi" loudly', ok: true });
  });

  it("handles nested objects and arrays", () => {
    const raw = 'text {"tasks":[{"id":"a","dependsOn":[]},{"id":"b","dependsOn":["a"]}]} tail';

    expect(extractJson(raw)).toEqual({
      tasks: [
        { id: "a", dependsOn: [] },
        { id: "b", dependsOn: ["a"] },
      ],
    });
  });

  it("throws on output containing no JSON", () => {
    expect(() => extractJson("I cannot help with that.")).toThrow(JsonExtractionError);
  });

  it("throws on an unterminated object", () => {
    expect(() => extractJson('{"a":1')).toThrow(JsonExtractionError);
  });

  it("throws on empty input", () => {
    expect(() => extractJson("")).toThrow(JsonExtractionError);
  });

  it("truncates very long raw output on the error", () => {
    const raw = "x".repeat(2000);

    try {
      extractJson(raw);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(JsonExtractionError);
      expect((error as JsonExtractionError).raw.length).toBeLessThan(600);
    }
  });
});
