// Issue #11: the rules that pick how hard Claude thinks on a turn. Each row
// is a message on an invented design, what Claude was waiting on, and the
// level and rule it should get. Anything unrecognised gets the full level.

import { describe, expect, it } from "vitest";
import { atLeast, atMost, effortRouting, needsJudgement, routeTurn, type Effort, type RouteReason, type TurnSignals } from "../src/route.js";

type Row = [text: string, extra: Partial<TurnSignals>, effort: Effort, reason: RouteReason];

const rows: Row[] = [
  // A photo, sketch or spec sheet, whatever the words say.
  ["Try Amsterdam on the top", { attachments: 1 }, "high", "attachment"],
  ["Like this, but in oak", { attachments: 2 }, "high", "attachment"],
  // An answer to a question or a part lets Claude build or place it.
  ["Ply", { waiting: ["question"] }, "high", "answer"],
  ["Yes", { waiting: ["question"] }, "high", "answer"],
  ["Approved. Add it to the library.", { waiting: ["part"] }, "high", "answer"],
  // Approving or turning down a plan or a preview.
  ["Looks right.", { waiting: ["plan"] }, "low", "approval"],
  ["Looks good, thanks!", { waiting: ["plan"] }, "low", "approval"],
  ["yep go ahead", { waiting: ["plan"] }, "low", "approval"],
  ["Apply it.\n\n(Applied as one change.)", { waiting: ["preview"] }, "low", "approval"],
  ["Not now.", { waiting: ["preview"] }, "low", "approval"],
  ["Yes do it\n\n(The preview wasn't applied.)", { waiting: ["preview"] }, "low", "approval"],
  // A plan reply that asks for changes is read like any other message.
  ["Looks right but make it 50 mm taller", { waiting: ["plan"] }, "medium", "small_edit"],
  ["No, use dovetails on the drawers", { waiting: ["plan"] }, "high", "judgement"],
  // An empty design means a new build.
  ["Try Amsterdam", { emptyDesign: true }, "high", "new_build"],
  ["How wide is it?", { emptyDesign: true }, "high", "new_build"],
  // A long message carries more than one request.
  [`Make it taller ${"and then some more ".repeat(10)}`, {}, "high", "long"],
  // Joints, strength, hardware and advice.
  ["Will the shelf sag under records?", {}, "high", "judgement"],
  ["Make the drawers use undermount slides", {}, "high", "judgement"],
  ["Is 300 mm deep enough?", {}, "high", "judgement"],
  ["Which joint for the top?", {}, "high", "judgement"],
  ["Why is there a gap at the back?", {}, "high", "judgement"],
  ["Should the top be oiled?", {}, "high", "judgement"],
  ["Fix the problems", {}, "high", "judgement"],
  // New parts, new pieces and research.
  ["Add a shelf 200 mm up", {}, "high", "build"],
  ["Build me a bookcase for Sam", {}, "high", "build"],
  ["Remove the middle partition", {}, "high", "build"],
  ["Find a soft-close hinge from AcmeCo", {}, "high", "judgement"],
  ["Slope the drawer sides down to the front", {}, "high", "judgement"],
  ["Make the side 40 mm taller and chamfer the top corner", {}, "high", "judgement"],
  ["Cut a 35 mm hole in the back for cables", {}, "high", "judgement"],
  ["Notch the sides for a toe kick", {}, "high", "judgement"],
  ["Read https://example.com/console", {}, "high", "build"],
  ["Split the top into two boards", {}, "high", "build"],
  // Colour and finish tries.
  ["Try Amsterdam on the top", {}, "low", "finish"],
  ["Oil the carcass in Kyoto and the fronts Natur", {}, "low", "finish"],
  ["What colour is the top?", {}, "low", "finish"],
  ["Make it a bit darker", {}, "low", "finish"],
  ["Tokyo Lys on the drawer fronts", {}, "low", "finish"],
  // Questions about the design that ask for no change.
  ["How wide is it?", {}, "low", "question"],
  ["What's the cut list come to?", {}, "low", "question"],
  ["how many drawers are there", {}, "low", "question"],
  ["Which timber is the top", {}, "low", "question"],
  // Small edits to an existing design.
  ["Make the shelf 20 mm deeper", {}, "medium", "small_edit"],
  ["Can you make it taller?", {}, "medium", "small_edit"],
  ["Set top_length to 1800", {}, "medium", "small_edit"],
  ["Make it four drawers instead of five", {}, "medium", "small_edit"],
  ["Lower the bottom rail by 15 mm", {}, "medium", "small_edit"],
  // Anything else gets the full level.
  ["Carry on", {}, "high", "unrecognised"],
  ["Rename it to Mateo's console", {}, "high", "unrecognised"],
  ["Hmm", {}, "high", "unrecognised"],
  ["finish the drawers", {}, "high", "unrecognised"],
];

const base: TurnSignals = { text: "", attachments: 0, waiting: [], emptyDesign: false };

describe("the level a turn gets", () => {
  it.each(rows)("%j %j is %s (%s)", (text, extra, effort, reason) => {
    expect(routeTurn({ ...base, ...extra, text }, "high")).toEqual({ effort, reason });
  });

  it("never goes above the configured level", () => {
    expect(routeTurn({ ...base, text: "Make the shelf 20 mm deeper" }, "low")).toEqual({ effort: "low", reason: "small_edit" });
    expect(routeTurn({ ...base, text: "Carry on" }, "medium")).toEqual({ effort: "medium", reason: "unrecognised" });
    expect(routeTurn({ ...base, text: "Try Amsterdam on the top" }, "max")).toEqual({ effort: "low", reason: "finish" });
    expect(routeTurn({ ...base, text: "Carry on" }, "max")).toEqual({ effort: "max", reason: "unrecognised" });
  });

  it("gives the same message the same level every time", () => {
    const s = { ...base, text: "Try Amsterdam on the top" };
    expect(routeTurn(s, "high")).toEqual(routeTurn(s, "high"));
  });
});

describe("the tools that need judgement", () => {
  it.each(["list_joints", "show_joint", "add_joint", "set_hardware", "set_edge_cut", "set_cutout", "delete_cut", "propose_library_part", "request_tool", "ask_user", "submit_plan", "preview_change", "web_search", "web_fetch"])(
    "%s raises the level",
    (name) => {
      expect(needsJudgement(["set_finish", name])).toBe(true);
    },
  );

  it.each(["set_finish", "set_param", "get_design", "check_design", "render_views", "update_panel", "measure"])("%s alone leaves it", (name) => {
    expect(needsJudgement([name])).toBe(false);
  });
});

describe("the routing setting", () => {
  it("is on unless it says off", () => {
    expect(effortRouting(undefined)).toBe(true);
    expect(effortRouting("")).toBe(true);
    expect(effortRouting("on")).toBe(true);
    expect(effortRouting("off")).toBe(false);
    expect(effortRouting(" OFF ")).toBe(false);
  });

  it("compares levels in order", () => {
    expect(atMost("high", "medium")).toBe("medium");
    expect(atMost("low", "high")).toBe("low");
    expect(atLeast("low", "high")).toBe("high");
    expect(atLeast("max", "high")).toBe("max");
  });
});
