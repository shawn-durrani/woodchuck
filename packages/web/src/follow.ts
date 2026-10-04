// Where each of Claude's tools shows on screen, so the screen can follow
// Claude as it works, and each step in the chat can open the control it
// used. A size opens Sizes on its row, a part opens Edit with the part
// picked, a finish opens Finish on its swatch, a material's stock opens the
// cut layout, and the checks open Check. A tool that only reads, or whose
// result shows by itself, such as the ghost of a suggested change, has no
// place to go. Kept free of React so the tests can hold it.

import { finishLabel, paramShortLabel, type DerivedPart, type Design } from "@woodchuck/core";
import { partNamer } from "./names";
import type { MakeView, Tab } from "./tabs";

/** Where a tool's work shows. The last four show by themselves, or not at all. */
export type Where =
  /** Edit, on the size's row in Sizes. */
  | "sizes"
  /** Edit, with the part picked and framed. */
  | "part"
  /** Finish, on the swatch and what it went on. */
  | "finish"
  /** Make, on the material in the cut layout. */
  | "layout"
  /** Make, on the cut list. */
  | "cut-list"
  /** Check. */
  | "check"
  /** The camera menu over the 3D view. */
  | "camera"
  /** The design's name in the top bar. */
  | "name"
  /** The suggested change drawn on the model, which shows itself. */
  | "ghost"
  /** A worked joint beside the model, which opens itself. */
  | "drawer"
  /** A card or the waiting bar in the chat, which shows itself. */
  | "chat"
  /** A read with nothing to show. */
  | "none";

/** Every tool Claude has, and where its work shows. A tool missing here fails a test. */
export const PLACES: Record<string, Where> = {
  get_design: "none",
  set_param: "sizes",
  delete_param: "sizes",
  define_material: "layout",
  set_finish: "finish",
  delete_material: "layout",
  clear_design: "part",
  add_panel: "part",
  update_panel: "part",
  delete_part: "part",
  add_joint: "part",
  delete_joint: "part",
  set_array: "part",
  delete_array: "part",
  set_hardware: "part",
  delete_hardware: "part",
  set_rule: "check",
  delete_rule: "check",
  add_unverified_box: "part",
  rename_design: "name",
  get_part: "part",
  explain: "none",
  measure: "none",
  check_design: "check",
  get_cut_list: "cut-list",
  list_library_parts: "none",
  propose_library_part: "chat",
  recall_chat: "none",
  list_joints: "none",
  render_views: "camera",
  submit_plan: "chat",
  verify_against_plan: "none",
  preview_change: "ghost",
  show_joint: "drawer",
  ask_user: "chat",
  request_tool: "chat",
};

/** The places the screen moves to, with the side panel's tab and the words for it. */
export type Area = Exclude<Where, "ghost" | "drawer" | "chat" | "none">;
export const AREAS: Record<Area, { tab: Tab | null; make?: MakeView; label: string | null }> = {
  sizes: { tab: "edit", label: "Sizes" },
  part: { tab: "edit", label: "Edit" },
  finish: { tab: "finish", label: "Finish" },
  layout: { tab: "make", make: "layout", label: "Cut layout" },
  "cut-list": { tab: "make", make: "list", label: "Make" },
  check: { tab: "check", label: "Check" },
  camera: { tab: null, label: null },
  name: { tab: null, label: null },
};

const isArea = (w: Where | undefined): w is Area => !!w && w in AREAS;

/** What a finish did, read off the design once it changed. Null takes a finish off. */
export interface FinishSeen {
  finish: string | null;
  targets: string[];
}

/** One of Claude's steps, placed on screen. */
export interface Place {
  tool: string;
  area: Area;
  /** What the step names: a size, a part, a material, a joint, an array, hardware or a rule, by its id. */
  id: string;
  /** The views Claude drew, for render_views. */
  views?: string[];
  /** For set_finish, what the design showed it doing. */
  finish?: FinishSeen;
  /** The chat line it came from, so Show me how can find what the design showed. */
  line?: string;
}

