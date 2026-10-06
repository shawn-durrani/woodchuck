// The tools Claude uses. Edit tools wrap one design operation each, and
// apply_edits runs a list of those same operations in order; the rest read
// the design, draw it, plan, ask, or request a tool that doesn't exist yet.
// None of them runs arbitrary code. test/agent.test.ts pins this list.

import type Anthropic from "@anthropic-ai/sdk";
import { recallChat } from "./recall.js";
import type { RenderOptions } from "./render.js";
import type { ChatItem } from "./store.js";
import {
  canStop,
  cutList,
  derive,
  describeJoints,
  JOINT_TYPES,
  LibraryError,
  PART_KINDS,
  explain,
  explainPart,
  FACES,
  exprInput,
  fieldExample,
  measure,
  shapeSig,
  OpError,
  applyOps,
  diffDesigns,
  JOINT_LIBRARY,
  PALETTES,
  QueryError,
  runChecks,
  SPECIES_IDS,
  summarisePart,
  verifyPlan,
  checkKeySizes,
  fmt,
  VIEW_NAMES,
  type CheckReport,
  type DeriveResult,
  type DerivedPart,
  type Design,
  type Op,
  type JointType,
  type KeySizeCheck,
  type LibraryPart,
  type Plan,
  type ViewName,
} from "@woodchuck/core";

type Tool = Anthropic.Beta.BetaTool;
type Schema = Record<string, unknown>;

/** An expression. A plain number may come as a JSON number too. */
const expr = (description: string): Schema => ({ type: ["string", "number"], description });

const bound: Schema = {
  description: 'Where this end sits: {"at": expression} or {"face": "part.face", "offset": expression}',
  anyOf: [
    {
      type: "object",
      properties: { at: expr("An absolute position in mm, as an expression") },
      required: ["at"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        face: { type: "string", description: 'Another part\'s face on this axis, such as "left_side.right"' },
        offset: expr("Optional distance along the positive axis. Negative for a gap before the face"),
      },
      required: ["face"],
      additionalProperties: false,
    },
  ],
};

const axisSpec = (axis: string): Schema => ({
  type: "object",
  description: `How the part spans ${axis}. Exactly two of start, end and size; on the thickness axis exactly one of start or end`,
  properties: { start: bound, end: bound, size: expr("Size along this axis in mm") },
  additionalProperties: false,
});

const axisEnum: Schema = { type: "string", enum: ["x", "y", "z"] };

const panelProps: Record<string, Schema> = {
  id: { type: "string", description: "Lowercase id, such as left_side. Must be unique" },
  name: { type: "string", description: "Name on the cut list" },
  material: { type: "string", description: "A material id from define_material" },
  thickness_axis: { ...axisEnum, description: "The axis the material's thickness runs along" },
  grain_axis: { ...axisEnum, description: "The axis the grain runs along. Becomes the cut length" },
  x: axisSpec("x (left to right)"),
  y: axisSpec("y (floor upwards)"),
  z: axisSpec("z (back to front)"),
  tags: { type: "array", items: { type: "string" }, description: "Words for grouping, such as carcass or drawer. Plans count parts by tag. wall_mounted counts as supported. runner marks a strip or shelf a drawer slides on, and the checks hold that drawer to running clearance" },
  decor: { type: "boolean", description: "A prop for presentation, left off the cut list" },
  note: { type: "string" },
};

/** A bound with words of its own, for a cut's points. */
const at = (description: string): Schema => ({ ...bound, description: `${description}: {"at": expression} or {"face": "part.face", "offset": expression}. The part's own faces work too` });

/** A cutout's span on one of the panel's face axes. */
const cutSpan = (axis: string): Schema => ({
  type: "object",
  description: `A rect's span on ${axis}, like a part's own: exactly two of start, end and size. Give only the panel's two face axes, never its thickness axis`,
  properties: { start: bound, end: bound, size: expr("Size along this axis in mm") },
  additionalProperties: false,
});

/** Which panel and which of its cuts, for the three cut tools. */
const cutIds: Record<string, Schema> = {
  id: { type: "string", description: "The panel to cut. Name the original part: an array's copies repeat its cuts" },
  cut: { type: "string", description: "Lowercase id for the cut, such as slope or cable_hole. Unique on its panel; the same id again replaces that cut" },
};

const EDGE_CUT_HELP =
  `Slope, taper or chamfer an edge of a panel: cut it straight from one point to another, and the wood on the edge's side of that line comes off. ` +
  `edge is the side it takes wood from, such as top. start and end are where the new edge sits on that edge's axis at the two ends of the run, and the run is the panel's other face axis, from its left, bottom or back end to its right, top or front end. ` +
  `The two points sit at the panel's own ends unless start_along or end_along moves them along the run, and the line runs on past them, so two points near a corner cut that corner off. ` +
  `Example, a drawer side whose top slopes from the back's top at the back to the front's top at the front: {"id": "side_l", "cut": "slope", "edge": "top", "start": {"face": "back.top"}, "end": {"face": "front.top"}}. ` +
  `There the side's thickness runs along x, so the run is z and start is at the back, and the slope follows the back and the front when they change. ` +
  `Example, a 30 mm chamfer off the same side's top front corner: {"id": "side_l", "cut": "corner", "edge": "top", "start": {"face": "side_l.top"}, "start_along": {"face": "side_l.front", "offset": "-30"}, "end": {"face": "side_l.top", "offset": "-30"}}. ` +
  `The box stays the blank you cut from: sizes, and faces such as side_l.top, still mean the blank, so side_l.top is the slope's highest point. ` +
  `Joints sit on uncut wood, so keep the edges a joint uses square. To check clearance under a rail, use gap_y(rail, side_l) in a rule, which measures to the slope itself. ` +
  `A cut on an array's original repeats on every copy. The cut list, the drawings and every picture show the shape.`;

const CUTOUT_HELP =
  `Cut a hole, a slot or a notch right through a panel. A circle takes centre and diameter. ` +
  `A rect takes a span on each of the panel's two face axes, like a part's own axis, and an optional corner radius; a slot is a rect whose radius is half its shorter side. ` +
  `A rect that reaches the panel's outline makes a notch, such as a toe kick out of a side's bottom front corner. Positions can use the part's own faces. ` +
  `Example, a 35 mm cable hole in a back whose thickness runs along z: {"id": "back", "cut": "cable", "shape": "circle", "centre": {"x": {"at": "300"}, "y": {"face": "back.top", "offset": "-80"}}, "diameter": "35"}. ` +
  `Example, a toe kick in a side whose thickness runs along x: {"id": "side_l", "cut": "kick", "shape": "rect", "y": {"start": {"face": "side_l.bottom"}, "size": "kick_height"}, "z": {"end": {"face": "side_l.front"}, "size": "kick_depth"}}. ` +
  `The box stays the blank you cut from, and joints need uncut wood where their parts meet. A cut on an array's original repeats on every copy.`;

