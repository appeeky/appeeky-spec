import { LIVE_EDITABLE } from "../limits.js";
import type { AppStoreListing, StoreListings } from "../schema.js";
import type { OpsTransport } from "../transport.js";
import type { FieldChange, PushResult, RemoteState, StoreAdapter } from "./types.js";

interface Resource<A = Record<string, unknown>> {
  id: string;
  type?: string;
  attributes?: A;
}

interface Doc<A> {
  data?: Resource<A>[] | Resource<A>;
}

type VersionAttrs = { versionString?: string; appStoreState?: string; appVersionState?: string; createdDate?: string; platform?: string };
type AppInfoAttrs = { appStoreState?: string; state?: string };
type LocAttrs = { locale?: string } & Record<string, string | null | undefined>;

/** Version and app info states in which App Store Connect accepts metadata edits. */
const EDITABLE_STATES = new Set([
  "PREPARE_FOR_SUBMISSION",
  "DEVELOPER_REJECTED",
  "REJECTED",
  "METADATA_REJECTED",
  "INVALID_BINARY",
]);
const LIVE_STATES = new Set(["READY_FOR_SALE", "READY_FOR_DISTRIBUTION", "ACCEPTED", "PROCESSING_FOR_DISTRIBUTION"]);

const APP_INFO_FIELDS = new Set(["name", "subtitle"]);
const VERSION_FIELDS = ["keywords", "promotionalText", "description", "whatsNew", "marketingUrl", "supportUrl"] as const;

export interface AppStoreContext {
  version?: { id: string; versionString?: string; state: string; editable: boolean };
  appInfo?: { id: string; state: string; editable: boolean };
  versionLocIds: Record<string, string>;
  appInfoLocIds: Record<string, string>;
}

function list<A>(doc: Doc<A> | Resource<A>[] | undefined): Resource<A>[] {
  if (!doc) return [];
  if (Array.isArray(doc)) return doc;
  if (Array.isArray(doc.data)) return doc.data;
  return doc.data ? [doc.data] : [];
}

function versionState(v: Resource<VersionAttrs>): string {
  return v.attributes?.appVersionState ?? v.attributes?.appStoreState ?? "UNKNOWN";
}

function appInfoState(i: Resource<AppInfoAttrs>): string {
  return i.attributes?.state ?? i.attributes?.appStoreState ?? "UNKNOWN";
}

function newestFirst<A extends { createdDate?: string }>(items: Resource<A>[]): Resource<A>[] {
  return [...items].sort((a, b) => (b.attributes?.createdDate ?? "").localeCompare(a.attributes?.createdDate ?? ""));
}

function clean(attrs: LocAttrs | undefined, keys: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of keys) {
    const v = attrs?.[k];
    if (typeof v === "string" && v !== "") out[k] = v;
  }
  return out;
}

export class AppStoreAdapter implements StoreAdapter<AppStoreListing> {
  readonly store = "app-store" as const;

  constructor(
    private readonly transport: OpsTransport,
    private readonly appId: string,
    private readonly platform: string = "IOS",
  ) {}

  async pull(): Promise<RemoteState<AppStoreListing>> {
    const versions = newestFirst(
      list(await this.transport.call<Doc<VersionAttrs>>("appstore_list_versions", { appId: this.appId, platform: this.platform })),
    );
    const version = versions.find((v) => EDITABLE_STATES.has(versionState(v))) ?? versions.find((v) => LIVE_STATES.has(versionState(v)));

    const infos = list(await this.transport.call<Doc<AppInfoAttrs>>("appstore_list_app_infos", { appId: this.appId }));
    const appInfo = infos.find((i) => EDITABLE_STATES.has(appInfoState(i))) ?? infos.find((i) => LIVE_STATES.has(appInfoState(i))) ?? infos[0];

    const listings: StoreListings<AppStoreListing> = {};
    const context: AppStoreContext = { versionLocIds: {}, appInfoLocIds: {} };

    if (version) {
      const state = versionState(version);
      context.version = { id: version.id, versionString: version.attributes?.versionString, state, editable: EDITABLE_STATES.has(state) };
      const locs = list(await this.transport.call<Doc<LocAttrs>>("appstore_list_version_localizations", { versionId: version.id, limit: 200 }));
      for (const loc of locs) {
        const locale = loc.attributes?.locale;
        if (!locale) continue;
        context.versionLocIds[locale] = loc.id;
        listings[locale] = { ...listings[locale], ...clean(loc.attributes, VERSION_FIELDS) };
      }
    }
    if (appInfo) {
      const state = appInfoState(appInfo);
      context.appInfo = { id: appInfo.id, state, editable: EDITABLE_STATES.has(state) };
      const locs = list(await this.transport.call<Doc<LocAttrs>>("appstore_list_app_info_localizations", { appInfoId: appInfo.id, limit: 200 }));
      for (const loc of locs) {
        const locale = loc.attributes?.locale;
        if (!locale) continue;
        context.appInfoLocIds[locale] = loc.id;
        listings[locale] = { ...clean(loc.attributes, ["name", "subtitle"]), ...listings[locale] };
      }
    }

    const target = context.version
      ? `version ${context.version.versionString ?? context.version.id} (${context.version.state.toLowerCase().replace(/_/g, " ")})`
      : "no App Store version found";
    return { store: this.store, listings, target, context };
  }

