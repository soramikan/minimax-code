import { describe, expect, it } from "vitest";
import type { ReviewConfig } from "../src/config.js";
import { parseReviewConfig } from "../src/review-config.js";

const defaults: ReviewConfig = { mode: "subagent", modeSource: "default" };

describe("parseReviewConfig", () => {
  it("returns the defaults object for non-object input", () => {
    expect(parseReviewConfig(undefined, defaults)).toBe(defaults);
    expect(parseReviewConfig("subagent", defaults)).toBe(defaults);
    expect(parseReviewConfig(["inline"], defaults)).toBe(defaults);
  });

  it("keeps explicit valid modes and marks them explicit", () => {
    expect(parseReviewConfig({ mode: "inline" }, defaults)).toEqual({
      mode: "inline",
      modeSource: "explicit",
    });
    expect(parseReviewConfig({ mode: "bogus" }, defaults)).toEqual({
      mode: "subagent",
      modeSource: "default",
    });
  });

  it.each(["en", "zh-CN", "ja"] as const)(
    "accepts explicit response language %s",
    (language) => {
      expect(parseReviewConfig({ language }, defaults).language).toBe(language);
    },
  );

  it.each(["fr", "ja-JP", "", 42, null])(
    "ignores invalid response language %s",
    (language) => {
      expect(
        parseReviewConfig({ language }, defaults).language,
      ).toBeUndefined();
    },
  );

  it("parses language independently of mode", () => {
    expect(
      parseReviewConfig({ mode: "inline", language: "ja" }, defaults),
    ).toEqual({ mode: "inline", language: "ja", modeSource: "explicit" });
  });
});