function obj(properties: Record<string, Schema>, required: string[]): Anthropic.Beta.BetaTool.InputSchema {
  return { type: "object", properties, required, additionalProperties: false } as Anthropic.Beta.BetaTool.InputSchema;
}

/** One edit in a list, as a refusal of the wrong shape quotes it. */
const EDIT_EXAMPLE = '{"op": "set_param", "name": "shelf_depth", "expr": "320", "unit": "mm"}';

/** A list of edits, as preview_change and apply_edits take it. */
const editList = (description: string): Schema => ({
  type: "array",
  description: `${description} Each is an edit tool's name as "op" plus that tool's input, with the same fields and types as a call of that tool, for example ${EDIT_EXAMPLE}`,
  items: { type: "object", properties: { op: { type: "string" } }, required: ["op"] },
});

/** The most edits one apply_edits call takes. A stage of a build fits well inside it. */
export const MAX_EDITS = 40;

const FINISH_HELP =
  `Put a finish on a material, whole parts or single faces. A face beats its part, and a part beats its material; anything unfinished is bare timber ("raw"). ` +
  `A colour on a material or a whole part replaces colours already set inside it, so set the broad colour first, then any exceptions. ` +
  `Name a finish as palette/colour, or just the colour's name or number. Set each material's species with define_material so the finished view shows the right timber. ` +
  PALETTES.map(
    (p) =>
      `${p.maker} ${p.name} (${p.id}): ${p.source.toLowerCase()}; elsewhere the app estimates, so suggest a sample first. Colours (number id${p.photographed_on ? " #colour" : ""}): ` +
      p.colours.map((c) => `${c.number ?? "-"} ${c.id}${p.photographed_on && c.swatch ? ` ${c.swatch}` : ""}${c.note ? ` (${c.note.toLowerCase()})` : ""}`).join(", ") +
      ".",
  ).join(" ");

