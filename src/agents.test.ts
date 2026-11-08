import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { installAgents, installedTargets, parseTargets, readAgentFiles, renderAgentFile } from "./agents.js";

const tmp = () => mkdtempSync(join(tmpdir(), "spec-agents-"));
const frontmatter = (text: string) => parse(/^---\n([\s\S]*?)\n---/.exec(text)![1]!) as Record<string, unknown>;

describe("packaged agents", () => {
  const files = readAgentFiles();

  it("ships six read-only specialists and the co-founder review", () => {
    expect(files.filter((f) => f.kind === "specialist").map((f) => f.name)).toEqual(["appeeky-ads", "appeeky-aso", "appeeky-releases", "appeeky-reviews", "appeeky-social", "appeeky-ugc"]);
    expect(files.filter((f) => f.kind === "command").map((f) => f.name)).toEqual(["cofounder"]);
    for (const f of files.filter((x) => x.kind === "specialist")) {
      expect(f.meta.name).toBe(f.name);
      expect(String(f.meta.description).length).toBeGreaterThan(40);
      expect(f.meta.tools).not.toMatch(/Edit|Write/);
      expect(f.body).toMatch(/## Never/);
    }
  });

  it("the co-founder review names every specialist", () => {
    const cofounder = files.find((f) => f.kind === "command")!;
    for (const f of files.filter((x) => x.kind === "specialist")) expect(cofounder.body).toContain(`\`${f.name}\``);
  });

  it("is the same text as the weekly example prompt", () => {
    const example = readFileSync(join(__dirname, "..", "examples", "weekly", "propose.md"), "utf8");
    expect(example).toBe(readFileSync(join(__dirname, "..", "agents", "cofounder.md"), "utf8"));
  });

  it("renders opencode subagents with edits switched off", () => {
    const aso = files.find((f) => f.name === "appeeky-aso")!;
    const { path, content } = renderAgentFile(aso, "opencode");
    expect(path).toBe(".opencode/agent/appeeky-aso.md");
    expect(frontmatter(content)).toEqual({ description: aso.meta.description, mode: "subagent", tools: { write: false, edit: false } });
    expect(content).toContain("## Answer in this shape");
  });
});

describe("installing", () => {
  it("writes the specialists and the command, and is idempotent", async () => {
    const root = tmp();
    const first = await installAgents(root, ["claude"]);
    expect(first.map((f) => f.path)).toContain(".claude/agents/appeeky-aso.md");
    expect(first.map((f) => f.path)).toContain(".claude/commands/appeeky-cofounder.md");
    expect(first.every((f) => f.status === "written")).toBe(true);
    expect(frontmatter(readFileSync(join(root, ".claude/agents/appeeky-aso.md"), "utf8")).name).toBe("appeeky-aso");
    expect(installedTargets(root)).toEqual(["claude"]);

    const again = await installAgents(root, ["claude"]);
    expect(again.every((f) => f.status === "unchanged")).toBe(true);
  });

  it("keeps a file the user changed unless forced", async () => {
    const root = tmp();
    await installAgents(root, ["claude"]);
    const path = join(root, ".claude/agents/appeeky-ads.md");
    writeFileSync(path, "my own ads agent\n");
    const kept = await installAgents(root, ["claude"]);
    expect(kept.find((f) => f.path.endsWith("appeeky-ads.md"))!.status).toBe("kept");
    expect(readFileSync(path, "utf8")).toBe("my own ads agent\n");
    await installAgents(root, ["claude"], { force: true });
    expect(readFileSync(path, "utf8")).not.toBe("my own ads agent\n");
  });

  it("parses targets", () => {
    expect(parseTargets("all")).toEqual(["claude", "opencode"]);
    expect(parseTargets("opencode")).toEqual(["opencode"]);
    expect(() => parseTargets("cursor")).toThrow(/Unknown target/);
  });
});
