// A selection reads as one line above the chat box, and an array copy
// offers to edit every copy at once.

import { describe, expect, it } from "vitest";
import { editAllLabel, partNamer, pinsLine, plural, selectionLine } from "../src/names.js";

// Shaped as the model derives them: a copy's own name carries its number.
const slats = Array.from({ length: 15 }, (_, i) => ({
  id: i === 0 ? "seat_slat" : `seat_slat#${i + 1}`,
  name: i === 0 ? "Seat slat" : `Seat slat ${i + 1}`,
  copy: i + 1,
  source: "seat_slat",
}));
const parts = [{ id: "leg_fl", name: "Leg, front left", copy: 1, source: "leg_fl" }, ...slats];
const name = partNamer(parts);

describe("the selection line", () => {
  it("counts many parts on one line and lists their names", () => {
    const ids = ["leg_fl", ...slats.slice(0, 20).map((p) => p.id)];
    const line = selectionLine(ids, name)!;
    expect(line.text).toBe("16 parts selected");
    expect(line.list.slice(0, 3)).toEqual(["Leg, front left", "Seat slat 1 of 15", "Seat slat 2 of 15"]);
  });

  it("names a single part and has nothing to list", () => {
    expect(selectionLine(["seat_slat#9"], name)).toEqual({ text: "Seat slat 9 of 15 selected", list: [] });
  });

  it("counts faces as faces", () => {
    expect(selectionLine(["leg_fl.top", "leg_fl.front"], name)!.text).toBe("2 faces selected");
  });

  it("is gone when nothing is selected", () => {
    expect(selectionLine([], name)).toBeNull();
  });

  it("counts pins, and lists each pin's part and face", () => {
    const pins = [
      { n: 1, part: "seat_slat#9", face: "top" },
      { n: 2, part: "leg_fl", face: "front" },
    ];
    expect(pinsLine(pins, name)).toEqual({ text: "2 pins dropped", list: ["Pin 1 on Seat slat 9 of 15, top face", "Pin 2 on Leg, front left, front face"] });
    expect(pinsLine(pins.slice(0, 1), name)).toEqual({ text: "Pin 1 on Seat slat 9 of 15, top face", list: [] });
  });

  it("names a copy by its original, so the number shows once", () => {
    expect(name("seat_slat#9")).toBe("Seat slat 9 of 15");
    expect(name("seat_slat#9.top")).toBe("Seat slat 9 of 15, top face");
  });
});

describe("editing every copy of an array", () => {
  it("offers Edit all on a copy, named for many", () => {
    expect(editAllLabel(slats[8]!, parts)).toBe("Edit all 15 seat slats");
  });

  it("offers nothing on the original or on a part with no copies", () => {
    expect(editAllLabel(slats[0]!, parts)).toBeNull();
    expect(editAllLabel(parts[0]!, parts)).toBeNull();
  });

  it("names many of a part in plain English", () => {
    expect(plural("Seat slat")).toBe("seat slats");
    expect(plural("Shelf")).toBe("shelves");
    expect(plural("Drawer box")).toBe("drawer boxes");
    expect(plural("Divider body")).toBe("divider bodies");
    expect(plural("Leg, front left")).toBe("legs, front left");
    expect(plural("LP divider")).toBe("LP dividers");
  });
});