export const TOOLS: Tool[] = [
  {
    name: "get_design",
    description: "Read the whole design: parameters with their values, materials, parts, joints, arrays, hardware, rules and the plan, plus a count of open problems. Call this before editing a design you haven't seen this turn.",
    input_schema: obj({}, []),
  },
  {
    name: "set_param",
    description: "Create or change a named parameter. A plain number shows up as a slider for the woodworker; give min, max and step for a useful range. An expression makes a derived value. Use parameters for every dimension the woodworker might want to change.",
    input_schema: obj(
      {
        name: { type: "string" },
        expr: expr("A number or expression"),
        unit: { type: "string", enum: ["mm", "count", "kg", "deg", "none"] },
        min: { type: "number" },
        max: { type: "number" },
        step: { type: "number" },
        note: { type: "string", description: "What it's for, in a few words" },
      },
      ["name", "expr"],
    ),
  },
  {
    name: "delete_param",
    description: "Delete a parameter nothing uses any more.",
    input_schema: obj({ name: { type: "string" } }, ["name"]),
  },
  {
    name: "define_material",
    description: "Create or change a material. thickness_mm is the measured thickness every part in it will have. Give stock sizes so the checks can tell when a part won't fit: sheet_sizes_mm as a list of [length along the grain, width] pairs for sheet goods, such as [[2440, 1220]], or the longest and widest board for solid timber.",
    input_schema: obj(
      {
        id: { type: "string" },
        name: { type: "string" },
        kind: { type: "string", enum: ["sheet", "solid"] },
        thickness_mm: { type: "number" },
        nominal_thickness_mm: { type: "number", description: "What the supplier calls it, when that differs" },
        grained: { type: "boolean", description: "True when grain direction matters for cutting" },
        sheet_sizes_mm: { type: "array", items: { type: "array", items: { type: "number" } }, description: "A list of pairs, such as [[2440, 1220]]" },
        board_max_length_mm: { type: "number" },
        board_max_width_mm: { type: "number" },
        species: { type: "string", enum: [...SPECIES_IDS], description: "The timber, so the finished view shows its grain and colour. Kept when you leave it out" },
        note: { type: "string" },
      },
      ["id", "name", "kind", "thickness_mm", "grained"],
    ),
  },
  {
    name: "set_finish",
    description: FINISH_HELP,
    input_schema: obj(
      {
        targets: {
          type: "array",
          items: { type: "string" },
          description: 'What to finish: "material:<id>", "<part>" or "<part>.<face>". An array original such as "shelf" covers all its copies; "shelf#2" is one copy and "shelf#1" the original alone',
        },
        finish: {
          type: ["string", "null"],
          description: 'A colour name or number such as "amsterdam" or "13", "natur" for clear oil, "raw" for bare timber, or null to clear the targets so they fall back',
        },
      },
      ["targets", "finish"],
    ),
  },
  {
    name: "delete_material",
    description: "Delete a material no part uses any more.",
    input_schema: obj({ id: { type: "string" } }, ["id"]),
  },
  {
    name: "clear_design",
    description: "Remove everything from the open design in one step, to start a new piece. Use it instead of deleting parts one by one. It's a single change the woodworker can undo.",
    input_schema: obj({}, []),
  },
  {
    name: "add_panel",
    description:
      "Add a part as the box of its blank: a panel, board, shelf, side, drawer part and so on. Position it against other parts' faces where you can, so it follows them when they change. " +
      "To shape it, such as a sloped edge, a hole or a notch, add cuts with set_edge_cut and set_cutout once it's there.",
    input_schema: obj(panelProps, ["id", "name", "material", "thickness_axis", "grain_axis", "x", "y", "z"]),
  },
  {
    name: "update_panel",
    description: "Change an existing part's blank. Give only the fields to change; an axis you give replaces that axis's whole spec. Its cuts stay, and follow the faces they name.",
    input_schema: obj(panelProps, ["id"]),
  },
  {
    name: "delete_part",
    description: "Delete a part. Its joints go with it. Fails while other parts or expressions still refer to it.",
    input_schema: obj({ id: { type: "string" } }, ["id"]),
  },
  {
    name: "set_edge_cut",
    description: EDGE_CUT_HELP,
    input_schema: obj(
      {
        ...cutIds,
        edge: { type: "string", enum: [...FACES], description: "The edge the cut takes wood from. One of the panel's four edges, never a broad face on its thickness axis" },
        start: at("Where the new edge sits on the edge's axis at the start of the run, the panel's left, bottom or back end"),
        end: at("Where the new edge sits on the edge's axis at the end of the run, the panel's right, top or front end"),
        start_along: at("Optional: where along the run the line's start point sits, when it isn't the panel's own start"),
        end_along: at("Optional: where along the run the line's end point sits, when it isn't the panel's own end"),
        note: { type: "string", description: "Why this cut, in a few words" },
      },
      ["id", "cut", "edge", "start", "end"],
    ),
  },
  {
    name: "set_cutout",
    description: CUTOUT_HELP,
    input_schema: obj(
      {
        ...cutIds,
        shape: { type: "string", enum: ["rect", "circle"] },
        x: cutSpan("x (left to right)"),
        y: cutSpan("y (floor upwards)"),
        z: cutSpan("z (back to front)"),
        radius: expr("A rect's corner radius in mm. Half its shorter side makes a slot with round ends"),
        centre: {
          type: "object",
          description: "A circle's centre, on the panel's two face axes",
          properties: { x: at("The centre on x"), y: at("The centre on y"), z: at("The centre on z") },
          additionalProperties: false,
        },
        diameter: expr("A circle's diameter in mm"),
        note: { type: "string", description: "What it's for, in a few words" },
      },
      ["id", "cut", "shape"],
    ),
  },
  {
    name: "delete_cut",
    description: "Take a cut off a panel, so its blank is whole there again. get_design lists each panel's cuts by id.",
    input_schema: obj(cutIds, ["id", "cut"]),
  },
  {
    name: "add_joint",
    description:
      "Join two parts with a joint from the library (call list_joints to see them, with when each suits). Housings and insets need the guest against a face of the host and lengthen it. Interlocks (half_lap, box_joint) need the parts overlapping where they join. Fasteners change no sizes. Leave sizes out to get the library's usual proportions. A joint on an array's original repeats on every copy. To join one copy alone, name it as host or guest, such as shelf#2, or shelf#1 for the original alone. A drawer divider housed into the underside of the second shelf only is a dado with host shelf#2 and guest divider. The array's own joints, such as the shelves' dados into the sides, still repeat on shelf#2, and the cut list gives it a row of its own. " +
      "A drawer bottom is the guest of one groove in each part round it, so it grows into each. At a drawer's corners, each side is the guest of a rabbet in the front and in the back, or the front and back are guests of a dado_rabbet in each side. " +
      "A dado, groove, rabbet or dado_rabbet can stop short of an edge with stop, so its end doesn't show on a visible edge; use it when the woodworker asks for a stopped housing or cares how that edge looks. " +
      'Example, a shelf in a dado that stops 10 mm short of the side\'s front: {"id": "shelf_l", "type": "dado", "host": "side_l", "guest": "shelf", "stop": {"front": "10"}}. ' +
      "The shelf keeps its place and size, and its front corner is notched 10 mm to match, so its front stays flush with the side's.",
    input_schema: obj(
      {
        id: { type: "string" },
        type: {
          type: "string",
          enum: [...JOINT_TYPES],
          description:
            "domino is Festool's loose tenon: bought beech tenons in mortises cut in both parts, which go on the hardware list. Use it only when the woodworker's workshop lists a Domino joiner, and dowels when it doesn't",
        },
        host: { type: "string", description: "The part that gets cut into. An array copy such as shelf#2 is that copy alone" },
        guest: { type: "string", description: "The part that sits in or against the host. An array copy such as shelf#2 is that copy alone" },
        depth: expr("How far the guest, tongue or tenon goes into the host. For a Domino, how deep its mortise in the host goes, and the guest's takes the rest"),
        fit: expr("Extra housing width for an easy fit. For a Domino, the joiner's width setting: 0 cuts the host's mortises tight, and 6 or 10 leaves play along the joint in all but the one nearest the front, top or right, which lines the parts up"),
        thickness: expr("Tongue, tenon or Domino thickness. A Domino's is its cutter: 4, 5, 6, 8 or 10"),
        shoulder: expr("How far a tenon is set in from each edge of the rail"),
        count: { type: "integer", description: "Number of screws, pocket screws, dowels or Dominos" },
        diameter: expr("Screw or dowel diameter"),
        length: expr("Screw, dowel or Domino length. Dominos are 4 × 20, 5 × 30, 6 × 40, 8 × 40, 8 × 50 and 10 × 50 mm, thickness by length. Leave a Domino's size out to get one that suits the stock"),
        finger: expr("Box joint finger width"),
        width: expr("A groove's width, when the cutter sets it, such as 6. Leave it out to cut the groove to the panel's thickness plus fit"),
        stop: {
          type: "object",
          description:
            "Dado, groove, rabbet or dado_rabbet only: each edge of the host it stops short of, with how far in mm. The edges are the two it runs between, such as back and front; give one or both",
          properties: Object.fromEntries(FACES.map((f) => [f, expr(`How far short of the host's ${f} edge it stops`)])),
          additionalProperties: false,
        },
        note: { type: "string", description: "Why this joint, in a few words" },
      },
      ["id", "type", "host", "guest"],
    ),
  },
  {
    name: "delete_joint",
    description: "Delete a joint.",
    input_schema: obj({ id: { type: "string" } }, ["id"]),
  },
  {
    name: "set_array",
    description: "Create or change an array that repeats parts along an axis. Copies are named part#2, part#3 and so on. Use it for evenly spaced partitions, shelves, drawers and their parts. A part can be in one array. A joint on one copy, such as shelf#2, follows the copy's number, so a new count or pitch keeps it on shelf#2. A count that drops below its number leaves the joint with nothing to join, and the checks name it as an error until you delete it or add it again.",
    input_schema: obj(
      {
        id: { type: "string" },
        parts: { type: "array", items: { type: "string" } },
        axis: axisEnum,
        count: expr("How many in total, including the original"),
        pitch: expr("Distance from one item to the next, in mm"),
      },
      ["id", "parts", "axis", "count", "pitch"],
    ),
  },
  {
    name: "delete_array",
    description: "Delete an array. Its copies disappear; the original parts stay. A joint on one of its copies, such as shelf#2, is then an error until you delete it.",
    input_schema: obj({ id: { type: "string" } }, ["id"]),
  },
  {
    name: "set_hardware",
    description:
      "Create or change hardware such as drawer slides, hinges, handles or legs. connects lists the parts it joins, which counts as support. For a real part, give library_part (see list_library_parts): its specs and model come from the library. Give place to put the model in the design, and the overlap check will tell you if it doesn't fit its gap. " +
      "Hardware is only what you buy, so it needs library_part or the maker's figures in spec. Wooden runners and glides are timber: add them with add_panel, tagged runner.",
    input_schema: obj(
      {
        id: { type: "string" },
        kind: { type: "string" },
        name: { type: "string" },
        connects: { type: "array", items: { type: "string" } },
        qty: { type: "number" },
        spec: { type: "object", additionalProperties: { type: ["number", "string"] }, description: "Figures from the maker, such as clearance_per_side_mm or load_kg. A library part fills these in" },
        library_part: { type: "string", description: "An approved part's id from the library" },
        on_floor: { type: "boolean", description: "Castors, levellers or feet: the parts it connects count as standing on the floor" },
        place: {
          type: "object",
          description: "Where the model's corner sits (expressions in mm) and the world axis its length runs along",
          properties: { x: expr("x of the corner"), y: expr("y of the corner"), z: expr("z of the corner"), length_axis: axisEnum },
          required: ["x", "y", "z"],
          additionalProperties: false,
        },
        note: { type: "string" },
      },
      ["id", "connects"],
    ),
  },
  {
    name: "delete_hardware",
    description: "Delete hardware.",
    input_schema: obj({ id: { type: "string" } }, ["id"]),
  },
  {
    name: "set_rule",
    description:
      "Create or change a rule: a true/false expression the design must keep meeting, with a message for when it doesn't. Use one for every requirement the woodworker states, and one for each direction it limits. " +
      'LPs need lp_clear across a drawer, "drawer_side_r.left - drawer_side_l.right >= lp_clear", and standing up in it, "top.bottom - drawer_bottom.top >= lp_clear". ' +
      'An overall size is the whole piece: overall.width, overall.height and overall.depth are the box around every part, back, feet and top included, such as "overall.depth == 300", and overall.top and the other faces are its edges. ' +
      "Props and hardware aren't in it, so for a piece on bought legs, overall.top is its height from the floor.",
    input_schema: obj(
      {
        id: { type: "string" },
        expr: expr("A true/false expression"),
        severity: { type: "string", enum: ["error", "warning"] },
        message: { type: "string" },
      },
      ["id", "expr", "message"],
    ),
  },
  {
    name: "delete_rule",
    description: "Delete a rule.",
    input_schema: obj({ id: { type: "string" } }, ["id"]),
  },
  {
    name: "add_unverified_box",
    description: "Stopgap only. Adds a plain box at fixed coordinates when no tool can express a part yet. It shows striped orange, stays off the cut list and blocks cutting until it's replaced. Call request_tool first and pass its id.",
    input_schema: obj(
      {
        id: { type: "string" },
        name: { type: "string" },
        min_mm: { type: "array", items: { type: "number" }, description: "[x, y, z]" },
        max_mm: { type: "array", items: { type: "number" }, description: "[x, y, z]" },
        reason: { type: "string" },
        request_id: { type: "string" },
      },
      ["id", "name", "min_mm", "max_mm", "reason"],
    ),
  },
  {
    name: "rename_design",
    description: "Rename the design.",
    input_schema: obj({ name: { type: "string" } }, ["name"]),
  },
  {
    name: "apply_edits",
    description:
      `Make several edits in one call, in order, so a whole stage of a build is one step: every carcass panel, then the joints, then the finishes. ` +
      `A later edit can use a part an earlier one added. Up to ${MAX_EDITS} edits. Every edit is checked for an edit tool's name and that tool's fields before any runs. ` +
      `If one is refused, the ones before it stay made and the rest don't run; the result names the edit that failed and why, so send that one fixed with the rest. ` +
      `The result sums up the whole list once: parts added and moved, and the problems it made or fixed.`,
    input_schema: obj({ edits: editList(`The edits, in order, at most ${MAX_EDITS}.`) }, ["edits"]),
  },
  {
    name: "get_part",
    description: "Describe one part: finished and cut sizes, position, how each size is worked out, and its machining.",
    input_schema: obj({ id: { type: "string" } }, ["id"]),
  },
  {
    name: "explain",
    description: "Show the working for a parameter, a rule, a part, or any expression such as \"right_side.left - left_side.right\".",
    input_schema: obj({ target: { type: "string" } }, ["target"]),
  },
  {
    name: "measure",
    description: "Distance between two faces on the same axis, such as from left_side.right to partition.left.",
    input_schema: obj({ from: { type: "string" }, to: { type: "string" } }, ["from", "to"]),
  },
  {
    name: "check_design",
    description: "Run every check: overlaps, support, housing depths, stock sizes, the design's rules and unverified parts, with the working for each problem. Each edit's result already lists the problems it made and fixed, so call this once a build or a big change is done, or for the detail of an error.",
    input_schema: obj({}, []),
  },
  {
    name: "get_cut_list",
    description: "The cut list: identical parts grouped, with cut sizes that include joinery, plus the hardware list.",
    input_schema: obj({}, []),
  },
  {
    name: "list_library_parts",
    description: "Real parts already approved for the library, with their specs, sources and models. Check here before researching a part.",
    input_schema: obj({ kind: { type: "string", enum: [...PART_KINDS] } }, []),
  },
  {
    name: "propose_library_part",
    description:
      "Propose a real part for the library after researching it, then end your turn and wait for the woodworker to approve it. Every number must come from a source you read: the maker's page, a spec sheet they attached, or a page they linked. List those sources. The model is a few boxes in the part's own frame: x along its length, y up, z across, in mm.",
    input_schema: obj(
      {
        id: { type: "string", description: "maker-model-size in lowercase with dashes, such as acmeco-glide-450" },
        name: { type: "string" },
        kind: { type: "string", enum: [...PART_KINDS] },
        maker: { type: "string" },
        model: { type: "string" },
        sku: { type: "string" },
        sources: {
          type: "array",
          items: {
            type: "object",
            properties: { url: { type: "string" }, title: { type: "string" }, note: { type: "string" } },
            additionalProperties: false,
          },
        },
        specs: { type: "object", additionalProperties: { type: ["number", "string"] }, description: "Fitting figures with units in the names: length_mm, clearance_per_side_mm, load_kg, min_cabinet_depth_mm" },
        shape: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              min_mm: { type: "array", items: { type: "number" } },
              max_mm: { type: "array", items: { type: "number" } },
            },
            required: ["name", "min_mm", "max_mm"],
            additionalProperties: false,
          },
        },
        mounting: { type: "string", description: "How it's fitted, in plain words" },
        notes: { type: "string" },
      },
      ["id", "name", "kind", "sources", "specs", "shape"],
    ),
  },
  {
    name: "recall_chat",
    description:
      "Search everything said and done in this design's chat, including turns that were summarised to keep the chat quick. Use it when the woodworker refers back to something (\"remember at the start\", \"what did we decide about the drawer runners\") and the detail isn't in front of you, and say what you found. Give a few words to look for, or from start to read the opening of the chat. Lines come back oldest first, with their place in the chat and when they happened. The design itself is always current: read sizes from get_design, not from old chat.",
    input_schema: obj(
      {
        query: { type: "string", description: "A few words to look for, such as runners oak depth" },
        from: { type: "string", enum: ["start", "end"], description: "Without a query, read the first or last lines of the chat" },
        limit: { type: "integer", description: "Most lines to return, up to 40. Default 12" },
      },
      [],
    ),
  },
  {
    name: "list_joints",
    description: "The joint library: every joint a standard home workshop can cut, with what it is, when it suits, when to avoid it, its strength, the tools, how it changes sizes and its parameters with their usual values. Read it before choosing joints for a plan.",
    input_schema: obj({}, []),
  },
  {
    name: "render_views",
    description:
      "Draw the design from fixed cameras and look at it. Part ids are written on the parts. Use it once a build or a big change is done, to catch gross mistakes; a size tweak doesn't need it. Trust the numbers for exact sizes. " +
      "The plain look, the default, is for geometry, ids and sizes. The finished look draws each face in its timber with its finish, as flat colours: use it to check colours or finishes before you tell the woodworker they're on. Its colours are estimates, like the app's.",
    input_schema: obj(
      {
        views: { type: "array", items: { type: "string", enum: [...VIEW_NAMES] }, description: "Default: front, top, left, iso" },
        look: { type: "string", enum: ["plain", "finished"], description: "Default: plain" },
        highlight: { type: "array", items: { type: "string" }, description: "Parts to outline" },
        isolate: { type: "array", items: { type: "string" }, description: "Draw only these parts (an original part includes its array copies)" },
        see_through: { type: "boolean", description: "Draw parts faint and show joints: tongues and tenons, cut-outs in red, screws and dowels as rods. Isolate a few parts to keep it readable" },
      },
      [],
    ),
  },
  {
    name: "submit_plan",
    description: "Pin the plan beside the draft you've just built, then end your turn and wait. The app shows it with drawings of the model. The woodworker says it looks right or asks for changes, and their reply arrives as this tool's result. Give each parts line its own tag, and put that tag on exactly the parts the line counts; verify_against_plan counts parts by tag. Each key size is worked out on the model first, and the card shows the model's number. If one doesn't match its expected_mm or can't be worked out, the plan is refused and nothing is pinned.",
    input_schema: obj(
      {
        summary: { type: "string", description: "One or two sentences on what you've drafted" },
        parts: {
          type: "array",
          items: {
            type: "object",
            properties: { label: { type: "string" }, qty: { type: "integer" }, tag: { type: "string" } },
            required: ["label", "qty", "tag"],
            additionalProperties: false,
          },
        },
        key_dims: {
          type: "array",
          items: {
            type: "object",
            properties: {
              label: { type: "string", description: "What the expression measures, such as the clear gap between two shelves or the pitch from one to the next" },
              expr: { type: "string", description: "Expression that measures it in the model" },
              expected_mm: { type: "number", description: "The size you mean. The model must give it, within tolerance_mm" },
              tolerance_mm: { type: "number", description: "Default 0.5" },
            },
            required: ["label", "expr", "expected_mm"],
            additionalProperties: false,
          },
        },
        joints: { type: "array", items: { type: "string" }, description: "Each joint and why you chose it" },
        assumptions: { type: "array", items: { type: "string" } },
      },
      ["summary", "parts", "key_dims", "joints", "assumptions"],
    ),
  },
  {
    name: "verify_against_plan",
    description: "Compare the model with the approved plan: part counts by tag and key dimensions.",
    input_schema: obj({}, []),
  },
  {
    name: "preview_change",
    description:
      "Show the woodworker a change before making it. It's drawn on the model itself as a ghost, with the changed parts outlined and each move dimensioned, and the waiting bar lists what it changes, adds or fixes. Then end your turn: they click Apply, which makes it one undoable change, or Not now. Use it for a suggestion they haven't asked for, a big or hard-to-undo change, or when they ask to see something first. Small, clear edits they asked for don't need it.",
    input_schema: obj(
      {
        title: { type: "string", description: "A few words, such as Deeper shelves" },
        explanation: { type: "string", description: "One or two plain sentences on what it does and why" },
        ops: editList("The edits, in order."),
      },
      ["title", "explanation", "ops"],
    ),
  },
  {
    name: "show_joint",
    description:
      "Slide out a worked example of a joint from the library beside the model: two sample boards joined with it, in see-through view, with what it is, when it suits and what it takes to cut. Use it whenever you suggest a joint the woodworker may not know, or they ask what one is. A dado, groove, rabbet or dado_rabbet can be shown stopped 10 mm short of an edge, with the guest's corner notched. It doesn't change the design or end your turn.",
    input_schema: obj(
      {
        type: { type: "string", enum: [...JOINT_TYPES] },
        stopped: { type: "boolean", description: "Show it stopping 10 mm short of an edge. Dado, groove, rabbet or dado_rabbet only" },
        note: { type: "string", description: "Optional: one sentence on why you're showing it" },
      },
      ["type"],
    ),
  },
  {
    name: "ask_user",
    description: "Ask the woodworker one question, then end your turn and wait. Only ask when the answer changes what you'd build now; otherwise assume and say so. Offer short options when you can.",
    input_schema: obj(
      {
        question: { type: "string" },
        options: { type: "array", items: { type: "string" } },
      },
      ["question"],
    ),
  },
  {
    name: "request_tool",
    description: "Ask for a new tool when the existing ones can't express something. Describe what you were trying to do with the real example from this design, the tool's inputs, exactly what it would change, how to check it, and any stopgap you used. The woodworker reviews requests and has the tools built.",
    input_schema: obj(
      {
        name: { type: "string", description: "Proposed tool name, such as add_finger_pull" },
        purpose: { type: "string" },
        example: { type: "string" },
        inputs: { type: "string" },
        effect: { type: "string", description: "What it changes, including any cut sizes" },
        check: { type: "string", description: "How to check its result" },
        stopgap: { type: "string" },
      },
      ["name", "purpose", "example", "inputs", "effect", "check"],
    ),
  },
];

