import type { GooglePlayListing, StoreListings } from "../schema.js";
import type { OpsTransport } from "../transport.js";
import type { FieldChange, PushResult, RemoteState, StoreAdapter } from "./types.js";

interface PlayListing {
  language?: string;
  title?: string | null;
  shortDescription?: string | null;
  fullDescription?: string | null;
  video?: string | null;
}

const REQUIRED_FOR_NEW = ["title", "shortDescription", "fullDescription"] as const;

function toListing(l: PlayListing): GooglePlayListing {
  const out: GooglePlayListing = {};
  if (l.title) out.title = l.title;
  if (l.shortDescription) out.shortDescription = l.shortDescription;
  if (l.fullDescription) out.fullDescription = l.fullDescription;
  if (l.video) out.video = l.video;
  return out;
}

function rows(result: unknown): PlayListing[] {
  if (Array.isArray(result)) return result as PlayListing[];
  const wrapped = result as { listings?: PlayListing[]; data?: PlayListing[] } | undefined;
  return wrapped?.listings ?? wrapped?.data ?? [];
}

export class GooglePlayAdapter implements StoreAdapter<GooglePlayListing> {
  readonly store = "google-play" as const;

  constructor(
    private readonly transport: OpsTransport,
    private readonly packageName: string,
  ) {}

  async pull(): Promise<RemoteState<GooglePlayListing>> {
    const listings: StoreListings<GooglePlayListing> = {};
    for (const l of rows(await this.transport.call("gps_list_listings", { packageName: this.packageName }))) {
      if (l.language) listings[l.language] = toListing(l);
    }
    return { store: this.store, listings, target: `${this.packageName} (live listing)`, context: null };
  }

  annotate(changes: FieldChange[], _state: RemoteState<GooglePlayListing>, local: StoreListings<GooglePlayListing>): FieldChange[] {
    return changes.map((c) => {
      if (!c.newLocale) return c;
      const missing = REQUIRED_FOR_NEW.filter((f) => !local[c.locale]?.[f]);
      return missing.length > 0 ? { ...c, blocked: `A new Google Play language needs ${missing.join(", ")} in the spec.` } : c;
    });
  }

  /** Google Play commits each language in its own edit; changes go live without an app update. */
  async push(changes: FieldChange[], state: RemoteState<GooglePlayListing>, local: StoreListings<GooglePlayListing>): Promise<PushResult> {
    const annotated = this.annotate(changes, state, local);
    const ready = annotated.filter((c) => !c.blocked);
    const skipped = annotated.filter((c) => c.blocked);
    const applied: FieldChange[] = [];
    for (const language of [...new Set(ready.map((c) => c.locale))]) {
      const mine = ready.filter((c) => c.locale === language);
      const fields = mine[0]!.newLocale
        ? { ...local[language] }
        : Object.fromEntries(mine.map((c) => [c.field, c.after]));
      await this.transport.call("gps_update_listing", { packageName: this.packageName, language, ...fields }, { write: true });
      applied.push(...mine);
    }
    return { applied, skipped };
  }
}
