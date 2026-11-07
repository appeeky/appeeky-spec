import { z } from "zod";

/** Stores a spec can describe. The ids double as folder names under `appeeky/store/`. */
export const STORES = ["app-store", "google-play"] as const;
export type StoreId = (typeof STORES)[number];

/** How a store is reached: the local store CLI with your own key, or Appeeky's hosted gateway. */
export const transportMode = z.enum(["auto", "local", "hosted"]);
export type TransportMode = z.infer<typeof transportMode>;

const countryCode = z
  .string()
  .regex(/^[a-z]{2}$/i, "Use a two-letter storefront code such as us, gb or tr")
  .transform((s) => s.toLowerCase());

const appStoreConfig = z
  .object({
    /** Numeric App Store id (or a bundle id; the local CLI resolves it). */
    appId: z.string().min(1),
    platform: z.enum(["IOS", "MAC_OS", "TV_OS", "VISION_OS"]).default("IOS"),
    via: transportMode.default("auto"),
    /** Named account of the local `appstore` CLI. */
    account: z.string().optional(),
  })
  .strict();

const googlePlayConfig = z
  .object({
    packageName: z.string().regex(/^[A-Za-z][\w]*(\.[A-Za-z_][\w]*)+$/, "Use the package name, e.g. com.example.app"),
    via: transportMode.default("auto"),
    /** Named account of the local `gps` CLI (`gps accounts add`). */
    account: z.string().optional(),
    /** Old name for `account`. */
    profile: z.string().optional(),
  })
  .strict();

/** Meta ad campaigns that promote this app. Insights come through the Meta connection in Appeeky. */
const metaAdsConfig = z
  .object({
    /** Ad account (act_…); defaults to the one picked in Appeeky. */
    adAccount: z.string().optional(),
    campaigns: z.array(z.string().min(1)).min(1),
  })
  .strict();

/** TikTok ad campaigns that promote this app. Reports come through the TikTok connection in Appeeky. */
const tiktokAdsConfig = z
  .object({
    /** Advertiser id; defaults to the one picked in Appeeky. */
    advertiser: z.string().optional(),
    campaigns: z.array(z.string().min(1)).min(1),
  })
  .strict();

/** One thing people ask AI assistants for, and the prompts that ask it. */
const aiIntent = z
  .object({
    label: z.string().min(8, "An intent label needs at least 8 characters"),
    description: z.string().optional(),
    prompts: z.array(z.string().min(15, "A prompt needs at least 15 characters")).default([]),
  })
  .strict();

/** Store charts a category rank is read from. */
export const CHARTS = ["top-free", "top-paid", "top-grossing"] as const;
export type Chart = (typeof CHARTS)[number];

