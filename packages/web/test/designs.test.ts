import { describe, expect, it } from "vitest";
import { ordered, whenChanged } from "../src/components/DesignsPanel.js";

describe("the design list", () => {
  it("puts starred designs first, then the most recently changed", () => {
    const list = [
      { name: "Bench", starred: false, changed: "2026-10-03T08:00:00Z" },
      { name: "Console", starred: true, changed: "2026-09-01T08:00:00Z" },
      { name: "Shelf", starred: false, changed: "2026-10-03T09:00:00Z" },
      { name: "Desk", starred: true, changed: "2026-10-02T08:00:00Z" },
    ];
    expect(ordered(list).map((d) => d.name)).toEqual(["Desk", "Console", "Shelf", "Bench"]);
  });

  it("says when each changed in a few words", () => {
    const now = Date.parse("2026-10-03T12:00:00Z");
    expect(whenChanged("2026-10-03T11:59:40Z", now)).toBe("just now");
    expect(whenChanged("2026-10-03T11:57:00Z", now)).toBe("3 minutes ago");
    expect(whenChanged("2026-10-03T09:00:00Z", now)).toBe("3 hours ago");
    expect(whenChanged("2026-10-02T10:00:00Z", now)).toBe("yesterday");
    expect(whenChanged("2026-09-29T12:00:00Z", now)).toBe("4 days ago");
    expect(whenChanged(null, now)).toBe("");
  });
});
