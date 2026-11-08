import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";

/**
 * The specialist subagents and the co-founder review, shipped in the package's `agents/` folder
 * and copied into a repo in the format each coding agent reads.
 *
 * - `appeeky-*.md`: read-only specialists (ASO, reviews, ads, releases, UGC, social), written in Claude Code's
 *   subagent format.
 * - `cofounder.md`: the review that starts them, writes the brief and proposes one change. It is a
 *   command, so it runs in the main session, where subagents can be started.
 */

export type AgentTarget = "claude" | "opencode";
export const AGENT_TARGETS: AgentTarget[] = ["claude", "opencode"];

export const COFOUNDER_COMMAND = "appeeky-cofounder";

/** The folder each target reads subagents and commands from. */
export const TARGET_DIRS: Record<AgentTarget, { agents: string; commands: string }> = {
  claude: { agents: ".claude/agents", commands: ".claude/commands" },
  opencode: { agents: ".opencode/agent", commands: ".opencode/command" },
};

export interface AgentFile {
  /** File name without extension, e.g. `appeeky-aso` or `cofounder`. */
  name: string;
  kind: "specialist" | "command";
  meta: Record<string, unknown>;
  body: string;
}

export interface InstalledFile {
  path: string;
  status: "written" | "unchanged" | "kept";
}

/** The `agents/` folder of the installed package (one level above `dist/` or `src/`). */
export function packagedAgentsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "agents");
}

function splitFrontmatter(text: string): { meta: Record<string, unknown>; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!match) return { meta: {}, body: text };
  return { meta: (parse(match[1]!) as Record<string, unknown>) ?? {}, body: text.slice(match[0].length) };
}

export function readAgentFiles(dir = packagedAgentsDir()): AgentFile[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => {
      const name = f.slice(0, -3);
      const { meta, body } = splitFrontmatter(readFileSync(join(dir, f), "utf8"));
      return { name, kind: name === "cofounder" ? "command" : "specialist", meta, body };
    });
}

function withFrontmatter(meta: Record<string, unknown>, body: string): string {
  return `---\n${stringify(meta, { lineWidth: 0 }).trimEnd()}\n---\n${body.startsWith("\n") ? body : `\n${body}`}`;
}

/** The path and content of one file for one target. */
export function renderAgentFile(file: AgentFile, target: AgentTarget): { path: string; content: string } {
  const dirs = TARGET_DIRS[target];
  if (file.kind === "command") {
    return { path: `${dirs.commands}/${COFOUNDER_COMMAND}.md`, content: withFrontmatter({ description: file.meta.description }, file.body) };
  }
  if (target === "claude") return { path: `${dirs.agents}/${file.name}.md`, content: withFrontmatter(file.meta, file.body) };
  // opencode: the file name is the agent's name, `mode: subagent`, and tools are switched off by name.
  return {
    path: `${dirs.agents}/${file.name}.md`,
    content: withFrontmatter({ description: file.meta.description, mode: "subagent", tools: { write: false, edit: false } }, file.body),
  };
}

/**
 * Write the specialists and the co-founder command into `root` for each target. A file that exists
 * with other content is kept (it may hold the user's own edits) unless `force` is set.
 */
export async function installAgents(root: string, targets: AgentTarget[], opts: { force?: boolean; dir?: string } = {}): Promise<InstalledFile[]> {
  const files = readAgentFiles(opts.dir);
  const out: InstalledFile[] = [];
  for (const target of targets) {
    for (const file of files) {
      const { path, content } = renderAgentFile(file, target);
      const full = join(root, path);
      const current = existsSync(full) ? await readFile(full, "utf8") : null;
      if (current === content) {
        out.push({ path, status: "unchanged" });
        continue;
      }
      if (current !== null && !opts.force) {
        out.push({ path, status: "kept" });
        continue;
      }
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, content);
      out.push({ path, status: "written" });
    }
  }
  return out;
}

/** Targets that already have the specialists in `root`. */
export function installedTargets(root: string): AgentTarget[] {
  return AGENT_TARGETS.filter((t) => existsSync(join(root, TARGET_DIRS[t].agents, "appeeky-aso.md")));
}

export function parseTargets(value: string): AgentTarget[] {
  const list = value === "all" ? AGENT_TARGETS : value.split(",").map((x) => x.trim());
  const bad = list.filter((x) => !AGENT_TARGETS.includes(x as AgentTarget));
  if (bad.length) throw new Error(`Unknown target: ${bad.join(", ")}. Use ${AGENT_TARGETS.join(", ")} or all.`);
  return list as AgentTarget[];
}
