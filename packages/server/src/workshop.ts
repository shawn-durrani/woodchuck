// Your workshop: the tools you have, your usual finishes, the language
// Claude writes in and the country it searches for parts in. It's kept in
// the data folder beside the other app-wide files, never in a design.
// Claude reads it as one block of its standing instructions, so the cached
// prompt only changes when you change these.

export interface Workshop {
  /** The tools you have, one to an entry. */
  tools: string[];
  /** Your usual finishes, in your own words. */
  finishes: string;
  /** The language Claude writes in, such as Australian English. */
  language: string;
  /** Where the web search looks for parts, as two letters such as AU, or empty for anywhere. */
  country: string;
}

/** What a new install starts with: a standard home workshop. */
export const DEFAULT_WORKSHOP: Workshop = {
  tools: ["Table saw or track saw", "Router", "Drill/driver", "Pocket-hole jig", "Chisels", "Clamps"],
  finishes: "Linolie Satin Wood Oil for colour, and Osmo Polyx-Oil Raw 3044 on all birch plywood.",
  language: "Australian English",
  country: "AU",
};

export const MAX_TOOLS = 30;
export const MAX_TOOL_CHARS = 80;
export const MAX_FINISHES_CHARS = 600;
export const MAX_LANGUAGE_CHARS = 40;

export class WorkshopError extends Error {}

const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/;
const LINE_BREAK = /[\r\n]/;

/**
 * Checks new settings, laid over the ones you have. A field left out keeps
 * its value. Throws a WorkshopError, in plain words, for anything it can't use.
 */
export function readWorkshop(input: unknown, base: Workshop = DEFAULT_WORKSHOP): Workshop {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new WorkshopError("Send the workshop as an object");
  const o = input as Record<string, unknown>;
  const out: Workshop = { ...base, tools: [...base.tools] };

  if (o.tools !== undefined) {
    if (!Array.isArray(o.tools) || o.tools.some((t) => typeof t !== "string")) throw new WorkshopError("List the tools as lines of text");
    const tools = (o.tools as string[]).map((t) => t.trim()).filter(Boolean);
    if (tools.length > MAX_TOOLS) throw new WorkshopError(`List up to ${MAX_TOOLS} tools`);
    if (tools.some((t) => t.length > MAX_TOOL_CHARS || CONTROL.test(t) || LINE_BREAK.test(t))) {
      throw new WorkshopError(`Keep each tool to one line of up to ${MAX_TOOL_CHARS} characters`);
    }
    out.tools = tools;
  }

  if (o.finishes !== undefined) {
    if (typeof o.finishes !== "string") throw new WorkshopError("Write your usual finishes as text");
    const finishes = o.finishes.replace(/\r\n?/g, "\n").trim();
    if (finishes.length > MAX_FINISHES_CHARS || CONTROL.test(finishes)) throw new WorkshopError(`Keep your usual finishes to ${MAX_FINISHES_CHARS} characters`);
    out.finishes = finishes;
  }

  if (o.language !== undefined) {
    const language = typeof o.language === "string" ? o.language.trim() : "";
    if (!language || language.length > MAX_LANGUAGE_CHARS || CONTROL.test(language) || LINE_BREAK.test(language)) {
      throw new WorkshopError("Name the language Claude writes in, such as Australian English");
    }
    out.language = language;
  }

  if (o.country !== undefined) {
    const country = typeof o.country === "string" ? o.country.trim().toUpperCase() : null;
    if (country === null || (country && !/^[A-Z]{2}$/.test(country))) {
      throw new WorkshopError("The country must be two letters, such as AU, GB or US, or empty to search anywhere");
    }
    out.country = country;
  }
  return out;
}

/** Settings read back from disk. A field that's missing or broken falls back to the default, so a bad file never stops Claude. */
export function workshopFromFile(raw: unknown): Workshop {
  const o = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  let w = DEFAULT_WORKSHOP;
  for (const key of ["tools", "finishes", "language", "country"] as const) {
    if (o[key] === undefined) continue;
    try {
      w = readWorkshop({ [key]: o[key] }, w);
    } catch {
      // Keep what's there so far for this field.
    }
  }
  return w;
}

/** WOODCHUCK_SEARCH_COUNTRY, when it's two letters. It wins over the setting. */
export function countryOverride(value = process.env.WOODCHUCK_SEARCH_COUNTRY): string | null {
  const v = value?.trim().toUpperCase();
  return v && /^[A-Z]{2}$/.test(v) ? v : null;
}

/** The country the web search uses, or null to search anywhere. */
export function searchCountry(w: Workshop, override = countryOverride()): string | null {
  return override ?? (w.country || null);
}

/**
 * The workshop as Claude reads it, the last block of its standing
 * instructions. The same settings always give the same text, so the prompt
 * cache holds until you change them.
 */
export function workshopText(w: Workshop): string {
  const tools = w.tools.length
    ? `Tools they have: ${w.tools.join("; ")}.`
    : "Tools they have: none listed yet. Ask with ask_user when a choice depends on a tool.";
  const finishes = w.finishes ? `Their usual finishes: ${w.finishes}` : "Their usual finishes: none given yet. Ask before choosing a finish.";
  return [
    "# The woodworker's workshop",
    "",
    "These are the woodworker's own settings, from the Your workshop section in Woodchuck. They can change them there at any time.",
    "",
    tools,
    "",
    finishes,
    "",
    `Language: ${w.language}. Write every reply in it.`,
  ].join("\n");
}
