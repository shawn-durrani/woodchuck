// The design file stores intent only. Every number that reaches a plan or
// the cut list is derived from it (see derive.ts). All lengths are in mm.
//
// World axes: x runs left to right, y runs up from the floor, z runs from
// the back to the front. Each part's box is the blank you cut it from, so it
// has six faces named by the direction they face. Cuts then shape the blank
// on its broad face, with sloped edges, notches and holes (see profile.ts).

export type Axis = "x" | "y" | "z";
export const AXES: readonly Axis[] = ["x", "y", "z"];

export type Face = "left" | "right" | "bottom" | "top" | "back" | "front";
export const FACES: readonly Face[] = ["left", "right", "bottom", "top", "back", "front"];

export const FACE_AXIS: Record<Face, Axis> = {
  left: "x",
  right: "x",
  bottom: "y",
  top: "y",
  back: "z",
  front: "z",
};
/** True for the face on the positive side of its axis. */
export const FACE_IS_MAX: Record<Face, boolean> = {
  left: false,
  right: true,
  bottom: false,
  top: true,
  back: false,
  front: true,
};
export const AXIS_FACES: Record<Axis, [Face, Face]> = {
  x: ["left", "right"],
  y: ["bottom", "top"],
  z: ["back", "front"],
};

export type ParamUnit = "mm" | "count" | "kg" | "deg" | "none";

export interface Param {
  name: string;
  /** An expression. A plain number makes the parameter a slider. */
  expr: string;
  unit: ParamUnit;
  min?: number;
  max?: number;
  step?: number;
  note?: string;
}

export type MaterialKind = "sheet" | "solid";

export interface Material {
  id: string;
  name: string;
  kind: MaterialKind;
  /** Measured thickness. Parts are always this thick. */
  thickness_mm: number;
  /** What the supplier calls it, when that differs from the measured one. */
  nominal_thickness_mm?: number;
  grained: boolean;
  /** Sheet sizes as [length along the grain, width]. */
  sheet_sizes_mm?: [number, number][];
  /** Longest board you can buy, for solid timber. */
  board_max_length_mm?: number;
  board_max_width_mm?: number;
  /** The timber, for the finished view. An id from SPECIES. */
  species?: string;
  note?: string;
}

/**
 * Where one end of a part sits on an axis. Either an absolute expression
 * (`at`), or another part's face plus an optional offset. The offset is
 * measured along the positive axis, so a gap before a face is negative.
 */
export type Bound = { at: string } | { face: string; offset?: string };

/**
 * How a part spans one axis. Give exactly two of start, end and size.
 * On the thickness axis, the size comes from the material, so give exactly
 * one of start or end.
 */
export interface AxisSpec {
  start?: Bound;
  end?: Bound;
  size?: string;
}

/**
 * A straight cut along one edge of the blank: a slope, a taper or a corner
 * cut off. It takes wood from the `edge` side of the line through its two
 * points, and the line runs on past them. `start` and `end` are where the
 * new edge sits on the edge's own axis, at the start and the end of the run.
 * The run is the part's other face axis, and its two points sit at the
 * part's own ends unless start_along or end_along says otherwise.
 */
export interface EdgeCut {
  id: string;
  kind: "edge";
  /** The edge it takes wood from. Never a broad face, on the thickness axis. */
  edge: Face;
  start: Bound;
  end: Bound;
  start_along?: Bound;
  end_along?: Bound;
  note?: string;
}

/**
 * A shape cut right through the part's thickness: a rectangle, a rounded
 * rectangle or a circle. Inside the outline it's a hole, and reaching the
 * outline it's a notch, such as a toe kick.
 */
export interface Cutout {
  id: string;
  kind: "cutout";
  shape: "rect" | "circle";
  /** A rect spans the part's two face axes, each like a part's own axis. */
  x?: AxisSpec;
  y?: AxisSpec;
  z?: AxisSpec;
  /** A rect's corner radius. Half the shorter side makes a slot with round ends. */
  radius?: string;
  /** A circle's centre, on the part's two face axes. */
  centre?: Partial<Record<Axis, Bound>>;
  diameter?: string;
  note?: string;
}

export type PanelCut = EdgeCut | Cutout;

export interface Panel {
  id: string;
  name: string;
  material: string;
  thickness_axis: Axis;
  /** The axis the grain runs along. It becomes the cut list's length. */
  grain_axis: Axis;
  x: AxisSpec;
  y: AxisSpec;
  z: AxisSpec;
  tags?: string[];
  /** Props for presentation. Never on the cut list or plans. */
  decor?: boolean;
  note?: string;
  /** Edge cuts first, in order, then cutouts. With none, the part is its blank. */
  cuts?: PanelCut[];
}

/** A stopgap shape added when no tool can express something yet. */
export interface UnverifiedBox {
  id: string;
  name: string;
  min_mm: [number, number, number];
  max_mm: [number, number, number];
  reason: string;
  request_id?: string;
}

export type JointType =
  | "butt"
  | "screws"
  | "pocket_screws"
  | "dowels"
  | "dado"
  | "groove"
  | "rabbet"
  | "tongue"
  | "mortise_tenon"
  | "half_lap"
  | "box_joint"
  | "through_slot";

export const JOINT_TYPES: readonly JointType[] = [
  "butt",
  "screws",
  "pocket_screws",
  "dowels",
  "dado",
  "groove",
  "rabbet",
  "tongue",
  "mortise_tenon",
  "half_lap",
  "box_joint",
  "through_slot",
];

