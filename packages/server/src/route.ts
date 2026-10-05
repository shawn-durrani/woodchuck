// How hard Claude thinks on a turn. A few plain rules read the woodworker's
// message and what Claude is waiting on, and pick a level. A colour try or a
// question about the design needs little thought, a small size change some,
// and a new build, a photo or anything about joints and strength the full
// amount. Anything the rules don't recognise gets the full amount too, so a
// wrong guess costs time, never judgement.
//
// No model is asked to classify. The rules are deterministic, so tests pin
// them and the same message always gets the same level.

import { PALETTES } from "@woodchuck/core";

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

export function isEffort(v: unknown): v is Effort {
  return (EFFORTS as readonly unknown[]).includes(v);
}

/** The lower of two levels, so a turn never thinks harder than the configured level. */
export function atMost(effort: Effort, ceiling: Effort): Effort {
  return EFFORTS.indexOf(effort) <= EFFORTS.indexOf(ceiling) ? effort : ceiling;
}

/** The higher of two levels. */
export function atLeast(effort: Effort, floor: Effort): Effort {
  return EFFORTS.indexOf(effort) >= EFFORTS.indexOf(floor) ? effort : floor;
}

/**
 * Whether turns pick their own level. "off" runs every turn at the
 * configured level.
 */
export function effortRouting(value = process.env.WOODCHUCK_EFFORT_ROUTING): boolean {
  return value?.trim().toLowerCase() !== "off";
}

/** What the rules read at the start of a turn. */
export interface TurnSignals {
  /** The woodworker's words, with any notes the app added in brackets. */
  text: string;
  /** Photos, sketches and PDFs attached to the message. */
  attachments: number;
  /** What Claude's last turn was waiting on, if anything. */
  waiting: readonly ("question" | "plan" | "part" | "preview")[];
  /** Whether the design has no parts yet. */
  emptyDesign: boolean;
}

export type RouteReason =
  | "attachment"
  | "answer"
  | "approval"
  | "long"
  | "new_build"
  | "judgement"
  | "build"
  | "finish"
  | "question"
  | "small_edit"
  | "unrecognised";

export interface Route {
  effort: Effort;
  reason: RouteReason;
}

/** Longer messages carry more than one request, so they get the full level. */
const LONG_WORDS = 40;
/** A reply to a plan or preview this short, made only of approving words, is an approval. */
const APPROVAL_WORDS_MAX = 8;
/** A small edit is said in a sentence or two. */
const SMALL_EDIT_WORDS = 30;

const words = (list: string) => new Set(list.trim().split(/\s+/));

/** Words that approve or turn down a plan or preview, and nothing else. */
const APPROVING = words(`
  looks look right good great fine lovely nice perfect brilliant excellent spot on
  lgtm approve approved yes yep yeah yup ok okay sure go ahead do it apply
  that that's thats is sounds all thanks thank you cheers please
  not now no leave as skip love
`);

/** Joints, strength and hardware: the woodworking judgement the full level is for. */
const JUDGEMENT = new RegExp(
  "\\b(" +
    [
      "joints?",
      "joinery",
      "dados?",
      "housings?",
      "grooves?",
      "rabbets?",
      "rebates?",
      "tenons?",
      "mortises?",
      "mortices?",
      "dovetails?",
      "laps?",
      "half.lap",
      "finger",
      "dowels?",
      "biscuits?",
      "dominos?",
      "pocket",
      "screws?",
      "glue",
      "glued",
      "strong",
      "stronger",
      "strength",
      "sturdy",
      "sturdier",
      "sags?",
      "sagging",
      "load",
      "loads",
      "weight",
      "heavy",
      "racking",
      "wobbl\\w*",
      "stable",
      "stability",
      "stiff\\w*",
      "brac\\w+",
      "support\\w*",
      "movement",
      "expan\\w+",
      "shrink\\w*",
      "warp\\w*",
      "cracks?",
      "slides?",
      "runners?",
      "hinges?",
      "hardware",
      "slop\\w*",
      "taper\\w*",
      "chamfer\\w*",
      "bevel\\w*",
      "angled?",
      "diagonal\\w*",
      "holes?",
      "slots?",
      "notch\\w*",
      "cut ?outs?",
      "cut (?:a|an|away|off|into|through|back|down)",
      "safe",
      "safety",
      "why",
      "should",
      "better",
      "best",
      "recommend\\w*",
      "suggest\\w*",
      "advice",
      "advise",
      "ideas?",
      "improve\\w*",
      "enough",
      "too",
      "fix",
      "problems?",
      "errors?",
      "wrong",
      "check",
      "plan",
    ].join("|") +
    ")\\b",
  "i",
);

/** New parts, new pieces, research and links: work that adds or reshapes. */
const BUILDING = new RegExp(
  "\\b(" +
    [
      "build",
      "design (?:a|an|me|my|some)",
      "create",
      "new",
      "start",
      "redesign",
      "rebuild",
      "scratch",
      "add",
      "adding",
      "another",
      "extra",
      "remove",
      "delete",
      "replace",
      "swap",
      "split",
      "divide",
      "convert",
      "into",
      "library",
      "research",
      "search",
      "look up",
      "find",
      "spec",
      "datasheet",
      "https?",
      "www",
      "undo",
    ].join("|") +
    ")\\b",
  "i",
);