export const EDIT_TOOLS = new Set([
  "clear_design",
  "delete_material",
  "set_param",
  "delete_param",
  "define_material",
  "add_panel",
  "update_panel",
  "delete_part",
  "set_edge_cut",
  "set_cutout",
  "delete_cut",
  "add_joint",
  "delete_joint",
  "set_array",
  "delete_array",
  "set_hardware",
  "delete_hardware",
  "set_rule",
  "delete_rule",
  "add_unverified_box",
  "rename_design",
  "set_finish",
]);

export const TERMINAL_TOOLS = new Set(["submit_plan", "ask_user", "preview_change"]);

export interface ToolRequest {
  name: string;
  purpose: string;
  example: string;
  inputs: string;
  effect: string;
  check: string;
  stopgap?: string;
}

export interface LibraryAccess {
  list(): LibraryPart[];
  get(id: string): LibraryPart | undefined;
  propose(input: unknown): { id: string; part: LibraryPart };
}

export interface ToolContext {
  library: LibraryAccess;
  design(): Design;
  /** Applies one operation as Claude. Throws OpError when it's refused. */
  apply(op: Op): Design;
  requestTool(req: ToolRequest): { id: string; count: number };
  renderPng(views: ViewName[], opts: RenderOptions): Buffer;
  /** The design's whole chat, as saved, for recall_chat. */
  chat?(): ChatItem[];
}