/**
 * How a joint changes the geometry. A housing takes the guest's whole end
 * into the host. An inset takes a smaller tongue or tenon. An interlock is
 * two parts that overlap, each losing part of the overlap. A through joint
 * is one part passing uncut through a slot in another. A fastener joins
 * parts without changing their sizes.
 */
export type JointFamily = "housing" | "inset" | "interlock" | "through" | "fastener";

export const JOINT_FAMILY: Record<JointType, JointFamily> = {
  butt: "fastener",
  screws: "fastener",
  pocket_screws: "fastener",
  dowels: "fastener",
  dado: "housing",
  groove: "housing",
  rabbet: "housing",
  tongue: "inset",
  mortise_tenon: "inset",
  half_lap: "interlock",
  box_joint: "interlock",
  through_slot: "through",
};

/** Joints that lengthen the guest into the host. */
export const HOUSING_JOINTS: readonly JointType[] = ["dado", "groove", "rabbet", "tongue", "mortise_tenon"];

export interface Joint {
  id: string;
  type: JointType;
  /** The part that gets cut into. In an interlock, it keeps the lower half or the odd fingers. */
  host: string;
  /** The part that sits in or against the host. Housings and insets lengthen it. */
  guest: string;
  /** How far the guest goes into the host. Defaults come from the joint library. */
  depth?: string;
  /** Extra width on the host's housing for an easy fit. */
  fit?: string;
  /** Thickness of a tongue or tenon. */
  thickness?: string;
  /** How much a tenon is set in from each edge of the rail. */
  shoulder?: string;
  /** Number of screws, pocket screws or dowels. */
  count?: number;
  /** Screw or dowel diameter. */
  diameter?: string;
  /** Screw or dowel length. */
  length?: string;
  /** Box joint finger width. */
  finger?: string;
  note?: string;
}

/**
 * Repeats parts along an axis. Copies are named `<id>#2`, `<id>#3` and so on;
 * the original is item 1. Joints between the repeated parts repeat too.
 */
export interface ArrayPattern {
  id: string;
  parts: string[];
  axis: Axis;
  count: string;
  pitch: string;
}

export interface Hardware {
  id: string;
  kind: string;
  name: string;
  /** Parts this hardware joins. It counts as a connection for support. */
  connects: string[];
  qty: number;
  spec?: Record<string, number | string>;
  /** The library part it came from. Its specs and model are copied in, so the design stands on its own. */
  library_part?: string;
  /** The part's model, in its own frame: x along its length, y up, z across. */
  shape?: { name: string; min_mm: [number, number, number]; max_mm: [number, number, number] }[];
  /** Where the model sits: expressions for its corner, and the world axis its length runs along. */
  place?: { x: string; y: string; z: string; length_axis?: Axis };
  /** Castors, levellers or feet: the parts it connects count as standing on the floor. */
  on_floor?: boolean;
  note?: string;
}

/**
 * Hardware is what you buy, so it names something to buy it by: a library
 * part, or the maker's figures in its spec. Wooden runners and glides are
 * timber, cut from the cut list.
 */
export function hasPartToBuy(h: Pick<Hardware, "library_part" | "spec">): boolean {
  return !!h.library_part || Object.keys(h.spec ?? {}).length > 0;
}

export type Severity = "error" | "warning";

export interface Rule {
  id: string;
  /** A true/false expression, for example `drawer_inside_width >= 320`. */
  expr: string;
  severity: Severity;
  message: string;
}

export interface PlanPart {
  label: string;
  qty: number;
  /** Parts carrying this tag are counted against qty. */
  tag: string;
}

export interface PlanDim {
  label: string;
  expr: string;
  expected_mm: number;
  tolerance_mm?: number;
  /** What the model gave when the plan was pinned, which the plan's card shows. */
  model_mm?: number;
}

export interface Plan {
  status: "proposed" | "approved" | "changes_requested";
  summary: string;
  parts: PlanPart[];
  key_dims: PlanDim[];
  joints: string[];
  assumptions: string[];
}

/** What one material is bought as, for the cutting layouts. */
export interface MaterialStock {
  /** A sheet as [length along the grain, width]. */
  sheet_mm?: [number, number];
  /** The lengths a solid timber comes in, shortest first. */
  lengths_mm?: number[];
}

/**
 * Stock for the cutting layouts. Anything left out takes its default from
 * layout.ts, so a design without this field still lays out.
 */
export interface StockSettings {
  /** The width of the saw's cut. */
  kerf_mm?: number;
  /** Cut off every edge of a sheet before parts go on it. */
  trim_mm?: number;
  /** By material id. */
  materials?: Record<string, MaterialStock>;
}

export interface Design {
  schema: 1;
  name: string;
  params: Param[];
  materials: Material[];
  parts: Panel[];
  unverified: UnverifiedBox[];
  joints: Joint[];
  arrays: ArrayPattern[];
  hardware: Hardware[];
  rules: Rule[];
  plan?: Plan;
  /**
   * Finishes by target: "material:<id>", "<part>" or "<part>.<face>". A part
   * can be an array copy such as shelf#2. Values are finish ids such as
   * "satin_wood_oil/amsterdam", or "raw". See finishes.ts.
   */
  finishes?: Record<string, string>;
  /** Sheet sizes, stock lengths, kerf and trim for the cutting layouts. */
  stock?: StockSettings;
}

export function emptyDesign(name: string): Design {
  return {
    schema: 1,
    name,
    params: [],
    materials: [],
    parts: [],
    unverified: [],
    joints: [],
    arrays: [],
    hardware: [],
    rules: [],
  };
}

export const ID_PATTERN = /^[a-z][a-z0-9_]*$/;