/** A tool line from the chat, as the server sends it. */
export interface ToolLine {
  id?: string;
  name: string;
  summary: string;
  is_error?: boolean;
}

/**
 * Where a tool line shows, or null. A step that failed changed nothing, so
 * it has nowhere to show. The server writes the line as the tool's name in
 * words, then the id it was given, such as "set param seat_height".
 */
export function placeOf(line: ToolLine): Place | null {
  if (line.is_error) return null;
  const where = PLACES[line.name];
  if (!isArea(where)) return null;
  const from = line.id ? { line: line.id } : {};
  if (line.name === "render_views") {
    const views = line.summary.replace(/^render\s*/, "").split(/,\s*/).filter(Boolean);
    return { tool: line.name, area: where, id: "", views, ...from };
  }
  const words = line.name.replace(/_/g, " ");
  const id = line.summary.startsWith(`${words} `) ? line.summary.slice(words.length + 1).trim() : "";
  return { tool: line.name, area: where, id, ...from };
}

/** The tab and Make's switch a place opens. */
export const tabOf = (p: Pick<Place, "area">) => AREAS[p.area];

/** What the words and the picks are read from: the design now, and as it was when the turn began, for things since removed. */
export interface Lookup {
  design: Design;
  parts: Pick<DerivedPart, "id" | "name" | "copy" | "source" | "material" | "decor" | "unverified">[];
  before?: Design | null;
}

export function lookupOf(state: { design: Design; derived: { parts: Lookup["parts"] } }, before: Design | null = null): Lookup {
  return { design: state.design, parts: state.derived.parts, before };
}

