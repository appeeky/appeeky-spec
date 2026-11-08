import { spawn } from "node:child_process";
import { delimiter, join } from "node:path";
import { existsSync } from "node:fs";
import type { StoreId, TransportMode } from "./schema.js";

/**
 * Both store CLIs expose the same named operations locally (`appstore ops call`,
 * `gps call`) and on Appeeky's hosted gateways (`POST /v1/ops/<name>`), so a
 * store adapter only needs `call(op, args)`.
 */
export interface OpsTransport {
  readonly kind: "local" | "hosted";
  readonly label: string;
  call<T = unknown>(op: string, args: Record<string, unknown>, options?: { write?: boolean }): Promise<T>;
}

export class TransportError extends Error {
  constructor(
    message: string,
    readonly op?: string,
  ) {
    super(message);
    this.name = "TransportError";
  }
}

interface StoreCli {
  bin: string;
  npmPackage: string;
  /** argv before the op name, e.g. `ops call` vs `call`. */
  callArgs: string[];
  /** Flag that picks a named account or profile. */
  accountFlag: string;
  hostedUrl: string;
  writeHeader: string;
  setupHint: string;
}

export const STORE_CLIS: Record<StoreId, StoreCli> = {
  "app-store": {
    bin: "appstore",
    npmPackage: "@appeeky/app-store-connect-cli",
    callArgs: ["ops", "call"],
    accountFlag: "--account",
    hostedUrl: "https://asc-api.appeeky.com",
    writeHeader: "X-ASC-Allow-Writes",
    setupHint:
      "Save your App Store Connect API key once with the App Store Connect CLI: `npx -p @appeeky/app-store-connect-cli appstore accounts add my-team --key-id … --issuer-id … --private-key-path AuthKey.p8 --default` (github.com/appeeky/app-store-connect-cli). Or set APPEEKY_API_KEY to use your connection in Appeeky.",
  },
  "google-play": {
    bin: "gps",
    npmPackage: "@appeeky/google-play-store-cli",
    callArgs: ["call"],
    accountFlag: "--account",
    hostedUrl: "https://gps-api.appeeky.com",
    writeHeader: "X-GPS-Allow-Writes",
    setupHint:
      "Save your Google Play service account once with the Google Play CLI: `npx -p @appeeky/google-play-store-cli gps accounts add my-co --credentials service-account.json --default` (github.com/appeeky/google-play-console-cli). Or set APPEEKY_API_KEY to use your connection in Appeeky.",
  },
};

export function onPath(bin: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const exts = process.platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD").split(";") : [""];
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) if (existsSync(join(dir, bin + ext))) return true;
  }
  return false;
}

export type Runner = (
  command: string,
  args: string[],
  env?: Record<string, string>,
) => Promise<{ code: number; stdout: string; stderr: string }>;

export const defaultRunner: Runner = (command, args, env) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
      env: env ? { ...process.env, ...env } : process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });

export interface LocalCliOptions {
  /** Named account (`appstore --account`) or profile (`gps --profile`). */
  account?: string;
  /** Run the CLI through `npx` when it is not installed. */
  useNpx?: boolean;
  /**
   * Run a specific executable instead of the CLI on PATH, e.g. an app that
   * bundles the store CLI: `{ file: process.execPath, args: ["/path/to/bin.js"] }`.
   */
  command?: { file: string; args: string[] };
  /**
   * Extra environment for the CLI, e.g. credentials:
   * `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_PRIVATE_KEY` or `GPS_CREDENTIALS` (inline JSON).
   */
  env?: Record<string, string>;
  label?: string;
  runner?: Runner;
}

/** Runs operations through the store CLI on this machine, with the user's own key. */
export class LocalCliTransport implements OpsTransport {
  readonly kind = "local" as const;
  readonly label: string;

  constructor(
    private readonly store: StoreId,
    private readonly options: LocalCliOptions = {},
  ) {
    const cli = STORE_CLIS[store];
    this.label = options.label ?? (options.useNpx ? `npx ${cli.npmPackage}` : `local ${cli.bin} CLI`);
  }

