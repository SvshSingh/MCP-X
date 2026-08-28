/**
 * Which specialist owns which tools.
 *
 * The point of specialists is that no single model context holds every tool.
 * A task is routed to one agent, and that agent can only reach the tools it
 * declares — an ownership boundary the runtime enforces rather than merely
 * documents.
 *
 * Phase 4 of ORCHESTRATOR_PLAN.md.
 */

import { z } from "zod";

import { Capability, TOOLS, type ToolDefinition, type ToolResult } from "../mcp/tools.js";

export const AgentDefinition = z.object({
  name: z.string().min(1),
  /** Shown to the classifier, so it must read as a capability boundary. */
  description: z.string().min(1),
  capability: Capability,
  /** Tool names this agent may invoke. */
  tools: z.array(z.string()).default([]),
  /**
   * Lexical cues for the deterministic fallback classifier. Not used when an
   * LLM is available; they exist so routing works, and is testable, with no
   * network at all.
   */
  keywords: z.array(z.string()).default([]),
});
export type AgentDefinition = z.infer<typeof AgentDefinition>;

export class UnknownAgentError extends Error {
  constructor(name: string, known: readonly string[]) {
    super(`Unknown agent "${name}". Registered: ${known.join(", ")}`);
    this.name = "UnknownAgentError";
  }
}

export class ToolAccessError extends Error {
  constructor(agent: string, tool: string, owned: readonly string[]) {
    super(
      `Agent "${agent}" may not use tool "${tool}". It owns: ${owned.join(", ") || "(none)"}`,
    );
    this.name = "ToolAccessError";
  }
}

export class AgentRegistry {
  readonly #agents: Map<string, AgentDefinition>;

  constructor(agents: readonly AgentDefinition[]) {
    if (agents.length === 0) throw new Error("An agent registry needs at least one agent");

    this.#agents = new Map();
    for (const agent of agents) {
      if (this.#agents.has(agent.name)) {
        throw new Error(`Duplicate agent name "${agent.name}"`);
      }
      this.#agents.set(agent.name, AgentDefinition.parse(agent));
    }
  }

  get agents(): readonly AgentDefinition[] {
    return [...this.#agents.values()];
  }

  get names(): string[] {
    return [...this.#agents.keys()];
  }

  has(name: string): boolean {
    return this.#agents.has(name);
  }

  get(name: string): AgentDefinition {
    const agent = this.#agents.get(name);
    if (!agent) throw new UnknownAgentError(name, this.names);
    return agent;
  }

  /** The agent owning a given tool, if any. */
  ownerOf(tool: string): AgentDefinition | undefined {
    return this.agents.find((agent) => agent.tools.includes(tool));
  }

  /** Rendered for the classifier prompt. */
  describe(): string {
    return this.agents
      .map(
        (agent) =>
          `- ${agent.name}: ${agent.description} (tools: ${
            agent.tools.join(", ") || "none"
          })`,
      )
      .join("\n");
  }
}

/* -------------------------------------------------------------------------- */
/* The specialists                                                            */
/* -------------------------------------------------------------------------- */

export const RESEARCH_AGENT: AgentDefinition = AgentDefinition.parse({
  name: "research",
  description:
    "Gathers information from outside the system: fetching pages and feeds, looking things up, reading and extracting source material. Does not transform or publish.",
  capability: "research",
  tools: [],
  keywords: [
    "fetch",
    "retrieve",
    "search",
    "look up",
    "lookup",
    "gather",
    "collect",
    "find",
    "read",
    "scrape",
    "crawl",
    "browse",
    "query",
    "check",
    "inspect",
    "monitor",
    "download",
    "load",
    "identify",
  ],
});

export const COMPUTE_AGENT: AgentDefinition = AgentDefinition.parse({
  name: "compute",
  description:
    "Transforms information already in hand: arithmetic, summarising, drafting, formatting, filtering, ranking. Does not reach the network or publish.",
  capability: "compute",
  tools: ["addTwoNumbers"],
  keywords: [
    "calculate",
    "compute",
    "add",
    "sum",
    "subtract",
    "multiply",
    "count",
    "summarise",
    "summarize",
    "condense",
    "draft",
    "compose",
    "write",
    "generate",
    "format",
    "convert",
    "transform",
    "analyse",
    "analyze",
    "cross-reference",
    "reconcile",
    "rank",
    "list",
    "tabulate",
    "sort",
    "filter",
    "compare",
    "validate",
    "score",
  ],
});

export const PUBLISH_AGENT: AgentDefinition = AgentDefinition.parse({
  name: "publish",
  description:
    "Writes to the outside world: posting, sending, notifying. The only agent with side effects visible to anyone else, so nothing else may hold these tools.",
  capability: "publish",
  tools: ["createPost"],
  keywords: [
    "post",
    "publish",
    "tweet",
    "send",
    "notify",
    "email",
    "share",
    "announce",
    "submit",
    "upload",
    "deliver",
    "distribute",
    "broadcast",
    "alert",
  ],
});

export const DEFAULT_AGENTS: readonly AgentDefinition[] = [
  RESEARCH_AGENT,
  COMPUTE_AGENT,
  PUBLISH_AGENT,
];

export const defaultRegistry = (): AgentRegistry => new AgentRegistry(DEFAULT_AGENTS);

/* -------------------------------------------------------------------------- */
/* Specialist wrapper                                                         */
/* -------------------------------------------------------------------------- */

/**
 * A thin wrapper binding an agent definition to the tools it may invoke.
 *
 * The ownership rule is enforced here rather than trusted: asking the publish
 * agent to run a research tool throws. Without that, "specialists" would be a
 * naming convention, and the whole reason to split them — that a publish
 * action cannot happen from a context that was only meant to read — would rest
 * on nothing.
 */
export class SpecialistAgent {
  readonly definition: AgentDefinition;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly #tools: Map<string, ToolDefinition<any>>;

  constructor(
    definition: AgentDefinition,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    allTools: readonly ToolDefinition<any>[] = TOOLS,
  ) {
    this.definition = definition;
    this.#tools = new Map(
      allTools.filter((tool) => definition.tools.includes(tool.name)).map((t) => [t.name, t]),
    );
  }

  get name(): string {
    return this.definition.name;
  }

  /** Tool names this agent can actually reach (declared *and* available). */
  get toolNames(): string[] {
    return [...this.#tools.keys()];
  }

  canUse(tool: string): boolean {
    return this.#tools.has(tool);
  }

  async invoke(tool: string, args: unknown): Promise<ToolResult> {
    const definition = this.#tools.get(tool);
    if (!definition) {
      throw new ToolAccessError(this.name, tool, this.definition.tools);
    }

    const parsed = z.object(definition.schema).safeParse(args);
    if (!parsed.success) {
      throw new Error(
        `Invalid arguments for "${tool}": ${parsed.error.issues
          .map((i) => `${i.path.join(".")} ${i.message}`)
          .join("; ")}`,
      );
    }

    return definition.handler(parsed.data);
  }
}

export const buildSpecialists = (
  registry: AgentRegistry = defaultRegistry(),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  allTools: readonly ToolDefinition<any>[] = TOOLS,
): Map<string, SpecialistAgent> =>
  new Map(
    registry.agents.map((definition) => [
      definition.name,
      new SpecialistAgent(definition, allTools),
    ]),
  );