  /** Create the next App Store version so name, subtitle and keywords can change. */
  async createVersion(versionString: string): Promise<{ id: string; versionString: string }> {
    const created = await this.transport.call<Doc<VersionAttrs>>(
      "appstore_create_version",
      { appId: this.appId, platform: this.platform, versionString },
      { write: true },
    );
    const id = list(created)[0]?.id;
    if (!id) throw new Error(`App Store Connect did not return the new version ${versionString}.`);
    return { id, versionString };
  }

  annotate(changes: FieldChange[], state: RemoteState<AppStoreListing>, local: StoreListings<AppStoreListing>): FieldChange[] {
    const ctx = state.context as AppStoreContext;
    return changes.map((c) => {
      if (APP_INFO_FIELDS.has(c.field)) {
        if (!ctx.appInfo) return { ...c, blocked: "This app has no app info in App Store Connect." };
        if (!ctx.appInfo.editable) {
          return { ...c, blocked: "Name and subtitle change only with a new version. Create the next version in App Store Connect, then push again." };
        }
        if (!ctx.appInfoLocIds[c.locale] && !local[c.locale]?.name) {
          return { ...c, blocked: `Adding ${c.locale} needs a name in the spec.` };
        }
        return c;
      }
      if (!ctx.version) return { ...c, blocked: "This app has no App Store version yet." };
      if (!ctx.version.editable && !LIVE_EDITABLE["app-store"].has(c.field)) {
        return {
          ...c,
          blocked: `${c.field} changes only with a new version (the current one is ${ctx.version.state.toLowerCase().replace(/_/g, " ")}). Create the next version, then push again.`,
        };
      }
      return c;
    });
  }

  async push(changes: FieldChange[], state: RemoteState<AppStoreListing>, local: StoreListings<AppStoreListing>): Promise<PushResult> {
    const ctx = state.context as AppStoreContext;
    const annotated = this.annotate(changes, state, local);
    const ready = annotated.filter((c) => !c.blocked);
    const skipped = annotated.filter((c) => c.blocked);
    const applied: FieldChange[] = [];

    for (const locale of [...new Set(ready.map((c) => c.locale))]) {
      const mine = ready.filter((c) => c.locale === locale);
      const infoFields = Object.fromEntries(mine.filter((c) => APP_INFO_FIELDS.has(c.field)).map((c) => [c.field, c.after]));
      const versionFields = Object.fromEntries(mine.filter((c) => !APP_INFO_FIELDS.has(c.field)).map((c) => [c.field, c.after]));

      if (Object.keys(infoFields).length > 0 && ctx.appInfo) {
        const locId = ctx.appInfoLocIds[locale];
        if (locId) {
          await this.transport.call("appstore_update_app_info_localization", { localizationId: locId, ...infoFields }, { write: true });
        } else {
          const created = await this.transport.call<Doc<LocAttrs>>(
            "appstore_create_app_info_localization",
            { appInfoId: ctx.appInfo.id, locale, name: local[locale]?.name, ...infoFields },
            { write: true },
          );
          const id = list(created)[0]?.id;
          if (id) ctx.appInfoLocIds[locale] = id;
        }
        applied.push(...mine.filter((c) => APP_INFO_FIELDS.has(c.field)));
      }

      if (Object.keys(versionFields).length > 0 && ctx.version) {
        const locId = ctx.versionLocIds[locale];
        if (locId) {
          await this.transport.call("appstore_update_version_localization", { localizationId: locId, ...versionFields }, { write: true });
        } else {
          const created = await this.transport.call<Doc<LocAttrs>>(
            "appstore_create_version_localization",
            { versionId: ctx.version.id, locale, ...versionFields },
            { write: true },
          );
          const id = list(created)[0]?.id;
          if (id) ctx.versionLocIds[locale] = id;
        }
        applied.push(...mine.filter((c) => !APP_INFO_FIELDS.has(c.field)));
      }
    }
    return { applied, skipped };
  }
}
