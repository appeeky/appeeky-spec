import type { AppStoreListing, GooglePlayListing, Project, SpecFileInput } from "./schema.js";
import { parseSpec } from "./files.js";
import type { OpsTransport } from "./transport.js";

export function makeProject(
  spec: Partial<SpecFileInput> = {},
  appStore: Record<string, AppStoreListing> = {},
  googlePlay: Record<string, GooglePlayListing> = {},
): Project {
  return {
    root: "/tmp/appeeky-spec-test",
    spec: parseSpec({
      version: 1,
      app: { name: "Sleep Sounds" },
      stores: { appStore: { appId: "123" }, googlePlay: { packageName: "com.example.sleep" } },
      ...spec,
    }),
    listings: { "app-store": appStore, "google-play": googlePlay },
  };
}

export interface RecordedCall {
  op: string;
  args: Record<string, unknown>;
  write: boolean;
}

/** In-memory transport: answers ops from a table and records every call. */
export function fakeTransport(answers: Record<string, unknown | ((args: Record<string, unknown>) => unknown)>): OpsTransport & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  return {
    kind: "local",
    label: "fake",
    calls,
    async call<T>(op: string, args: Record<string, unknown>, options: { write?: boolean } = {}): Promise<T> {
      calls.push({ op, args, write: Boolean(options.write) });
      const answer = answers[op];
      if (answer === undefined) throw new Error(`unexpected op ${op}`);
      return (typeof answer === "function" ? (answer as (a: Record<string, unknown>) => unknown)(args) : answer) as T;
    },
  };
}
