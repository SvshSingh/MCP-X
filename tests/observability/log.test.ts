import { describe, expect, it, vi } from "vitest";

import { createRunLogger, type LogSink } from "@obs/log";

const captor = (): { sink: LogSink; log: string[]; err: string[] } => {
  const log: string[] = [];
  const err: string[] = [];
  return {
    sink: { log: (m) => log.push(m), error: (m) => err.push(m) },
    log,
    err,
  };
};

describe("createRunLogger", () => {
  it("prefixes info lines with the run id", () => {
    const { sink, log } = captor();
    createRunLogger("run-abc", sink).info("fetch_top_story started");

    expect(log).toEqual(["[run-abc] fetch_top_story started"]);
  });

  it("prefixes error lines the same way, on the error sink", () => {
    const { sink, err } = captor();
    createRunLogger("run-abc", sink).error("replan unavailable");

    expect(err).toEqual(["[run-abc] replan unavailable"]);
  });

  it("info never writes to the error sink, and vice versa", () => {
    const { sink, log, err } = captor();
    const logger = createRunLogger("run-abc", sink);

    logger.info("a");
    logger.error("b");

    expect(log).toEqual(["[run-abc] a"]);
    expect(err).toEqual(["[run-abc] b"]);
  });

  it("tags a blank line rather than emitting a bare newline", () => {
    const { sink, log } = captor();
    createRunLogger("run-abc", sink).blank();

    // Even spacing carries the tag, so filtering by run id never drops it.
    expect(log).toEqual(["[run-abc]"]);
  });

  it("uses a distinct tag per run id", () => {
    const { sink, log } = captor();

    createRunLogger("run-1", sink).info("x");
    createRunLogger("run-2", sink).info("x");

    expect(log).toEqual(["[run-1] x", "[run-2] x"]);
  });

  it("defaults to the console sink when none is supplied", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const logger = createRunLogger("run-abc");
    logger.info("hello");
    logger.error("oops");

    expect(logSpy).toHaveBeenCalledWith("[run-abc] hello");
    expect(errorSpy).toHaveBeenCalledWith("[run-abc] oops");

    logSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