export type ToolContent = string | Anthropic.Beta.BetaToolResultBlockParam["content"];

export interface ToolOutcome {
  content: ToolContent;
  isError?: boolean;
  /** Set when a tool request was logged, so the chat can show its card. */
  requestId?: string;
  /** Set for tools that end the turn until the woodworker replies. */
  waitFor?:
    | { kind: "question"; question: string; options: string[] }
    | { kind: "plan" }
    | { kind: "part"; proposal: string; part: LibraryPart }
    | { kind: "preview"; title: string; explanation: string; ops: Op[] };
  /** Set when Claude opened a worked joint example, so the chat can show its card. */
  example?: { joint: JointType; note?: string; stopped?: true };
  /** A short line for the chat when a failed result is too long to show whole. */
  chatLine?: string;
}

const json = (v: unknown) => JSON.stringify(v, null, 1);

function compactIssues(report: CheckReport, limit = 12) {
  return report.issues.slice(0, limit).map((i) => ({ severity: i.severity, message: i.message, ...(i.trace ? { working: i.trace } : {}) }));
}

/** What an edit changed, in the measurements Claude needs to check it. */
export function changeSummary(before: DeriveResult, beforeReport: CheckReport, after: DeriveResult, afterReport: CheckReport) {
  // A part changes when its box moves or its cuts leave another shape, even with the box where it was.
  const sig = (p: DerivedPart) => [...p.box.min, ...p.box.max].map((v) => Math.round(v * 100)).join(",") + (p.profile ? `|${shapeSig(p)}` : "");
  const beforeSig = new Map(before.parts.map((p) => [p.id, sig(p)]));
  const beforeShape = new Map(before.parts.map((p) => [p.id, shapeSig(p)]));
  const afterIds = new Set(after.parts.map((p) => p.id));
  const added: string[] = [];
  const moved: DerivedPart[] = [];
  for (const p of after.parts) {
    const old = beforeSig.get(p.id);
    if (old === undefined) added.push(p.id);
    if (old !== sig(p)) moved.push(p);
  }
  // A shaped part's cuts in workshop words, with each cut's id: its end heights and angle, or a hole's size and place.
  const shape = (p: DerivedPart) => {
    if (p.profile) return { shape: p.profile.cuts.map((c) => `${c.id}: ${c.text}`) };
    const was = beforeShape.get(p.id);
    return was ? { shape: ["no cuts: the whole blank"] } : {};
  };
  const removed = before.parts.filter((p) => !afterIds.has(p.id)).map((p) => p.id);
  const oldKeys = new Set(beforeReport.issues.map((i) => i.key));
  const newKeys = new Set(afterReport.issues.map((i) => i.key));
  return {
    ok: true,
    added,
    removed,
    sizes: moved.slice(0, 20).map((p) => {
      const s = summarisePart(p);
      return { id: s.id, cut_mm: s.cut_mm, from_mm: s.position_mm.min, to_mm: s.position_mm.max, ...shape(p) };
    }),
    ...(moved.length > 20 ? { more_changed: moved.length - 20 } : {}),
    problems: {
      errors: afterReport.errors,
      warnings: afterReport.warnings,
      new: afterReport.issues.filter((i) => !oldKeys.has(i.key)).slice(0, 8).map((i) => i.message),
      fixed: beforeReport.issues.filter((i) => !newKeys.has(i.key)).slice(0, 8).map((i) => i.message),
    },
  };
}

