/**
 * Structured, line-oriented logging tagged with a run id.
 *
 * `npm run execute` is the only place this project prints live progress, and
 * its output is currently anonymous prose — a line reading `-> fetch_top_story
 * [research] attempt 1` carries no indication of which run produced it. That's
 * invisible for a single foreground run, but becomes a real problem the moment
 * output from two runs is interleaved (a CI job running the suite, several
 * terminals, a log aggregator) and there's nothing to `grep` on.
 *
 * Deliberately minimal: a prefix, not a framework. The only consumer of these
 * lines today is a human watching a terminal, so a leveled logging library
 * would be solving a problem this project doesn't have yet.
 *
 * Phase 8 of ORCHESTRATOR_PLAN.md.
 */

export interface RunLogger {
  info(message: string): void;
  error(message: string): void;
  /** A blank line for visual spacing, still tagged so `grep -v` on the runId still works. */
  blank(): void;
}

export interface LogSink {
  log: (message: string) => void;
  error: (message: string) => void;
}

const consoleSink: LogSink = {
  log: (message) => {
    console.log(message);
  },
  error: (message) => {
    console.error(message);
  },
};

export function createRunLogger(runId: string, sink: LogSink = consoleSink): RunLogger {
  const tag = `[${runId}]`;

  return {
    info: (message) => sink.log(`${tag} ${message}`),
    error: (message) => sink.error(`${tag} ${message}`),
    blank: () => sink.log(tag),
  };
}
