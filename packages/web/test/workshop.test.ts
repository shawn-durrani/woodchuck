// The Your workshop section's form: the tools one to a line, the
// country in capitals, and what the country field says when
// WOODCHUCK_SEARCH_COUNTRY sets it instead.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { designItem, DESIGN_MENU } from "../src/designMenu.js";
import { WorkshopPanel } from "../src/components/WorkshopPanel.js";
import { ALL_SECTIONS } from "../src/tabs.js";
import { countryNote, formOf, sameWorkshop, workshopOf, type Workshop } from "../src/workshop.js";

const today: Workshop = {
  tools: ["Table saw or track saw", "Router", "Drill/driver", "Pocket-hole jig", "Chisels", "Clamps"],
  finishes: "Linolie Satin Wood Oil for colour, and Osmo Polyx-Oil Raw 3044 on all birch plywood.",
  language: "Australian English",
  country: "AU",
};

describe("your workshop's form", () => {
  it("shows the tools one to a line, and reads them back without blank lines", () => {
    const form = formOf(today);
    expect(form.tools).toBe("Table saw or track saw\nRouter\nDrill/driver\nPocket-hole jig\nChisels\nClamps");
    expect(workshopOf(form)).toEqual(today);
    expect(workshopOf({ ...form, tools: " Bandsaw \n\n  \nSpokeshave", country: " gb ", language: " British English " })).toEqual({
      ...today,
      tools: ["Bandsaw", "Spokeshave"],
      country: "GB",
      language: "British English",
    });
  });

  it("knows when nothing has changed, so Save stays off", () => {
    expect(sameWorkshop(workshopOf(formOf(today)), today)).toBe(true);
    expect(sameWorkshop({ ...today, tools: [...today.tools, "Bandsaw"] }, today)).toBe(false);
    expect(sameWorkshop({ ...today, country: "" }, today)).toBe(false);
  });

  it("says what the country does, and when the .env file sets it instead", () => {
    expect(countryNote(null)).toBe("Two letters, such as AU, GB or US. Leave it empty to search anywhere.");
    expect(countryNote("NZ")).toBe("Set to NZ by WOODCHUCK_SEARCH_COUNTRY in the .env file, which wins over this.");
  });

  it("waits for the server before it shows the form", () => {
    expect(renderToStaticMarkup(createElement(WorkshopPanel))).toContain("Loading…");
  });
});

describe("where your workshop lives", () => {
  it("is the last section of the All designs and parts page, and an item in the design menu that opens it", () => {
    expect(ALL_SECTIONS.at(-1)).toEqual({ id: "workshop", label: "Your workshop", panel: "workshop" });
    expect(DESIGN_MENU.indexOf("workshop")).toBe(DESIGN_MENU.indexOf("all") + 1);
    expect(designItem("workshop")).toEqual({ label: "Your workshop", tip: "The tools you have, your usual finishes, and the language and country Claude uses" });
  });
});