/**
 * What a change made outside Claude did, for the app that asked for it: the
 * parts that moved, as Claude's edits report them, and each parameter whose
 * formula or value moved. A value is null where it can't be worked out.
 * Every problem the change made comes back with its severity, since the app
 * that asked has to say each one to the woodworker.
 */
export function editSummary(beforeDesign: Design, afterDesign: Design) {
  const before = derive(beforeDesign);
  const after = derive(afterDesign);
  const beforeReport = runChecks(beforeDesign, before);
  const afterReport = runChecks(afterDesign, after);
  const { ok: _ok, problems: _problems, ...changed } = changeSummary(before, beforeReport, after, afterReport);
  const oldKeys = new Set(beforeReport.issues.map((i) => i.key));
  const newKeys = new Set(afterReport.issues.map((i) => i.key));
  const problems = {
    errors: afterReport.errors,
    warnings: afterReport.warnings,
    ready_to_cut: afterReport.ready_to_cut,
    new: afterReport.issues.filter((i) => !oldKeys.has(i.key)).map((i) => ({ severity: i.severity, message: i.message })),
    fixed: beforeReport.issues.filter((i) => !newKeys.has(i.key)).map((i) => i.message),
  };
  const valueOf = (d: DeriveResult, name: string) => {
    const v = d.params[name];
    return v && "value" in v ? Math.round(v.value * 100) / 100 : null;
  };
  const oldExpr = new Map(beforeDesign.params.map((p) => [p.name, p.expr]));
  const params = afterDesign.params.flatMap((p) => {
    const from = valueOf(before, p.name);
    const to = valueOf(after, p.name);
    if (oldExpr.get(p.name) === p.expr && from === to) return [];
    return [{ name: p.name, unit: p.unit, from_expr: oldExpr.get(p.name) ?? null, to_expr: p.expr, from_value: from, to_value: to }];
  });
  return { ...changed, params, problems };
}

export type EditSummary = ReturnType<typeof editSummary>;

/** A library part brings its own specs and model into set_hardware. */
function withLibraryPart(name: string, input: Record<string, unknown>, library: LibraryAccess): Record<string, unknown> {
  if (name !== "set_hardware" || !input.library_part) return input;
  const part = library.get(String(input.library_part));
  if (!part) {
    const ids = library.list().map((p) => p.id);
    throw new QueryError(`"${String(input.library_part)}" isn't in the library. ${ids.length ? `Parts: ${ids.join(", ")}` : "It's empty; propose the part first"}`);
  }
  return {
    ...input,
    kind: input.kind ?? part.kind,
    name: input.name ?? part.name,
    spec: { ...part.specs, ...((input.spec as Record<string, number | string>) ?? {}) },
    shape: part.shape,
  };
}

/** Each edit tool's input schema, so a listed edit is held to the same fields as a call of its own. */
const EDIT_SCHEMAS = new Map(TOOLS.filter((t) => EDIT_TOOLS.has(t.name)).map((t) => [t.name, t.input_schema]));

/**
 * The edits listed for preview_change or apply_edits, each checked before
 * any runs: an edit tool's name, only that tool's fields, and every field it
 * needs. A library part fills in set_hardware the same as a call of its own.
 */
