// The History tab's one list: this session's change sets and the saved
// versions, merged, newest first, each with who made it, what changed and
// the version to restore.

import { describe, expect, it } from "vitest";
import { historyRows } from "../src/historyList.js";

const change = (id: number, author: "you" | "claude" | "example", label: string, at: string) => ({ id, author, label, at });
const version = (sha: string, author: string, message: string, at: string) => ({ sha, author, message, at });

describe("History and Versions as one list", () => {
  const history = [
    change(1, "claude", "Make me a reading bench for Dave", "2026-10-04T01:00:00.400Z"),
    change(2, "you", "Set shelf_top", "2026-10-04T01:05:00.200Z"),
    change(3, "claude", "Raise the book shelf", "2026-10-04T01:09:00.100Z"),
  ];
  // Git keeps whole seconds, and a version is saved just after its change set.
  const versions = [
    version("c4", "You", "Undo: Raise the book shelf", "2026-10-04T12:10:00+11:00"),
    version("c3", "Claude", "Raise the book shelf", "2026-10-04T12:09:01+11:00"),
    version("c2", "You", "Set shelf_top", "2026-10-04T12:05:00+11:00"),
    version("c1", "You", "Versions start here", "2026-10-04T11:59:00+11:00"),
  ];
  const rows = historyRows(history, versions);

  it("shows each change once, newest first, with who made it and what it was", () => {
    expect(rows.map((r) => [r.who, r.label])).toEqual([
      ["You", "Undo: Raise the book shelf"],
      ["Claude", "Raise the book shelf"],
      ["You", "Set shelf_top"],
      ["Claude", "Make me a reading bench for Dave"],
      ["You", "Versions start here"],
    ]);
    expect(rows.map((r) => r.whoClass)).toEqual(["you", "claude", "you", "claude", "you"]);
  });

  it("gives a change set the version saved with it, to compare and restore", () => {
    expect(rows.find((r) => r.label === "Raise the book shelf")).toMatchObject({ sha: "c3", session: true });
    expect(rows.find((r) => r.label === "Set shelf_top")).toMatchObject({ sha: "c2", session: true });
    // Made before the versions started, so there's nothing to restore it from.
    expect(rows.find((r) => r.label.startsWith("Make me"))).toMatchObject({ session: true });
    expect(rows.find((r) => r.label.startsWith("Make me"))!.sha).toBeUndefined();
  });

  it("keeps versions with no change set, such as an undo, and marks the newest as now", () => {
    expect(rows[0]).toMatchObject({ sha: "c4", session: false, latest: true });
    expect(rows.filter((r) => r.latest)).toHaveLength(1);
    expect(rows.find((r) => r.sha === "c1")).toMatchObject({ who: "You", session: false, latest: false });
  });

  it("only pairs a change set with a version by the same author, with the same words, saved at the same time", () => {
    const other = historyRows([change(9, "you", "Set shelf_top", "2026-10-04T03:00:00Z")], [version("x1", "You", "Set shelf_top", "2026-10-04T12:05:00+11:00")]);
    expect(other).toHaveLength(2);
    expect(other.find((r) => r.session)!.sha).toBeUndefined();
    const claude = historyRows([change(4, "claude", "Set shelf_top", "2026-10-04T01:05:00Z")], [version("x2", "You", "Set shelf_top", "2026-10-04T12:05:00+11:00")]);
    expect(claude).toHaveLength(2);
  });

  it("names the example's changes, and Woodchuck's own versions", () => {
    const r = historyRows([change(1, "example", "Started from the example", "2026-10-04T01:00:00Z")], [version("e1", "Woodchuck", "Started from the example", "2026-10-04T12:00:00+11:00")]);
    expect(r).toEqual([expect.objectContaining({ who: "Example", whoClass: "example", sha: "e1", latest: true, session: true })]);
    expect(historyRows([], [version("w1", "Woodchuck", "Deleted Bedside table", "2026-10-04T12:00:00+11:00")])[0]).toMatchObject({ who: "Woodchuck", whoClass: "woodchuck" });
  });

  it("is empty with no changes and no versions, and works with the history off", () => {
    expect(historyRows([], [])).toEqual([]);
    expect(historyRows(history, []).map((r) => r.sha)).toEqual([undefined, undefined, undefined]);
  });
});
