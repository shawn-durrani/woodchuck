// Chips, pins and lists read by a part's name, with the id kept for hover.

import { describe, expect, it } from "vitest";
import { partNamer } from "../src/names.js";

const parts = [
  { id: "leg_fl", name: "Leg, front left", copy: 1, source: "leg_fl" },
  { id: "seat_slat", name: "Seat slat", copy: 1, source: "seat_slat" },
  { id: "seat_slat#2", name: "Seat slat", copy: 2, source: "seat_slat" },
  { id: "seat_slat#3", name: "Seat slat", copy: 3, source: "seat_slat" },
];

describe("part names", () => {
  const name = partNamer(parts);

  it("names a part by its name", () => {
    expect(name("leg_fl")).toBe("Leg, front left");
  });

  it("numbers array copies out of how many there are", () => {
    expect(name("seat_slat")).toBe("Seat slat 1 of 3");
    expect(name("seat_slat#3")).toBe("Seat slat 3 of 3");
  });

  it("reads the original alone, as a joint names it, by its number", () => {
    expect(name("seat_slat#1")).toBe("Seat slat 1 of 3");
  });

  it("names a face by its part", () => {
    expect(name("seat_slat#2.top")).toBe("Seat slat 2 of 3, top face");
  });

  it("keeps the id for anything it doesn't know, such as a deleted part", () => {
    expect(name("shelf")).toBe("shelf");
    expect(name("shelf.top")).toBe("shelf.top");
  });
});
