import { diffListings } from "./diff.js";
import type { Listing, Project, StoreId, StoreListings } from "./schema.js";
import { AppStoreAdapter } from "./stores/app-store.js";
import { GooglePlayAdapter } from "./stores/google-play.js";
import type { FieldChange, RemoteState, StoreAdapter } from "./stores/types.js";
import { createTransport, type OpsTransport, type TransportOptions } from "./transport.js";

export interface StoreHandle {
  store: StoreId;
  adapter: StoreAdapter;
  transport: OpsTransport;
}

/** Stores configured in the spec, optionally narrowed to one. */
export function configuredStores(project: Project, only?: StoreId): StoreId[] {
  const stores: StoreId[] = [];
  if (project.spec.stores.appStore) stores.push("app-store");
  if (project.spec.stores.googlePlay) stores.push("google-play");
  return only ? stores.filter((s) => s === only) : stores;
}

export function storeHandle(
  project: Project,
  store: StoreId,
  overrides: Partial<TransportOptions> = {},
  transportOverride?: OpsTransport,
): StoreHandle {
  if (store === "app-store") {
    const cfg = project.spec.stores.appStore;
    if (!cfg) throw new Error("The spec has no stores.appStore section.");
    const transport = transportOverride ?? createTransport(store, { via: cfg.via, account: cfg.account, ...overrides });
    return { store, transport, adapter: new AppStoreAdapter(transport, cfg.appId, cfg.platform) };
  }
  const cfg = project.spec.stores.googlePlay;
  if (!cfg) throw new Error("The spec has no stores.googlePlay section.");
  const transport = transportOverride ?? createTransport(store, { via: cfg.via, account: cfg.account ?? cfg.profile, ...overrides });
  return { store, transport, adapter: new GooglePlayAdapter(transport, cfg.packageName) };
}

export interface StorePlan {
  store: StoreId;
  via: string;
  state: RemoteState;
  changes: FieldChange[];
}

/** Pull the store, diff it with the spec and mark what cannot be pushed yet. */
export async function planStore(project: Project, handle: StoreHandle): Promise<StorePlan> {
  const state = await handle.adapter.pull();
  const local = project.listings[handle.store] as StoreListings<Listing>;
  const changes = handle.adapter.annotate(diffListings(handle.store, local, state.listings), state, local);
  return { store: handle.store, via: handle.transport.label, state, changes };
}