  async call<T>(op: string, args: Record<string, unknown>, options: { write?: boolean } = {}): Promise<T> {
    const cli = STORE_CLIS[this.store];
    const argv = ["--json"];
    if (this.options.account) argv.push(cli.accountFlag, this.options.account);
    if (options.write) argv.push("--confirm");
    argv.push(...cli.callArgs, op, JSON.stringify(args));
    const [command, full] = this.options.command
      ? [this.options.command.file, [...this.options.command.args, ...argv]]
      : this.options.useNpx
        ? ["npx", ["-y", "-p", cli.npmPackage, cli.bin, ...argv]]
        : [cli.bin, argv];
    const run = this.options.runner ?? defaultRunner;
    let result;
    try {
      result = await run(command, full, this.options.env);
    } catch (err) {
      throw new TransportError(`Could not start ${command}: ${(err as Error).message}. ${cli.setupHint}`, op);
    }
    if (result.code !== 0) {
      const detail = (result.stderr || result.stdout).trim().split("\n").slice(-3).join(" ");
      throw new TransportError(`${cli.bin} ${op} failed: ${detail || `exit ${result.code}`}`, op);
    }
    const text = result.stdout.trim();
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new TransportError(`${cli.bin} ${op} returned output that is not JSON: ${text.slice(0, 200)}`, op);
    }
  }
}

export type Fetcher = typeof fetch;

/** Runs operations on Appeeky's hosted gateway with an Appeeky API key; the store key never leaves Appeeky. */
export class HostedTransport implements OpsTransport {
  readonly kind = "hosted" as const;
  readonly label: string;

  constructor(
    private readonly store: StoreId,
    private readonly apiKey: string,
    private readonly options: { baseUrl?: string; fetcher?: Fetcher } = {},
  ) {
    this.label = `hosted ${new URL(options.baseUrl ?? STORE_CLIS[store].hostedUrl).host}`;
  }

  async call<T>(op: string, args: Record<string, unknown>, options: { write?: boolean } = {}): Promise<T> {
    const cli = STORE_CLIS[this.store];
    const base = (this.options.baseUrl ?? cli.hostedUrl).replace(/\/$/, "");
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
      "User-Agent": "appeeky-spec",
    };
    if (options.write) headers[cli.writeHeader] = "true";
    const doFetch = this.options.fetcher ?? fetch;
    let res: Response;
    try {
      res = await doFetch(`${base}/v1/ops/${op}`, { method: "POST", headers, body: JSON.stringify(args) });
    } catch (err) {
      throw new TransportError(`Could not reach ${base}: ${(err as Error).message}`, op);
    }
    const body = (await res.json().catch(() => null)) as { data?: T; error?: { code?: string; message?: string } } | null;
    if (!res.ok) {
      const message = body?.error?.message ?? `HTTP ${res.status}`;
      throw new TransportError(`${op} failed on ${new URL(base).host}: ${message}`, op);
    }
    return body?.data as T;
  }
}

export interface TransportOptions {
  via: TransportMode;
  account?: string;
  apiKey?: string;
  env?: NodeJS.ProcessEnv;
  runner?: Runner;
  fetcher?: Fetcher;
}

/**
 * `auto` prefers the local CLI when it is installed (your key, nothing leaves
 * your machine), then the hosted gateway when an Appeeky API key is set, and
 * finally the CLI through npx.
 */
export function createTransport(store: StoreId, options: TransportOptions): OpsTransport {
  const env = options.env ?? process.env;
  const apiKey = options.apiKey ?? env.APPEEKY_API_KEY;
  const cli = STORE_CLIS[store];
  const local = (useNpx: boolean) => new LocalCliTransport(store, { account: options.account, useNpx, runner: options.runner });
  const hostedBase = store === "app-store" ? env.APPEEKY_ASC_URL : env.APPEEKY_GPS_URL;
  const hosted = (key: string) => new HostedTransport(store, key, { baseUrl: hostedBase, fetcher: options.fetcher });

  switch (options.via) {
    case "local":
      return local(!onPath(cli.bin, env));
    case "hosted":
      if (!apiKey) throw new TransportError(`Set APPEEKY_API_KEY to use the hosted ${store} gateway.`);
      return hosted(apiKey);
    case "auto":
      if (onPath(cli.bin, env)) return local(false);
      if (apiKey) return hosted(apiKey);
      return local(true);
  }
}