export function parseEdits(raw: unknown, library: LibraryAccess, field: string, max = Infinity): Op[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new QueryError(`${field} must list at least one edit. Example: "${field}": [${EDIT_EXAMPLE}]`);
  if (raw.length > max) throw new QueryError(`${field} lists ${raw.length} edits, and the most is ${max}. Split it into stages, such as the panels, then the joints, then the finishes`);
  return raw.map((item: unknown, i) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) throw new QueryError(`Edit ${i + 1} must be an object with "op" and that tool's input. Example: ${EDIT_EXAMPLE}`);
    const { op: name, ...rest } = item as Record<string, unknown>;
    const op = String(name ?? "");
    const schema = EDIT_SCHEMAS.get(op);
    if (!schema) throw new QueryError(`Edit ${i + 1}: "${op}" isn't an edit tool. Use one of: ${[...EDIT_TOOLS].join(", ")}`);
    const fields = Object.keys(schema.properties ?? {});
    const unknown = Object.keys(rest).filter((k) => !fields.includes(k));
    if (unknown.length) throw new QueryError(`Edit ${i + 1} (${op}): ${unknown.join(", ")} ${unknown.length === 1 ? "isn't a field" : "aren't fields"} of ${op}. Its fields: ${fields.join(", ") || "none"}`);
    const missing = (schema.required ?? []).filter((k) => rest[k] === undefined);
    if (missing.length) {
      const example = missing.map(fieldExample).find((x) => x !== undefined);
      throw new QueryError(`Edit ${i + 1} (${op}) needs ${missing.join(", ")}${example ? `. Example: ${example}` : ""}`);
    }
    return { op, ...withLibraryPart(op, rest, library) } as Op;
  });
}

