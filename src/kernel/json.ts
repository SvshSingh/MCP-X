/**
 * Recovering JSON from a model completion.
 *
 * Even asked for `application/json`, a model will sometimes wrap its answer in
 * a markdown fence or bracket it with a sentence of explanation. Failing the
 * whole plan over a stray "Here you go:" would burn a retry on nothing, so
 * this degrades through three strategies before giving up.
 */

export class JsonExtractionError extends Error {
  readonly raw: string;

  constructor(message: string, raw: string) {
    super(message);
    this.name = "JsonExtractionError";
    this.raw = raw;
  }
}

/** Strips a leading ```json (or bare ```) fence and its closing counterpart. */
function stripFence(text: string): string | null {
  const match = /^\s*```(?:json|JSON)?\s*\r?\n([\s\S]*?)\r?\n?\s*```\s*$/.exec(text);
  return match?.[1] ?? null;
}

/**
 * Finds the first balanced `{...}` or `[...]` span, tracking string literals
 * so a brace inside a description does not throw off the depth count.
 */
function firstBalancedSpan(text: string): string | null {
  const openIndex = text.search(/[{[]/);
  if (openIndex === -1) return null;

  const opener = text[openIndex];
  const closer = opener === "{" ? "}" : "]";

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = openIndex; i < text.length; i++) {
    const char = text[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\") {
      // Only meaningful inside a string, but harmless outside one.
      escaped = inString;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (char === opener) depth++;
    else if (char === closer) {
      depth--;
      if (depth === 0) return text.slice(openIndex, i + 1);
    }
  }

  return null;
}

/**
 * Parses JSON out of a raw completion.
 *
 * @throws {JsonExtractionError} when no strategy yields valid JSON.
 */
export function extractJson(raw: string): unknown {
  const candidates: string[] = [raw.trim()];

  const unfenced = stripFence(raw);
  if (unfenced !== null) candidates.push(unfenced.trim());

  for (const candidate of [...candidates]) {
    const span = firstBalancedSpan(candidate);
    if (span !== null && span !== candidate) candidates.push(span);
  }

  for (const candidate of candidates) {
    if (candidate === "") continue;
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next strategy.
    }
  }

  throw new JsonExtractionError(
    "Model output did not contain parseable JSON",
    raw.length > 500 ? `${raw.slice(0, 500)}...` : raw,
  );
}
