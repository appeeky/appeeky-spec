import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CODING_AGENTS, onPath, setupPrompt } from "./coding-agents.js";

describe("coding agents", () => {
  it("finds a command on the PATH", () => {
    const dir = mkdtempSync(join(tmpdir(), "spec-path-"));
    writeFileSync(join(dir, "codex"), "");
    expect(onPath("codex", { PATH: dir })).toBe(true);
    expect(onPath("claude", { PATH: dir })).toBe(false);
  });

  it("asks the agent for what the setup could not do", () => {
    const fresh = setupPrompt({ name: "Appeeky", pulled: false, hasTargets: true });
    expect(fresh).toContain("Appeeky");
    expect(fresh).toContain("npx @appeeky/spec pull");
    expect(fresh).toContain("Do not push");
    expect(setupPrompt({ name: "Appeeky", pulled: true, hasTargets: false })).not.toContain("spec pull");
  });

  it("starts each agent with the prompt as its first message", () => {
    const args = Object.fromEntries(CODING_AGENTS.map((a) => [a.id, a.launch("hi")]));
    expect(args.claude).toEqual(["hi"]);
    expect(args.gemini).toEqual(["-i", "hi"]);
    expect(args.opencode).toEqual(["--prompt", "hi"]);
  });
});
