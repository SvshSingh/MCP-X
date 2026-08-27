import { describe, expect, it } from "vitest";

import {
  AgentDefinition,
  AgentRegistry,
  buildSpecialists,
  COMPUTE_AGENT,
  DEFAULT_AGENTS,
  defaultRegistry,
  PUBLISH_AGENT,
  RESEARCH_AGENT,
  SpecialistAgent,
  ToolAccessError,
  UnknownAgentError,
} from "@agents/registry";
import { TOOLS } from "@mcp/tools";

describe("AgentDefinition", () => {
  it("defaults tools and keywords to empty", () => {
    const parsed = AgentDefinition.parse({
      name: "a",
      description: "does a",
      capability: "compute",
    });

    expect(parsed.tools).toEqual([]);
    expect(parsed.keywords).toEqual([]);
  });

  it("rejects an unknown capability", () => {
    const result = AgentDefinition.safeParse({
      name: "a",
      description: "does a",
      capability: "teleport",
    });

    expect(result.success).toBe(false);
  });
});

describe("AgentRegistry", () => {
  it("registers the three default specialists", () => {
    expect(defaultRegistry().names).toEqual(["research", "compute", "publish"]);
  });

  it("rejects an empty registry", () => {
    expect(() => new AgentRegistry([])).toThrow(/at least one agent/);
  });

  it("rejects duplicate names", () => {
    expect(() => new AgentRegistry([RESEARCH_AGENT, RESEARCH_AGENT])).toThrow(/Duplicate/);
  });

  it("throws a listing error for an unknown agent", () => {
    try {
      defaultRegistry().get("nope");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(UnknownAgentError);
      expect((error as Error).message).toContain("research");
    }
  });

  it("reports whether an agent exists", () => {
    const registry = defaultRegistry();

    expect(registry.has("publish")).toBe(true);
    expect(registry.has("Publish")).toBe(false);
  });

  it("finds the owner of a tool", () => {
    const registry = defaultRegistry();

    expect(registry.ownerOf("createPost")?.name).toBe("publish");
    expect(registry.ownerOf("addTwoNumbers")?.name).toBe("compute");
    expect(registry.ownerOf("nonexistent")).toBeUndefined();
  });

  it("gives every tool exactly one owner", () => {
    const registry = defaultRegistry();

    for (const tool of TOOLS) {
      const owners = registry.agents.filter((a) => a.tools.includes(tool.name));
      // Two agents owning the same tool would make the boundary meaningless.
      expect(owners, tool.name).toHaveLength(1);
    }
  });

  it("keeps publish tools away from every other agent", () => {
    const registry = defaultRegistry();
    const publishTools = new Set(PUBLISH_AGENT.tools);

    for (const agent of registry.agents) {
      if (agent.name === "publish") continue;
      for (const tool of agent.tools) {
        // Side effects visible to the outside world live in exactly one place.
        expect(publishTools.has(tool), `${agent.name} owns ${tool}`).toBe(false);
      }
    }
  });

  it("renders a description carrying names and tools for the prompt", () => {
    const described = defaultRegistry().describe();

    expect(described).toContain("research:");
    expect(described).toContain("createPost");
  });
});

describe("SpecialistAgent", () => {
  it("exposes only the tools it declares", () => {
    const compute = new SpecialistAgent(COMPUTE_AGENT);

    expect(compute.toolNames).toEqual(["addTwoNumbers"]);
    expect(compute.canUse("addTwoNumbers")).toBe(true);
    expect(compute.canUse("createPost")).toBe(false);
  });

  it("invokes a tool it owns", async () => {
    const compute = new SpecialistAgent(COMPUTE_AGENT);

    const result = await compute.invoke("addTwoNumbers", { a: 2, b: 3 });

    expect(result.content[0]?.text).toBe("The sum of 2 and 3 is 5");
  });

  it("refuses a tool it does not own", async () => {
    const compute = new SpecialistAgent(COMPUTE_AGENT);

    // The ownership rule is enforced, not merely documented: without this,
    // "specialists" would be a naming convention and a read-only context
    // could still reach a side-effecting tool.
    await expect(compute.invoke("createPost", { status: "hi" })).rejects.toThrow(
      ToolAccessError,
    );
  });

  it("validates arguments against the tool's schema", async () => {
    const compute = new SpecialistAgent(COMPUTE_AGENT);

    await expect(compute.invoke("addTwoNumbers", { a: "two", b: 3 })).rejects.toThrow(
      /Invalid arguments/,
    );
  });

  it("has no tools when it declares none", () => {
    const research = new SpecialistAgent(RESEARCH_AGENT);

    expect(research.toolNames).toEqual([]);
  });

  it("ignores a declared tool that does not exist", () => {
    const ghost = new SpecialistAgent(
      AgentDefinition.parse({
        name: "ghost",
        description: "declares a tool nobody implements",
        capability: "compute",
        tools: ["notARealTool"],
      }),
    );

    expect(ghost.toolNames).toEqual([]);
    expect(ghost.canUse("notARealTool")).toBe(false);
  });
});

describe("buildSpecialists", () => {
  it("builds one specialist per registered agent", () => {
    const specialists = buildSpecialists();

    expect([...specialists.keys()]).toEqual(DEFAULT_AGENTS.map((a) => a.name));
    expect(specialists.get("publish")?.canUse("createPost")).toBe(true);
  });
});