/** How a place reads and what it lights up. */
export interface Described {
  /** Over the tab, such as "Claude set Seat height in Sizes". */
  caption: string;
  /** As a step in the chat, such as "Set Seat height". */
  words: string;
  /** What lights up, as marks markSelector understands. The tab comes first. */
  marks: string[];
  /** Parts to pick. */
  pick: string[];
  /** Parts to frame in the 3D view. */
  frame: string[];
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const humane = (id: string) => capital(id.replace(/_/g, " "));

/** "front, top, left and iso". */
export function listWords(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** Each lookup's finder, made once, since the chat describes every step on each render. */
const finders = new WeakMap<Lookup, ReturnType<typeof makeFinder>>();

function finder(look: Lookup) {
  let f = finders.get(look);
  if (!f) finders.set(look, (f = makeFinder(look)));
  return f;
}

function makeFinder(look: Lookup) {
  const designs = [look.design, ...(look.before ? [look.before] : [])];
  const find = <K extends "params" | "materials" | "parts" | "joints" | "arrays" | "hardware" | "rules" | "unverified">(key: K, test: (x: Design[K][number]) => boolean) => {
    for (const d of designs) {
      const hit = (d[key] as Design[K][number][]).find(test);
      if (hit) return hit;
    }
    return undefined;
  };
  const named = partNamer(look.parts);
  // An original reads by its own name, since a change to it changes every copy. A copy reads as "Shelf slat 2 of 4".
  const part = (id: string): string => {
    const own = find("parts", (p) => p.id === id)?.name ?? find("unverified", (u) => u.id === id)?.name;
    if (own) return own;
    const n = named(id);
    return n !== id ? n : humane(id);
  };
  const exists = new Set(look.parts.map((p) => p.id));
  return { find, part, exists };
}

/** Finish targets in words, such as "Douglas fir 19 mm" or "Seat, top face and 2 more". */
function targetWords(targets: string[], look: Lookup, part: (id: string) => string): string {
  const one = (t: string) => {
    if (t.startsWith("material:")) {
      const id = t.slice("material:".length);
      return [look.design, look.before].flatMap((d) => d?.materials ?? []).find((m) => m.id === id)?.name ?? humane(id);
    }
    const dot = t.lastIndexOf(".");
    return dot > 0 ? `${part(t.slice(0, dot))}, ${t.slice(dot + 1)} face` : part(t);
  };
  if (targets.length <= 2) return listWords(targets.map(one));
  return `${one(targets[0]!)} and ${targets.length - 1} more`;
}

/** The parts a finish target covers: a part or a face picks its part, and a material frames its parts. */
function finishParts(targets: string[], look: Lookup): { pick: string[]; frame: string[] } {
  const pick = new Set<string>();
  const frame = new Set<string>();
  for (const t of targets) {
    if (t.startsWith("material:")) {
      const id = t.slice("material:".length);
      for (const p of look.parts) if (p.material === id && !p.decor && !p.unverified) frame.add(p.id);
      continue;
    }
    const dot = t.lastIndexOf(".");
    const id = dot > 0 ? t.slice(0, dot) : t;
    pick.add(id);
    frame.add(id);
  }
  return { pick: [...pick], frame: [...frame] };
}

/** How one place reads and what it lights, against the design now. */
export function describe(place: Place, look: Lookup): Described {
  const { find, part, exists } = finder(look);
  const area = AREAS[place.area];
  const real = (ids: string[]) => ids.filter((id) => exists.has(id));
  let verb = "changed";
  let thing = "the design";
  let marks: string[] = [];
  let pick: string[] = [];
  let frame: string[] = [];
  const id = place.id;
  const param = () => {
    const p = find("params", (x) => x.name === id);
    return p ? paramShortLabel(p) : humane(id);
  };
  const material = () => find("materials", (m) => m.id === id)?.name ?? humane(id);
  const partHere = () => {
    pick = real([id]);
    frame = pick;
    marks = pick.length ? ["part"] : [];
    return part(id);
  };
  switch (place.tool) {
    case "set_param":
      verb = "set";
      thing = param();
      marks = [`param:${id}`];
      break;
    case "delete_param":
      verb = "removed";
      thing = param();
      break;
    case "define_material":
      verb = "set up";
      thing = material();
      marks = [`layout:${id}`];
      break;
    case "delete_material":
      verb = "removed";
      thing = material();
      break;
    case "set_finish": {
      const seen = place.finish;
      if (!seen) {
        verb = "chose";
        thing = "a finish";
        break;
      }
      const where = targetWords(seen.targets, look, part);
      verb = seen.finish ? "put" : "took the finish off";
      thing = seen.finish ? `${finishLabel(seen.finish)} on ${where}` : where;
      const parts = finishParts(seen.targets, look);
      pick = real(parts.pick);
      frame = real(parts.frame);
      marks = [
        ...(seen.finish ? [`swatch:${seen.finish}`] : []),
        ...new Set(seen.targets.map((t) => (t.startsWith("material:") ? `target:${t}` : "target:parts"))),
      ];
      break;
    }
    case "clear_design":
      verb = "cleared";
      thing = "the design";
      break;
    case "add_panel":
      verb = "added";
      thing = partHere();
      break;
    case "update_panel":
      verb = "changed";
      thing = partHere();
      break;
    case "get_part":
      verb = "looked at";
      thing = partHere();
      break;
    case "add_unverified_box":
      verb = "added the stand-in";
      thing = partHere();
      break;
    case "delete_part":
      verb = "removed";
      thing = part(id);
      break;
    case "add_joint":
    case "delete_joint": {
      const j = find("joints", (x) => x.id === id);
      const both = j ? `${part(j.host)} and ${part(j.guest)}` : null;
      if (place.tool === "delete_joint") {
        verb = "took apart";
        thing = both ?? "a joint";
        break;
      }
      verb = "joined";
      thing = both ?? "two parts";
      if (j) {
        pick = real([j.host]);
        frame = real([j.host, j.guest]);
      }
      marks = [`joint:${id}`, ...(pick.length ? ["part"] : [])];
      break;
    }
    case "set_array":
    case "delete_array": {
      const a = find("arrays", (x) => x.id === id);
      const names = a ? listWords(a.parts.map(part)) : "parts";
      if (place.tool === "delete_array") {
        verb = "removed the copies of";
        thing = names;
        break;
      }
      verb = "repeated";
      thing = names;
      if (a) {
        pick = real(a.parts);
        frame = look.parts.filter((p) => a.parts.includes(p.source)).map((p) => p.id);
      }
      marks = pick.length ? ["part"] : [];
      break;
    }
    case "set_hardware":
    case "delete_hardware": {
      const h = find("hardware", (x) => x.id === id);
      thing = h?.name ?? humane(id);
      if (place.tool === "delete_hardware") {
        verb = "removed";
        break;
      }
      verb = "fitted";
      pick = real(h?.connects ?? []);
      frame = pick;
      marks = pick.length ? ["part"] : [];
      break;
    }
    case "set_rule":
    case "delete_rule": {
      const r = find("rules", (x) => x.id === id);
      thing = r && r.message.length <= 60 ? `the rule "${r.message}"` : `the rule ${id}`;
      verb = place.tool === "set_rule" ? "set" : "removed";
      if (place.tool === "set_rule") marks = [`rule:${id}`];
      break;
    }
    case "rename_design":
      verb = "renamed";
      thing = "the design";
      marks = ["control:design"];
      break;
    case "check_design":
      verb = "ran";
      thing = "the checks";
      marks = ["check"];
      break;
    case "get_cut_list":
      verb = "read";
      thing = "the cut list";
      marks = ["make:list"];
      break;
    case "render_views":
      verb = "looked at";
      thing = place.views?.length ? `the model from the ${listWords(place.views)}` : "the model";
      marks = ["control:camera"];
      break;
  }
  const words = `${capital(verb)} ${thing}`;
  const caption = `Claude ${verb} ${thing}${area.label ? ` in ${area.label}` : ""}`;
  return { caption, words, marks: [...(area.tab ? [`tab:${area.tab}`] : []), ...marks], pick, frame };
}

/**
 * The CSS selector for a mark. A tab is its button in the tab bar, a
 * toolbar or top bar control its data-control, the checks the Check tab's
 * verdict, and anything else the element carrying it as data-place.
 */
export function markSelector(mark: string): string {
  if (mark.startsWith("tab:")) return `[role="tablist"] [data-tab="${quote(mark.slice(4))}"]`;
  if (mark.startsWith("control:")) return `[data-control="${quote(mark.slice(8))}"]`;
  if (mark === "check") return ".check-tab .ready";
  if (mark === "part") return ".edit-tab .inspector";
  return `[data-place="${quote(mark)}"]`;
}

const quote = (s: string) => s.replace(/["\\]/g, "\\$&");

/** Parts that moved, grew or came new between two looks at the design, as the glow tells them. */
export function movedParts(before: Pick<DerivedPart, "id" | "nominal">[], after: Pick<DerivedPart, "id" | "nominal">[]): string[] {
  const sig = (p: Pick<DerivedPart, "nominal">) => [...p.nominal.min, ...p.nominal.max].map((v) => Math.round(v * 10)).join(",");
  const was = new Map(before.map((p) => [p.id, sig(p)]));
  return after.filter((p) => was.get(p.id) !== sig(p)).map((p) => p.id);
}

/**
 * What changed in the design's finishes, grouped by the finish each
 * target now takes. A target that lost its finish groups under null. The
 * finish that was put on comes first.
 */
export function finishChanges(before: Record<string, string> | undefined, after: Record<string, string> | undefined): FinishSeen[] {
  const a = before ?? {};
  const b = after ?? {};
  const groups = new Map<string | null, string[]>();
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (a[key] === b[key]) continue;
    const to = b[key] ?? null;
    groups.set(to, [...(groups.get(to) ?? []), key]);
  }
  return [...groups].map(([finish, targets]) => ({ finish, targets })).sort((x, y) => Number(x.finish === null) - Number(y.finish === null));
}
