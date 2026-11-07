import type { Listing, StoreId, StoreListings } from "../schema.js";

/** One field that differs between the spec and the store. */
export interface FieldChange {
  store: StoreId;
  locale: string;
  field: string;
  /** Live value; undefined when the store has no value or no such locale. */
  before: string | undefined;
  after: string;
  /** The locale does not exist in the store yet. */
  newLocale: boolean;
  /** Why this change cannot be pushed right now, if it cannot. */
  blocked?: string;
}

/** What the store looks like now, plus whatever the adapter needs to write back. */
export interface RemoteState<L extends Listing = Listing> {
  store: StoreId;
  listings: StoreListings<L>;
  /** Human-readable context, e.g. which App Store version is being edited. */
  target: string;
  /** Adapter-private data (resource ids, editability). */
  context: unknown;
}

export interface PushResult {
  applied: FieldChange[];
  skipped: FieldChange[];
}

export interface StoreAdapter<L extends Listing = Listing> {
  readonly store: StoreId;
  pull(): Promise<RemoteState<L>>;
  /** Mark changes that cannot be written in the current store state. */
  annotate(changes: FieldChange[], state: RemoteState<L>, local: StoreListings<L>): FieldChange[];
  push(changes: FieldChange[], state: RemoteState<L>, local: StoreListings<L>): Promise<PushResult>;
}
