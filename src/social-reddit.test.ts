import { describe, expect, it } from "vitest";
import { draftIssues, draftSchema, redditExtra, type SocialAccount } from "./social.js";

const accounts: SocialAccount[] = [
  { id: "r1", platform: "reddit", name: "u/sleepdev", active: true },
  { id: "x1", platform: "twitter", name: "@sleepysounds", active: true },
];
const now = new Date("2026-11-14T00:00:00Z");
const issues = (refs: string[], extra: Record<string, unknown> = {}) =>
  draftIssues(draftSchema.parse({ accounts: refs, text: "I built a rain sounds app\nIt works offline.", ...extra }), accounts, now);

describe("Reddit drafts", () => {
  it("needs a subreddit", () => {
    expect(issues(["reddit"])).toEqual(["reddit needs a subreddit: add reddit: { subreddit: … }"]);
    expect(issues(["reddit"], { reddit: { subreddit: "r/SideProject" } })).toEqual([]);
  });

  it("checks the title, or the first line when there is none", () => {
    expect(issues(["reddit"], { reddit: { subreddit: "sleep", title: "a".repeat(301) } })).toEqual(["reddit: title 301/300 characters"]);
    expect(issues(["reddit"], { text: "a".repeat(301), reddit: { subreddit: "sleep" } })[0]).toMatch(/set reddit.title/);
  });

  it("flags reddit options on a draft that doesn't go to Reddit", () => {
    expect(issues(["twitter"], { reddit: { subreddit: "sleep" } })).toEqual(["reddit: options set, but the draft goes to no Reddit account"]);
  });

  it("sends the API's flat keys", () => {
    expect(redditExtra({ subreddit: "r/SideProject", title: "Rain", link: "https://sleep.app", flair_id: "abc" })).toEqual({
      subreddit: "SideProject",
      title: "Rain",
      url: "https://sleep.app",
      flairId: "abc",
    });
  });
});