/** `appeeky.spec.yaml`: who the app is, where it ships, and what it should be found for. */
export const specFileSchema = z
  .object({
    version: z.literal(1),
    app: z
      .object({
        name: z.string().min(1),
        /** Locale the store falls back to when a storefront has no localization of its own. */
        primaryLocale: z.string().default("en-US"),
      })
      .strict(),
    stores: z
      .object({
        appStore: appStoreConfig.optional(),
        googlePlay: googlePlayConfig.optional(),
      })
      .strict()
      .default({}),
    /** Target keywords per storefront: the searches this app should be found for. */
    targets: z.record(countryCode, z.array(z.string().min(1)).default([])).default({}),
    /** Override which listing locales a storefront indexes (App Store). */
    storefronts: z.record(countryCode, z.array(z.string().min(2)).min(1)).default({}),
    /**
     * Paid channels outside the store. Apple Search Ads needs nothing here: it is
     * matched to the app in Appeeky. Meta and TikTok campaigns are listed by id.
     */
    ads: z
      .object({
        meta: metaAdsConfig.optional(),
        tiktok: tiktokAdsConfig.optional(),
      })
      .strict()
      .default({}),
    /** Apps you compete with. `competitors pull` writes each one to appeeky/competitors/. */
    competitors: z
      .array(
        z
          .object({
            name: z.string().optional(),
            appStore: z.string().regex(/^\d+$/, "Use the numeric App Store id").optional(),
            googlePlay: z.string().optional(),
          })
          .strict()
          .refine((c) => c.appStore || c.googlePlay, "Give an appStore id or a googlePlay package name"),
      )
      .default([]),
    /**
     * Install attribution from Appeeky Analytics: organic search, Search Ads keywords,
     * smart links, with the revenue each led to. `via: self` reads your own server on
     * Cloudflare (`url`, ATTRIBUTION_TOKEN); `via: hosted` reads Appeeky's (APPEEKY_API_KEY).
     */
    attribution: z
      .object({
        via: z.enum(["self", "hosted"]).default("hosted"),
        url: z.string().url().optional(),
        /**
         * The app's id in Appeeky Analytics. An app there is one platform, so an app on both
         * stores gives one per store: `{ app-store: …, google-play: … }`.
         */
        app: z.union([
          z.string().min(1),
          z
            .object({ "app-store": z.string().min(1).optional(), "google-play": z.string().min(1).optional() })
            .strict()
            .refine((m) => m["app-store"] || m["google-play"], "give the app id for app-store, google-play or both"),
        ]),
      })
      .strict()
      .refine((a) => a.via !== "self" || a.url, "via: self needs the url of your Appeeky Analytics server")
      .optional(),
    /**
     * Where `data pull` writes store analytics, ads and revenue. They are your private
     * business numbers, so by default they stay in .appeeky/data/ (gitignored).
     * `commit: true` writes them to appeeky/data/ so they are versioned with the spec.
     */
    data: z.object({ commit: z.boolean().default(false) }).strict().default({}),
    /**
     * Whether ChatGPT, Claude, Gemini and Perplexity name the app when people ask
     * for one like it. Intents are what people want ("fall asleep to rain sounds"),
     * prompts are how they ask; both are tracked per storefront in Appeeky AI Visibility.
     */
    aiVisibility: z
      .object({
        /** Which app to watch when it is on both stores; defaults to the App Store app. */
        store: z.enum(STORES).optional(),
        /** Storefronts to watch; defaults to the first storefront under targets. */
        countries: z.array(countryCode).min(1).optional(),
        /** What people ask AI assistants, per storefront. `visibility sync` sends them to Appeeky. */
        intents: z.record(countryCode, z.array(aiIntent)).default({}),
      })
      .strict()
      .optional(),
    /** Rank in the app's category chart (top 100), recorded daily by `category pull`. */
    category: z
      .object({
        /** App Store genre id, e.g. "6013" for Health & Fitness; read from the app when left out. */
        appStore: z.string().regex(/^\d+$/, "Use the numeric App Store genre id, e.g. 6013").optional(),
        /** Google Play category, e.g. HEALTH_AND_FITNESS. */
        googlePlay: z.string().regex(/^[A-Z_]+$/, "Use the Google Play category id, e.g. HEALTH_AND_FITNESS").optional(),
        /** Defaults to top-paid for a paid App Store app, top-free otherwise. */
        chart: z.enum(CHARTS).optional(),
        /** Storefronts to record; defaults to the storefronts under targets. */
        countries: z.array(countryCode).min(1).optional(),
      })
      .strict()
      .optional(),
    /** Who the app is for. Experiments, screenshots and UGC refer to these by id. */
    personas: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-z0-9-]+$/),
            name: z.string().min(1),
            description: z.string().optional(),
            /** How this persona searches: seeds for targets and keyword ideas. */
            searches: z.array(z.string()).default([]),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();

export type SpecFile = z.infer<typeof specFileSchema>;
export type SpecFileInput = z.input<typeof specFileSchema>;

/**
 * One App Store locale: `appeeky/store/app-store/<locale>.yaml`.
 * A field left out is not managed by the spec: it is never diffed or pushed.
 */
export const appStoreListingSchema = z
  .object({
    name: z.string().optional(),
    subtitle: z.string().optional(),
    keywords: z.string().optional(),
    promotionalText: z.string().optional(),
    description: z.string().optional(),
    whatsNew: z.string().optional(),
    marketingUrl: z.string().url().optional(),
    supportUrl: z.string().url().optional(),
  })
  .strict();

export type AppStoreListing = z.infer<typeof appStoreListingSchema>;

/** One Google Play language: `appeeky/store/google-play/<language>.yaml`. */
export const googlePlayListingSchema = z
  .object({
    title: z.string().optional(),
    shortDescription: z.string().optional(),
    fullDescription: z.string().optional(),
    video: z.string().url().optional(),
  })
  .strict();

export type GooglePlayListing = z.infer<typeof googlePlayListingSchema>;

export type Listing = AppStoreListing | GooglePlayListing;

export const APP_STORE_FIELDS = [
  "name",
  "subtitle",
  "keywords",
  "promotionalText",
  "description",
  "whatsNew",
  "marketingUrl",
  "supportUrl",
] as const satisfies readonly (keyof AppStoreListing)[];

export const GOOGLE_PLAY_FIELDS = [
  "title",
  "shortDescription",
  "fullDescription",
  "video",
] as const satisfies readonly (keyof GooglePlayListing)[];

export type AppStoreField = (typeof APP_STORE_FIELDS)[number];
export type GooglePlayField = (typeof GOOGLE_PLAY_FIELDS)[number];

export function fieldsFor(store: StoreId): readonly string[] {
  return store === "app-store" ? APP_STORE_FIELDS : GOOGLE_PLAY_FIELDS;
}

/** Listings of one store, keyed by locale. */
export type StoreListings<T extends Listing = Listing> = Record<string, T>;

/** A whole spec as loaded from disk. */
export interface Project {
  /** Folder that holds `appeeky.spec.yaml`. */
  root: string;
  spec: SpecFile;
  listings: {
    "app-store": StoreListings<AppStoreListing>;
    "google-play": StoreListings<GooglePlayListing>;
  };
}