/** An edit in a few words, such as "add_panel left_side", or "set_edge_cut side_l slope" for a cut. */
function editName(op: Op): string {
  const o = op as Record<string, unknown>;
  const id = o.id ?? o.name ?? (Array.isArray(o.targets) ? o.targets.join(", ") : "");
  const cut = typeof o.cut === "string" && o.cut ? ` ${o.cut}` : "";
  return `${op.op}${id ? ` ${String(id)}` : ""}${cut}`;
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "edit 3", or "edits 3 to 7". */
const editRange = (from: number, to: number) => (from === to ? `edit ${from}` : `edits ${from} to ${to}`);

/**
 * Makes a list of edits in order, each through ctx.apply as one of Claude's
 * edits, so the turn's one undo and the live window work as they do for a
 * single call. It stops at the first edit that's refused. The edits before
 * it stay made, and the result says which one failed and why, so Claude can
 * send that one fixed with the rest. What the list changed comes back once,
 * as one change summary, rather than once an edit.
 */
function applyEdits(input: Record<string, unknown>, ctx: ToolContext, before: DeriveResult): ToolOutcome {
  const edits = parseEdits(input.edits, ctx.library, "edits", MAX_EDITS);
  const beforeReport = runChecks(ctx.design(), before);
  let made = 0;
  let failed: { edit: number; op: string; error: string } | null = null;
  // Edits the design already had as given. Each counts as made, so a list sent again runs on past them.
  const already: string[] = [];
  for (const op of edits) {
    try {
      const was = ctx.design();
      if (ctx.apply(op) === was) already.push(editName(op));
      made++;
    } catch (e) {
      failed = { edit: made + 1, op: editName(op), error: e instanceof Error ? e.message : String(e) };
      break;
    }
  }
  const design = ctx.design();
  const after = derive(design);
  const { ok: _ok, ...changed } = changeSummary(before, beforeReport, after, runChecks(design, after));
  const there = already.length ? { already_there: already } : {};
  // Plain JSON with no indents, since a stage's summary can be long.
  if (!failed) return { content: JSON.stringify({ ok: true, applied: made, ...there, ...changed }) };
  const total = edits.length;
  const notRun = total - failed.edit;
  const why = failed.error.replace(/\.$/, "");
  const lead = [
    `Edit ${failed.edit} of ${total} (${failed.op}) was refused: ${why}.`,
    made ? `${capital(editRange(1, made))} ${made === 1 ? "is" : "are"} made and stay in this turn's change.` : "Nothing was changed.",
    ...(notRun ? [`${capital(editRange(failed.edit + 1, total))} didn't run.`] : []),
    `Send edit ${failed.edit} fixed${notRun ? ", with the ones after it," : ""} in a new call.`,
  ].join(" ");
  return {
    content: `${lead}\n${JSON.stringify({ ok: false, applied: made, failed, not_run: notRun, ...there, ...(made ? changed : {}) })}`,
    isError: true,
    chatLine: `edit ${failed.edit} of ${total} (${failed.op}) failed: ${why}. ${made} made, ${notRun} not run`,
  };
}

export function runTool(name: string, input: Record<string, unknown>, ctx: ToolContext): ToolOutcome {
  try {
    input = withLibraryPart(name, input, ctx.library);
    if (EDIT_TOOLS.has(name)) {
      const was = ctx.design();
      const before = derive(was);
      const beforeReport = runChecks(was, before);
      const op = { op: name, ...input } as Op;
      const next = ctx.apply(op);
      if (next === was) return { content: json({ ok: true, unchanged: `${editName(op)} is already there as given, so nothing changed` }) };
      const after = derive(next);
      return { content: json(changeSummary(before, beforeReport, after, runChecks(next, after))) };
    }
    const design = ctx.design();
    const d = derive(design);
    switch (name) {
      case "apply_edits":
        return applyEdits(input, ctx, d);
      case "get_design": {
        const report = runChecks(design, d);
        const values = Object.fromEntries(
          Object.entries(d.params).map(([k, v]) => [k, "value" in v ? Math.round(v.value * 100) / 100 : `error: ${v.error}`]),
        );
        return {
          content: json({
            design,
            param_values: values,
            parts_including_copies: d.parts.length,
            problems: { errors: report.errors, warnings: report.warnings, ready_to_cut: report.ready_to_cut },
          }),
        };
      }
      case "list_library_parts": {
        const kind = input.kind ? String(input.kind) : undefined;
        const parts = ctx.library.list().filter((p) => !kind || p.kind === kind);
        return { content: parts.length ? json(parts) : `No ${kind ? `${kind} ` : ""}parts in the library yet.` };
      }
      case "propose_library_part": {
        const p = ctx.library.propose(input);
        return { content: `Proposed as ${p.id}.`, waitFor: { kind: "part", proposal: p.id, part: p.part } };
      }
      case "list_joints":
        return { content: json(describeJoints()) };
      case "recall_chat":
        return {
          content: recallChat(ctx.chat?.() ?? [], {
            ...(typeof input.query === "string" ? { query: input.query } : {}),
            ...(input.from === "start" || input.from === "end" ? { from: input.from } : {}),
            ...(typeof input.limit === "number" ? { limit: input.limit } : {}),
          }),
        };
      case "get_part": {
        const p = d.byId.get(String(input.id));
        if (!p) throw new QueryError(`There's no part "${String(input.id)}"`);
        return { content: json({ ...summarisePart(p), working: explainPart(d, p.id) }) };
      }
      case "explain":
        return { content: explain(design, d, String(input.target)).join("\n") };
      case "measure": {
        const m = measure(d, String(input.from), String(input.to));
        return { content: `${Math.round(m.mm * 100) / 100} mm (${m.text})` };
      }
      case "check_design": {
        const report = runChecks(design, d);
        return {
          content: json({
            ready_to_cut: report.ready_to_cut,
            errors: report.errors,
            warnings: report.warnings,
            problems: compactIssues(report, 40),
          }),
        };
      }
      case "get_cut_list": {
        const list = cutList(design, d);
        return { content: json(list) };
      }
      case "render_views": {
        const views = ((input.views as string[] | undefined)?.length ? input.views : ["front", "top", "left", "iso"]) as ViewName[];
        const bad = views.filter((v) => !(VIEW_NAMES as readonly string[]).includes(v));
        if (bad.length) throw new QueryError(`Unknown view ${bad.join(", ")}. Views: ${VIEW_NAMES.join(", ")}`);
        const look = input.look ?? "plain";
        if (look !== "plain" && look !== "finished") throw new QueryError(`Unknown look ${String(look)}. Looks: plain, finished`);
        const png = ctx.renderPng(views, {
          highlight: input.highlight as string[] | undefined,
          isolate: input.isolate as string[] | undefined,
          xray: input.see_through === true,
          look,
        });
        const finished = look === "finished" ? ", finished look. Each face shows its timber with its finish as one flat colour, an estimate like the app's" : "";
        return {
          content: [
            { type: "image", source: { type: "base64", media_type: "image/png", data: png.toString("base64") } },
            { type: "text", text: `Views: ${views.join(", ")}${finished}. Part ids are written on the parts. Overall sizes are marked on the flat views.` },
          ],
        };
      }
      case "submit_plan": {
        // Every key size is worked out on the model first, so the woodworker never approves a number the model doesn't give.
        if (input.key_dims !== undefined && !Array.isArray(input.key_dims)) throw new QueryError("key_dims must be a list of { label, expr, expected_mm }");
        // An expression reads the way an edit's does, so a number in quotes is the number.
        const dims = ((input.key_dims as Plan["key_dims"] | undefined) ?? []).map((dim) =>
          typeof dim === "object" && dim !== null ? { ...dim, expr: exprInput(dim.expr) ?? dim.expr } : dim,
        );
        const sizes = checkKeySizes(dims, d);
        if (sizes.some((k) => !k.ok)) return keySizeRefusal(sizes);
        const plan: Plan = {
          status: "proposed",
          summary: String(input.summary ?? ""),
          parts: (input.parts as Plan["parts"]) ?? [],
          key_dims: dims.map((dim, i) => ({ ...dim, model_mm: Math.round(sizes[i]!.model_mm! * 100) / 100 })),
          joints: (input.joints as string[]) ?? [],
          assumptions: (input.assumptions as string[]) ?? [],
        };
        ctx.apply({ op: "set_plan", plan });
        return { content: "Plan pinned beside the model.", waitFor: { kind: "plan" } };
      }
      case "verify_against_plan": {
        const checks = verifyPlan(design, d);
        return { content: json({ all_match: checks.every((c) => c.ok), checks }) };
      }
      case "preview_change": {
        const title = String(input.title ?? "").trim();
        const explanation = String(input.explanation ?? "").trim();
        if (!title || !explanation) throw new QueryError("preview_change needs a title and an explanation");
        const ops = parseEdits(input.ops, ctx.library, "ops");
        // Try it on a copy now, so a mistake comes back to you rather than the woodworker.
        const proposed = applyOps(design, ops);
        const changes = diffDesigns(design, proposed);
        if (!changes.length) throw new QueryError("Those edits don't change anything");
        const after = derive(proposed);
        const summary = changeSummary(d, runChecks(design, d), after, runChecks(proposed, after));
        return {
          content: json({ shown: "The preview is drawn on the model, waiting for Apply or Not now.", changes, problems: summary.problems }),
          waitFor: { kind: "preview", title, explanation, ops },
        };
      }
      case "show_joint": {
        const type = String(input.type) as JointType;
        if (!JOINT_TYPES.includes(type)) throw new QueryError(`Unknown joint "${type}". Joints: ${JOINT_TYPES.join(", ")}`);
        const note = input.note ? String(input.note) : undefined;
        const stopped = input.stopped === true;
        if (stopped && !canStop(type)) throw new QueryError(`A ${type.replace(/_/g, " ")} can't stop short of an edge. Only a dado, groove, rabbet or dado_rabbet can, so show it without stopped`);
        return {
          content: `The worked example of a ${stopped ? "stopped " : ""}${JOINT_LIBRARY[type].name.toLowerCase()} is open beside the model. Say a sentence about it; the drawer shows the rest.`,
          example: { joint: type, ...(note ? { note } : {}), ...(stopped ? { stopped: true as const } : {}) },
        };
      }
      case "ask_user": {
        const question = String(input.question ?? "").trim();
        if (!question) throw new QueryError("question is required");
        const options = Array.isArray(input.options) ? input.options.map(String) : [];
        return { content: "Question shown to the woodworker.", waitFor: { kind: "question", question, options } };
      }
      case "request_tool": {
        const r = ctx.requestTool(input as unknown as ToolRequest);
        return {
          requestId: r.id,
          content:
            `Logged as ${r.id}${r.count > 1 ? `, now asked for ${r.count} times` : ""}. The chat shows it as a missing-tool card with the spec, ` +
            "and a button that sends it to Claude Code to build. Tell the woodworker in plain words that the app doesn't have this tool yet, " +
            "that the spec is on the card, and that it needs sending to Claude Code before you can finish this part of the design.",
        };
      }
    }
    return { content: `Unknown tool "${name}"`, isError: true };
  } catch (e) {
    if (e instanceof OpError || e instanceof QueryError || e instanceof LibraryError || (e as Error).name === "ExprError") {
      return { content: (e as Error).message, isError: true };
    }
    throw e;
  }
}

/**
 * submit_plan's refusal when a key size fails: each one with its expression,
 * what the model gives and what the plan expects, or why it can't be worked
 * out. Nothing is pinned, and Claude fixes the size, the label or the model.
 */
function keySizeRefusal(sizes: KeySizeCheck[]): ToolOutcome {
  const wrong = sizes.filter((k) => !k.ok);
  const count = `${wrong.length} of ${sizes.length} key size${sizes.length === 1 ? "" : "s"} ${wrong.length === 1 ? "doesn't" : "don't"} match the model`;
  const line = (k: KeySizeCheck) =>
    k.error
      ? `- ${k.label}: ${k.error.replace(/\.$/, "")}.`
      : `- ${k.label}: ${k.expr} gives ${fmt(k.model_mm!)} mm on the model (${k.working}), but expected_mm is ${fmt(k.expected_mm)} (± ${fmt(k.tolerance_mm)}).`;
  return {
    content: [
      `The plan wasn't pinned. ${count}:`,
      ...wrong.map(line),
      "Fix expected_mm, the label or the model for each one, so every label says what its expression measures, such as a clear gap or a pitch. Then call submit_plan again with the whole plan.",
    ].join("\n"),
    isError: true,
    chatLine: `${count}: ${wrong.map((k) => k.label).join(", ")}. The plan wasn't pinned`,
  };
}