/** Words about colour and finish. "finish" itself is left out, since "finish the drawers" means complete them. */
const FINISH_WORDS = /\b(colou?rs?|oils?|oiled|stain\w*|tint\w*|paint\w*|varnish\w*|lacquer\w*|wax\w*|whitewash\w*|swatch\w*|shade|darker|osmo|linolie)\b/i;

/** "Ella Ø" becomes "ella o", the way a colour's name is matched in a message. */
function plain(s: string): string {
  return s
    .toLowerCase()
    .replace(/ø/g, "o")
    .replace(/å/g, "a")
    .replace(/æ/g, "ae")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Every colour's name, such as "amsterdam" or "tokyo lys". Numbers are left out, since "13" could as well be a size. */
const COLOUR_NAMES = PALETTES.flatMap((p) => p.colours.map((c) => plain(c.name))).filter((n) => n && !/^\d+$/.test(n));

function namesColour(text: string): boolean {
  const t = ` ${plain(text)} `;
  return COLOUR_NAMES.some((n) => t.includes(` ${n} `));
}

const QUESTION_OPENERS = words(`
  what what's whats how how's hows which where when who whose
  is isn't are aren't does doesn't do did can could will would has have was were
`);

/** Verbs that ask for a change, so a question carrying one is a request. */
const CHANGE = /\b(make|change|set|move|put|turn|use|try|resize|increase|decrease|raise|lower|widen|narrow|deepen|shorten|lengthen|thicken|thin|align|flush|cent(?:re|er)|shift|rotate|flip|mirror|rename|double|halve|drop|lift|push|pull)\b/i;

/** A size said as bigger or smaller. */
const SIZE_WORD = /\b(taller|shorter|wider|narrower|deeper|shallower|thicker|thinner|longer|bigger|smaller|higher|lower|larger)\b/i;
/** A number, with or without a unit. */
const NUMBER = /\b\d+(?:\.\d+)?\s*(?:mm|cm|m|millimet(?:re|er)s?|centimet(?:re|er)s?)?\b/i;
/** A count of repeated parts, such as "four drawers". */
const COUNT = /\b(\d+|two|three|four|five|six|seven|eight|nine|ten)\s+(shelves|drawers|doors|partitions|dividers|slats|rows|columns|legs|rails)\b/i;

/** The words without the notes the app adds in brackets, such as "(The preview wasn't applied.)". */
function spoken(text: string): string {
  return text.replace(/\([^()]*\)/g, " ").trim();
}

function wordList(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[’]/g, "'")
    .split(/[^a-z0-9'.]+/)
    .map((w) => w.replace(/^[.']+|[.']+$/g, ""))
    .filter(Boolean);
}

/**
 * The level for a turn, and which rule picked it. The first rule that
 * matches wins, and every level is capped at the configured one.
 */
export function routeTurn(s: TurnSignals, configured: Effort): Route {
  const pick = (effort: Effort, reason: RouteReason): Route => ({ effort: atMost(effort, configured), reason });
  const said = spoken(s.text);
  const list = wordList(said);

  // A photo, sketch or spec sheet is read for style, proportions and joints.
  if (s.attachments > 0) return pick(configured, "attachment");
  // An answer to a question lets Claude build, and an answer about a part has Claude place it.
  if (s.waiting.includes("question") || s.waiting.includes("part")) return pick(configured, "answer");
  // "Looks right" to a plan, or "Apply it" to a preview, leaves little to think about.
  if ((s.waiting.includes("plan") || s.waiting.includes("preview")) && list.length > 0 && list.length <= APPROVAL_WORDS_MAX && list.every((w) => APPROVING.has(w))) {
    return pick("low", "approval");
  }
  if (list.length > LONG_WORDS) return pick(configured, "long");
  if (s.emptyDesign) return pick(configured, "new_build");
  if (JUDGEMENT.test(said)) return pick(configured, "judgement");
  if (BUILDING.test(said)) return pick(configured, "build");
  if (FINISH_WORDS.test(said) || namesColour(said)) return pick("low", "finish");
  const asks = said.endsWith("?") || QUESTION_OPENERS.has(list[0] ?? "");
  const changes = CHANGE.test(said) || SIZE_WORD.test(said);
  if (asks && !changes) return pick("low", "question");
  if (list.length <= SMALL_EDIT_WORDS && (SIZE_WORD.test(said) || COUNT.test(said) || (CHANGE.test(said) && NUMBER.test(said)))) {
    return pick("medium", "small_edit");
  }
  return pick(configured, "unrecognised");
}

/**
 * Tools that mean Claude has reached a judgement call: joints, hardware,
 * parts research, a plan, a question or a suggestion. A turn below the
 * configured level goes back up to it for the rest of the turn once Claude
 * calls one. The web tools run on Anthropic's side and count too.
 */
export const JUDGEMENT_TOOLS: ReadonlySet<string> = new Set([
  "list_joints",
  "show_joint",
  "add_joint",
  "delete_joint",
  "set_hardware",
  "set_edge_cut",
  "set_cutout",
  "delete_cut",
  "list_library_parts",
  "propose_library_part",
  "request_tool",
  "add_unverified_box",
  "clear_design",
  "ask_user",
  "submit_plan",
  "preview_change",
  "web_search",
  "web_fetch",
]);

export function needsJudgement(toolNames: readonly string[]): boolean {
  return toolNames.some((n) => JUDGEMENT_TOOLS.has(n));
}
