// Your workshop, as the Your workshop section edits it: the tools you have,
// your usual finishes, the language Claude writes in and the country it
// searches for parts in. The server keeps it beside the other app-wide
// settings, never in a design. Kept free of React so the tests can hold it.

export interface Workshop {
  tools: string[];
  finishes: string;
  language: string;
  country: string;
}

/** What GET and POST /api/workshop answer. */
export interface WorkshopState {
  workshop: Workshop;
  defaults: Workshop;
  /** The country WOODCHUCK_SEARCH_COUNTRY sets over the one here, if it's set. */
  country_override: string | null;
}

/** The form's fields, as you type them. The tools are one to a line. */
export interface WorkshopForm {
  tools: string;
  finishes: string;
  language: string;
  country: string;
}

export const formOf = (w: Workshop): WorkshopForm => ({ tools: w.tools.join("\n"), finishes: w.finishes, language: w.language, country: w.country });

/** The form as settings to save: a tool to each line that has one, and the country in capitals. */
export const workshopOf = (f: WorkshopForm): Workshop => ({
  tools: f.tools
    .split("\n")
    .map((t) => t.trim())
    .filter(Boolean),
  finishes: f.finishes.trim(),
  language: f.language.trim(),
  country: f.country.trim().toUpperCase(),
});

export const sameWorkshop = (a: Workshop, b: Workshop) =>
  a.tools.length === b.tools.length && a.tools.every((t, i) => t === b.tools[i]) && a.finishes === b.finishes && a.language === b.language && a.country === b.country;

/** What the country field says under it. */
export const countryNote = (override: string | null) =>
  override ? `Set to ${override} by WOODCHUCK_SEARCH_COUNTRY in the .env file, which wins over this.` : "Two letters, such as AU, GB or US. Leave it empty to search anywhere.";

export const SAVED = "Saved. Claude works with it from your next message.";
