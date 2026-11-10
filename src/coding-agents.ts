import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { AgentTarget } from "./agents.js";

/** A coding agent the setup can hand over to: its command, its id for `npx skills add`, how it takes a first prompt. */
export interface CodingAgent {
  id: string;
  label: string;
  bin: string;
  /** The agent's id in the skills CLI (`npx skills add … -a <id>`). */
  skills: string;
  /** Where the specialist subagents and /appeeky-cofounder go, for the agents that read them. */
  subagents?: AgentTarget;
  /** Arguments that start an interactive session with `prompt` as the first message. */
  launch: (prompt: string) => string[];
}

export const CODING_AGENTS: CodingAgent[] = [
  { id: "claude", label: "Claude Code", bin: "claude", skills: "claude-code", subagents: "claude", launch: (p) => [p] },
  { id: "codex", label: "Codex", bin: "codex", skills: "codex", launch: (p) => [p] },
  { id: "gemini", label: "Gemini CLI", bin: "gemini", skills: "gemini-cli", launch: (p) => ["-i", p] },
  { id: "opencode", label: "OpenCode", bin: "opencode", skills: "opencode", subagents: "opencode", launch: (p) => ["--prompt", p] },
  { id: "cursor", label: "Cursor", bin: "cursor-agent", skills: "cursor", launch: (p) => [p] },
];

/** Whether `bin` is on the PATH. */
export function onPath(bin: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const exts = process.platform === "win32" ? ["", ".cmd", ".exe"] : [""];
  return (env.PATH ?? "").split(delimiter).some((dir) => dir && exts.some((ext) => existsSync(join(dir, bin + ext))));
}

/** The first message for the agent: finish what the setup could not do here, then propose one change. */
export function setupPrompt(app: { name: string; pulled: boolean; hasTargets: boolean }): string {
  const steps = [
    "run `npx @appeeky/spec doctor` and walk me through anything missing, store access first",
    app.pulled ? undefined : "pull the live listing with `npx @appeeky/spec pull`",
    app.hasTargets ? "check the targets with `npx @appeeky/spec coverage`" : "suggest 3 to 5 target searches and add them to appeeky.spec.yaml",
    "propose the first listing change and show me the diff",
  ].filter(Boolean);
  return `Finish setting up Appeeky Spec for ${app.name} in this folder with the appeeky-spec skill: ${steps.join(", then ")}. Do not push anything to the stores until I say so.`;
}

/** Run a command quietly; resolves with its exit code and output, so a spinner can run meanwhile. */
export function runQuiet(cmd: string, args: string[], cwd: string): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" });
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    child.on("error", (e) => resolve({ code: 1, output: e.message }));
    child.on("close", (code) => resolve({ code: code ?? 1, output }));
  });
}
