// The joint library. Each joint has one entry: what it is, when it suits,
// which tools cut it, its usual proportions and the checks it needs. Claude
// reads it through list_joints, derive.ts takes defaults from it, and
// checks.ts runs its checks. The notes are written for this app.

import { fmt } from "./expr.js";
import { JOINT_FAMILY, type JointFamily, type JointType, type Severity } from "./types.js";

export type JointParam = "depth" | "fit" | "thickness" | "shoulder" | "count" | "diameter" | "length" | "finger" | "width";

/** Sizes a joint's defaults and checks work from, in mm. */
export interface JointContext {
  /** The guest's thickness. */
  guestThickness: number;
  /** The guest's width across the joint, along the edge that meets the host. */
  guestWidth: number;
  /** The host's thickness. */
  hostThickness: number;
  /** How far the host extends along the joint axis, from the face the guest meets. */
  hostDepth: number;
  /** The host's size across the tongue or tenon's thickness. */
  hostAcross: number;
  /** Through slots: the host left on each side of the slot, one entry per axis across it. */
  slotWalls?: SlotWall[];
  /**
   * Housings and insets: the host left on each side of the guest, across the
   * guest's thickness, before any fit. A side at 0 is the host's own end or
   * edge, so a housing there is open on that side.
   */
  housingWalls?: [number, number];
}

/** The host left on each side of a through slot along one axis, in mm. */
export interface SlotWall {
  lo: number;
  hi: number;
  /** The axis runs along the host's length, so a slot open this way is open at an end. */
  along_length: boolean;
}

/**
 * What a through slot is, once the fit is cut. Enclosed: host all round.
 * Open: it breaks out of one end of the host, which straddles the member
 * (an open slot, or bridle). A notch breaks out of a side or a corner, and
 * a slot open at both ends of one axis cuts the host in two.
 */
export type SlotShape =
  | { kind: "enclosed" }
  | { kind: "open"; wall: number; side: "lo" | "hi" }
  | { kind: "notch" }
  | { kind: "severed" };

export function slotShape(walls: SlotWall[], fit: number): SlotShape {
  const open = walls.flatMap((w, i) => (["lo", "hi"] as const).filter((s) => w[s] - fit / 2 <= 0.01).map((side) => ({ wall: i, side })));
  if (open.length === 0) return { kind: "enclosed" };
  if (walls.some((_, i) => open.filter((o) => o.wall === i).length === 2)) return { kind: "severed" };
  if (open.length === 1 && walls[open[0]!.wall]!.along_length) return { kind: "open", ...open[0]! };
  return { kind: "notch" };
}

export interface JointCheck {
  severity: Severity;
  message: string;
}

export interface JointEntry {
  type: JointType;
  name: string;
  family: JointFamily;
  summary: string;
  use_when: string;
  avoid_when: string;
  strength: "low" | "medium" | "high";
  tools: string[];
  /** Whether a standard home workshop can cut it. */
  home_workshop: boolean;
  changes_sizes: string;
  params: { name: JointParam; meaning: string; default: string }[];
  defaults(c: JointContext): Partial<Record<JointParam, number>>;
  check(p: Partial<Record<JointParam, number>>, c: JointContext): JointCheck[];
}

const half = (n: number) => Math.round(n * 2) / 2;
const none = () => [];

function housingDepthChecks(depth: number | undefined, c: JointContext, what: string): JointCheck[] {
  if (depth === undefined) return [];
  if (depth <= 0) return [{ severity: "error", message: `A ${what} needs a depth above 0` }];
  if (depth > c.hostDepth / 2 + 1e-9) {
    return [
      {
        severity: "error",
        message: `The ${what} is ${fmt(depth)} mm deep in ${fmt(c.hostDepth)} mm of material. Keep it to half the thickness or less`,
      },
    ];
  }
  if (depth > c.hostDepth / 3 + 1e-9) {
    return [
      {
        severity: "warning",
        message: `The ${what} is ${fmt(depth)} mm deep in ${fmt(c.hostDepth)} mm of material. A third of the thickness (${fmt(c.hostDepth / 3)} mm) is the usual limit`,
      },
    ];
  }
  return [];
}

/** Below this, wood beside a housing breaks off. The checks on cut shapes use the same line. */
const THIN_WALL_MM = 6;

/** The host left beside a housing on each side, once a fit or a wider cut takes its share from each. */
function wallsBeside(c: JointContext, extra: number): [number, number] | null {
  return c.housingWalls ? [c.housingWalls[0] - extra / 2, c.housingWalls[1] - extra / 2] : null;
}

/**
 * A groove runs with the host's grain, so it can go to half the host's
 * thickness. It's checked for depth, for a set width that doesn't suit the
 * panel, and for a thin strip of host beside it. A groove run out of the
 * host's edge is cut the way a rabbet is, so it has no strip to check.
 */
function grooveChecks(p: Partial<Record<JointParam, number>>, c: JointContext): JointCheck[] {
  const out: JointCheck[] = [];
  const d = p.depth;
  const behind = (depth: number) => `The groove is ${fmt(depth)} mm deep in ${fmt(c.hostDepth)} mm of material, which leaves ${fmt(c.hostDepth - depth)} mm behind it.`;
  if (d !== undefined && d <= 0) out.push({ severity: "error", message: "A groove needs a depth above 0" });
  else if (d !== undefined && d > (c.hostDepth * 2) / 3 + 1e-9) out.push({ severity: "error", message: `${behind(d)} Keep it to half the thickness or less` });
  else if (d !== undefined && d > c.hostDepth / 2 + 1e-9) {
    out.push({ severity: "warning", message: `${behind(d)} Half the thickness (${fmt(c.hostDepth / 2)} mm) is the usual limit` });
  }
  const w = p.width;
  const t = c.guestThickness;
  if (w !== undefined && w < t - 1e-9) {
    out.push({
      severity: "error",
      message: `The groove is ${fmt(w)} mm wide and the panel ${fmt(t)} mm thick, so the panel won't go in. Cut the groove ${fmt(t)} mm wide, or thin the panel's edge to fit with a tongue joint`,
    });
  } else if (w !== undefined && w > t + 1 + 1e-9) {
    out.push({ severity: "warning", message: `The groove is ${fmt(w)} mm wide for a ${fmt(t)} mm panel, so the panel rattles in it. Keep the groove within 1 mm of the panel's thickness` });
  }
  for (const wall of wallsBeside(c, w !== undefined ? w - t : (p.fit ?? 0)) ?? []) {
    if (wall > 0.01 && wall < THIN_WALL_MM - 1e-9) {
      out.push({
        severity: "warning",
        message: `The groove is ${fmt(wall)} mm from the host's edge, and a strip that thin breaks off. Set the panel at least ${THIN_WALL_MM} mm in, or about 10 mm for a drawer bottom`,
      });
    }
  }
  return out;
}

/**
 * A rabbet is open on one side, and it's usually half to two thirds of the
 * host's thickness deep, which leaves a lip over the guest's end.
 */
function rabbetChecks(p: Partial<Record<JointParam, number>>, c: JointContext): JointCheck[] {
  const out: JointCheck[] = [];
  const d = p.depth;
  if (d !== undefined && d <= 0) out.push({ severity: "error", message: "A rabbet needs a depth above 0" });
  else if (d !== undefined && d >= c.hostDepth - 1e-9) {
    out.push({ severity: "error", message: `The rabbet is ${fmt(d)} mm deep in ${fmt(c.hostDepth)} mm of material, so it leaves no lip. Make it shallower, or use a butt joint` });
  } else if (d !== undefined && d > (c.hostDepth * 2) / 3 + 1e-9) {
    out.push({
      severity: "warning",
      message: `The rabbet is ${fmt(d)} mm deep in ${fmt(c.hostDepth)} mm of material and leaves a ${fmt(c.hostDepth - d)} mm lip. Two thirds of the thickness (${fmt((c.hostDepth * 2) / 3)} mm) is the usual limit`,
    });
  }
  const walls = wallsBeside(c, p.fit ?? 0);
  if (walls && walls.every((w) => w > 0.01)) {
    out.push({
      severity: "warning",
      message: `The rabbet has ${fmt(walls[0])} mm of the host on one side and ${fmt(walls[1])} mm on the other, so it's a dado or a groove. Set the guest flush with the host's end or edge, or use a dado or a groove`,
    });
  }
  return out;
}

/**
 * A dado and rabbet's tongue sits on the guest's face away from the host's
 * nearer end, so the short grain left beyond the dado is the guest's
 * thickness less the tongue, plus any gap to that end.
 */
function dadoRabbetChecks(p: Partial<Record<JointParam, number>>, c: JointContext): JointCheck[] {
  const out: JointCheck[] = [];
  if (p.thickness !== undefined && p.thickness >= c.guestThickness) {
    out.push({ severity: "error", message: `The tongue (${fmt(p.thickness)} mm) must be thinner than the guest (${fmt(c.guestThickness)} mm)` });
  }
  out.push(...housingDepthChecks(p.depth, c, "dado"));
  if (p.thickness !== undefined && c.housingWalls) {
    const grain = Math.min(...c.housingWalls) + c.guestThickness - p.thickness - (p.fit ?? 0) / 2;
    if (grain < THIN_WALL_MM - 1e-9) {
      out.push({
        severity: "warning",
        message: `Only ${fmt(grain)} mm of the host is left beyond the dado, and short grain that thin breaks off. Leave ${THIN_WALL_MM} mm or more with a thinner tongue, or set the guest in from the host's end`,
      });
    }
  }
  return out;
}

const ENTRIES: JointEntry[] = [
  {
    type: "butt",
    name: "Butt joint",
    family: "fastener",
    summary: "One part's end or edge sits flat against another, held by glue alone or by fixings added separately.",
    use_when: "Light parts, hidden faces, or where screws, pocket screws or dowels do the holding.",
    avoid_when: "On its own wherever it carries load. End grain glues poorly.",
    strength: "low",
    tools: ["saw"],
    home_workshop: true,
    changes_sizes: "None. The guest stops at the host's face.",
    params: [],
    defaults: () => ({}),
    check: none,
  },
  {
    type: "screws",
    name: "Screwed joint",
    family: "fastener",
    summary: "Screws driven through the host into the guest.",
    use_when: "Fixing tops, backs and carcass parts quickly, often with glue. Hidden faces, or where plugs or a top cover the heads.",
    avoid_when: "Into end grain of particleboard or MDF, or where heads would show on a show face.",
    strength: "medium",
    tools: ["drill/driver"],
    home_workshop: true,
    changes_sizes: "None. Adds pilot holes to the host.",
    params: [
      { name: "count", meaning: "How many screws", default: "2" },
      { name: "diameter", meaning: "Screw gauge in mm", default: "4" },
      { name: "length", meaning: "Screw length", default: "the host's thickness plus 25 mm" },
    ],
    defaults: (c) => ({ count: 2, diameter: 4, length: half(c.hostThickness + 25) }),
    check: (p, c) =>
      p.length !== undefined && p.length - c.hostThickness < 15
        ? [{ severity: "warning", message: `Only ${fmt(p.length - c.hostThickness)} mm of each screw reaches the guest. Aim for 15 mm or more` }]
        : [],
  },
  {
    type: "pocket_screws",
    name: "Pocket screws",
    family: "fastener",
    summary: "Screws driven at a shallow angle from a pocket drilled in the guest's hidden face into the host.",
    use_when: "Face frames, attaching rails and tops, and quick carcass joints where one face of the guest won't be seen.",
    avoid_when: "Where the pocket face shows, or in stock under about 12 mm thick.",
    strength: "medium",
    tools: ["pocket-hole jig", "drill/driver"],
    home_workshop: true,
    changes_sizes: "None. Adds pocket holes to the guest's hidden face.",
    params: [
      { name: "count", meaning: "How many pocket screws", default: "2" },
      { name: "length", meaning: "Screw length", default: "30 mm for stock up to 22 mm, else 40 mm" },
    ],
    defaults: (c) => ({ count: 2, length: c.guestThickness <= 22 ? 30 : 40, diameter: 4 }),
    check: (_p, c) =>
      c.guestThickness < 12
        ? [{ severity: "warning", message: `The guest is ${fmt(c.guestThickness)} mm thick. Pocket-hole jigs need about 12 mm or more` }]
        : [],
  },
  {
    type: "dowels",
    name: "Dowel joint",
    family: "fastener",
    summary: "Round wooden dowels glued into matching holes in both parts.",
    use_when: "Aligning and strengthening carcass corners and frames without visible fixings.",
    avoid_when: "Where the holes can't be lined up accurately; use a doweling jig.",
    strength: "medium",
    tools: ["drill/driver", "doweling jig"],
    home_workshop: true,
    changes_sizes: "None. Adds matching holes to both parts.",
    params: [
      { name: "count", meaning: "How many dowels", default: "2" },
      { name: "diameter", meaning: "Dowel diameter", default: "8 mm, or 6 mm in stock under 16 mm" },
      { name: "length", meaning: "Dowel length, split across both parts", default: "30 mm" },
    ],
    defaults: (c) => ({ count: 2, diameter: Math.min(c.guestThickness, c.hostThickness) < 16 ? 6 : 8, length: 30 }),
    check: (p, c) => {
      const thin = Math.min(c.guestThickness, c.hostThickness);
      return p.diameter !== undefined && p.diameter > thin / 2 + 1e-9
        ? [{ severity: "warning", message: `${fmt(p.diameter)} mm dowels are more than half of ${fmt(thin)} mm stock. Use ${fmt(half(thin / 2))} mm or less` }]
        : [];
    },
  },
  {
    type: "dado",
    name: "Dado (housing)",
    family: "housing",
    summary: "A square-bottomed trench across the host's grain that the guest's whole end sits in.",
    use_when: "Fixed shelves, dividers and carcass bottoms. It locates the part and resists sagging.",
    avoid_when: "Near the end of the host, where the short grain beyond can break out; use a rabbet there.",
    strength: "medium",
    tools: ["router", "table saw"],
    home_workshop: true,
    changes_sizes: "The guest is longer by the depth at each housed end.",
    params: [
      { name: "depth", meaning: "How far the guest goes into the host", default: "a third of the host's thickness" },
      { name: "fit", meaning: "Extra trench width for an easy fit", default: "0" },
    ],
    defaults: (c) => ({ depth: half(c.hostDepth / 3), fit: 0 }),
    check: (p, c) => housingDepthChecks(p.depth, c, "dado"),
  },
  {
    type: "groove",
    name: "Groove",
    family: "housing",
    summary: "A trench running with the host's grain that holds a panel's edge, such as a drawer bottom or a back. A panel can sit in a groove in every part round it.",
    use_when:
      "Drawer bottoms, held in grooves in the sides, the front and the back about 10 mm up from their bottom edges, never screwed on underneath. A 6 mm ply bottom takes a 6 mm wide groove, 6 mm deep in 12 to 15 mm sides. Backs and panels that sit in a frame.",
    avoid_when: "For a part that carries load across the groove, or a panel thicker than the groove; give a thick panel a tongue joint, which thins its edge to fit.",
    strength: "low",
    tools: ["router", "table saw"],
    home_workshop: true,
    changes_sizes:
      "The panel is larger by the depth on each housed edge, so give it one groove joint for each part it sits in. A drawer back can stop on top of the bottom instead, so the bottom slides in from behind along the sides' grooves and screws up into the back.",
    params: [
      { name: "depth", meaning: "How far the panel goes into the host, up to half the host's thickness", default: "a third of the host's thickness" },
      { name: "fit", meaning: "Extra groove width for an easy fit", default: "0" },
      { name: "width", meaning: "The groove's width, when the cutter sets it, such as a 6 mm bit. Give it or fit, not both", default: "the panel's thickness plus the fit" },
    ],
    defaults: (c) => ({ depth: half(c.hostDepth / 3), fit: 0 }),
    check: grooveChecks,
  },
  {
    type: "rabbet",
    name: "Rabbet",
    family: "housing",
    summary: "A step cut along the host's edge or end that the guest sits in, open on one side.",
    use_when:
      "Drawer-box corners, with each side in a rabbet across the end of the front and of the back, as wide as the side is thick and about half the front's thickness deep. Carcass corners, tops and bottoms at the ends of sides, and backs set into the sides.",
    avoid_when: "As the only joint for a heavily loaded corner; add screws or dowels. Away from the host's end or edge, where it's a dado or a groove.",
    strength: "medium",
    tools: ["router", "table saw"],
    home_workshop: true,
    changes_sizes: "The guest is longer by the depth at each housed end.",
    params: [
      { name: "depth", meaning: "How far the guest goes into the host, up to two thirds of the host's thickness", default: "a third of the host's thickness" },
      { name: "fit", meaning: "Extra width for an easy fit", default: "0" },
    ],
    defaults: (c) => ({ depth: half(c.hostDepth / 3), fit: 0 }),
    check: rabbetChecks,
  },
  {
    type: "tongue",
    name: "Tongue and groove",
    family: "inset",
    summary: "A tongue on the guest's edge or end fits a matching groove in the host.",
    use_when: "Joining boards edge to edge, breadboard ends, and panels that need to stay aligned.",
    avoid_when: "In thin stock, where the groove walls would be fragile.",
    strength: "medium",
    tools: ["router", "table saw"],
    home_workshop: true,
    changes_sizes: "The guest is longer by the tongue's depth. Its tongue is thinner than the part.",
    params: [
      { name: "thickness", meaning: "Tongue thickness", default: "a third of the guest's thickness" },
      { name: "depth", meaning: "Tongue length into the host", default: "half the guest's thickness" },
      { name: "fit", meaning: "Extra groove width for an easy fit", default: "0" },
    ],
    defaults: (c) => ({ thickness: half(c.guestThickness / 3), depth: half(c.guestThickness / 2), fit: 0 }),
    check: (p, c) => {
      const out: JointCheck[] = [];
      if (p.thickness !== undefined && p.thickness >= c.guestThickness) {
        out.push({ severity: "error", message: `The tongue (${fmt(p.thickness)} mm) must be thinner than the guest (${fmt(c.guestThickness)} mm)` });
      }
      const wall = p.thickness !== undefined ? (c.hostAcross - p.thickness) / 2 : Infinity;
      if (wall < Math.max(3, c.hostAcross / 4)) {
        out.push({ severity: "warning", message: `The groove leaves ${fmt(wall)} mm walls in the host. Thin walls split; make the tongue thinner` });
      }
      if (p.depth !== undefined && p.depth >= c.hostDepth) {
        out.push({ severity: "error", message: `The tongue (${fmt(p.depth)} mm) is as deep as the host is wide there (${fmt(c.hostDepth)} mm)` });
      }
      return out;
    },
  },
  {
    type: "dado_rabbet",
    name: "Dado and rabbet",
    family: "inset",
    summary:
      "A rabbet across the guest's end leaves a tongue on one face, which fits a dado in the host near its end. The tongue hooks into the dado, so the corner holds when it's pulled.",
    use_when: "Drawer-box corners that take a pull, such as a front or back between the sides, and carcass corners where a plain rabbet would need fixings.",
    avoid_when: "Where the dado would leave under 6 mm of short grain beyond it, in solid timber above all; set the guest in from the host's end, or use a rabbet.",
    strength: "medium",
    tools: ["table saw", "router"],
    home_workshop: true,
    changes_sizes:
      "The guest is longer by the tongue's length at each end. The tongue sits on the guest's face away from the host's nearer end, which leaves the most wood beyond the dado.",
    params: [
      { name: "thickness", meaning: "Tongue thickness, which is the dado's width", default: "half the guest's thickness" },
      { name: "depth", meaning: "Tongue length, which is the dado's depth", default: "a third of the host's thickness" },
      { name: "fit", meaning: "Extra dado width for an easy fit", default: "0" },
    ],
    defaults: (c) => ({ thickness: half(c.guestThickness / 2), depth: half(c.hostDepth / 3), fit: 0 }),
    check: dadoRabbetChecks,
  },
  {
    type: "mortise_tenon",
    name: "Mortise and tenon",
    family: "inset",
    summary: "A tenon on the end of a rail fits a rectangular mortise cut into the host, usually a leg or stile.",
    use_when: "Legs and rails of tables, benches and frames. The strongest everyday frame joint.",
    avoid_when: "In sheet goods; use dowels or a housing instead.",
    strength: "high",
    tools: ["router", "drill/driver", "chisels", "table saw"],
    home_workshop: true,
    changes_sizes: "The rail is longer by the tenon's length at each end.",
    params: [
      { name: "thickness", meaning: "Tenon thickness", default: "a third of the rail's thickness" },
      { name: "depth", meaning: "Tenon length", default: "two thirds of the host's depth there" },
      { name: "shoulder", meaning: "How far the tenon is set in from each edge of the rail", default: "10 mm, or a sixth of the rail's width if that's less" },
      { name: "fit", meaning: "Extra mortise width for an easy fit", default: "0" },
    ],
    defaults: (c) => ({
      thickness: half(c.guestThickness / 3),
      depth: half((c.hostDepth * 2) / 3),
      shoulder: half(Math.min(10, c.guestWidth / 6)),
      fit: 0,
    }),
    check: (p, c) => {
      const out: JointCheck[] = [];
      if (p.thickness !== undefined && p.thickness >= c.guestThickness) {
        out.push({ severity: "error", message: `The tenon (${fmt(p.thickness)} mm) must be thinner than the rail (${fmt(c.guestThickness)} mm)` });
      }
      const wall = p.thickness !== undefined ? (c.hostAcross - p.thickness) / 2 : Infinity;
      if (wall < 6) {
        out.push({ severity: "warning", message: `The mortise leaves ${fmt(wall)} mm walls in the host. Leave at least 6 mm` });
      }
      if (p.depth !== undefined && p.depth > c.hostDepth + 1e-9) {
        out.push({ severity: "error", message: `The tenon (${fmt(p.depth)} mm) is longer than the host is deep (${fmt(c.hostDepth)} mm)` });
      }
      if (p.shoulder !== undefined && c.guestWidth - 2 * p.shoulder <= 0) {
        out.push({ severity: "error", message: `Shoulders of ${fmt(p.shoulder)} mm leave no tenon on a ${fmt(c.guestWidth)} mm rail` });
      }
      return out;
    },
  },
  {
    type: "half_lap",
    name: "Half lap",
    family: "interlock",
    summary: "Two parts cross or meet in the same plane, each cut away by half its thickness where they overlap.",
    use_when: "Frames, stretchers and grids, where parts cross or meet at a corner and should stay flush.",
    avoid_when: "Where the parts are different thicknesses, or the overlap can't be glued.",
    strength: "medium",
    tools: ["router", "table saw", "chisels"],
    home_workshop: true,
    changes_sizes: "None. Position both parts overlapping fully; each loses half its thickness in the overlap.",
    params: [],
    defaults: () => ({}),
    check: (_p, c) =>
      Math.abs(c.guestThickness - c.hostThickness) > 0.01
        ? [{ severity: "warning", message: `A half lap works best with equal thicknesses, not ${fmt(c.guestThickness)} and ${fmt(c.hostThickness)} mm` }]
        : [],
  },
  {
    type: "box_joint",
    name: "Box joint",
    family: "interlock",
    summary: "Interlocking square fingers cut across the ends of two boards meeting at a corner.",
    use_when: "Strong, visible corners on boxes and drawers.",
    avoid_when: "Where the end grain shouldn't show, or in sheet goods with weak edges.",
    strength: "high",
    tools: ["table saw", "router", "box joint jig"],
    home_workshop: true,
    changes_sizes: "None. Both boards run to the outside of the corner; each loses alternate fingers.",
    params: [{ name: "finger", meaning: "Finger width", default: "the board thickness" }],
    defaults: (c) => ({ finger: half(Math.min(c.guestThickness, c.hostThickness)) }),
    check: (p) => (p.finger !== undefined && p.finger < 4 ? [{ severity: "warning", message: `Fingers under 4 mm are fragile` }] : []),
  },
  {
    type: "through_slot",
    name: "Through slot (through mortise or bridle)",
    family: "through",
    summary:
      "One member passes right through a slot cut in another, and stays uncut itself. Where the member sits at the very end of the host, the slot opens out of that end and the host straddles it like a saddle: an open slot, or bridle.",
    use_when: "Bearers or rails running through posts, ladder-style uprights, and visible through-joinery. Put the member at the end of the post for a bridle. A wedge or pin can lock it.",
    avoid_when: "When the slot would leave thin walls in the host, or break out of its side; use a half lap or a housing then.",
    strength: "high",
    tools: ["drill/driver", "chisels", "router", "saw"],
    home_workshop: true,
    changes_sizes:
      "None. The passing member keeps its size; the host gets a slot the size of its cross-section, right through. At the host's end the slot is open, cut in from the end with a saw and chisel.",
    params: [{ name: "fit", meaning: "Extra slot width and height for an easy fit", default: "0" }],
    defaults: () => ({ fit: 0 }),
    check: (p, c) => {
      if (!c.slotWalls) return [];
      const fit = p.fit ?? 0;
      const shape = slotShape(c.slotWalls, fit);
      if (shape.kind === "severed") {
        return [{ severity: "error", message: "The slot runs right across the host and would cut it in two. Use a half lap or a housing" }];
      }
      if (shape.kind === "notch") {
        return [
          {
            severity: "error",
            message: "The slot breaks out of the edge of the host, so it's a notch, not a slot. Move the member in, or to the host's end for an open slot (bridle), or use a half lap or a housing",
          },
        ];
      }
      // The open end of a bridle isn't a wall, so leave it out.
      const left = c.slotWalls.flatMap((w, i) =>
        (["lo", "hi"] as const).filter((s) => !(shape.kind === "open" && shape.wall === i && shape.side === s)).map((s) => w[s]),
      );
      const cheek = Math.min(...left) - fit / 2;
      const least = Math.max(6, c.hostThickness / 4);
      return cheek < least
        ? [{ severity: "warning", message: `Only ${fmt(cheek)} mm of the host is left beside the slot. Thin walls split; leave at least ${fmt(least)} mm` }]
        : [];
    },
  },
];

export const JOINT_LIBRARY: Record<JointType, JointEntry> = Object.fromEntries(ENTRIES.map((e) => [e.type, e])) as Record<JointType, JointEntry>;

for (const e of ENTRIES) {
  if (JOINT_FAMILY[e.type] !== e.family) throw new Error(`Joint library family mismatch for ${e.type}`);
}

/** The joints whose housing can stop short of an edge of its host: a dado, groove, rabbet, or the dado of a dado and rabbet. */
export const STOPPABLE_JOINTS: readonly JointType[] = ["dado", "groove", "rabbet", "dado_rabbet"];

/** Whether a joint's housing can stop short of an edge of its host. */
export function canStop(type: JointType): boolean {
  return STOPPABLE_JOINTS.includes(type);
}

/** The housing a stop shortens, in workshop words: a dado and rabbet's is its dado. */
export function housingWord(type: JointType): string {
  return type === "dado_rabbet" ? "dado" : type;
}

/** What a housing's stop does, as Claude reads it in the library. */
export const STOP_HELP =
  'It can stop short of one or both edges it runs between, so its end doesn\'t show on a visible edge: give stop, such as {"front": "10"}. ' +
  "The guest keeps its place and size, and its corner is notched to match. Cut it with a router and square the end with a chisel.";

/** The library as Claude reads it. */
export function describeJoints(homeWorkshopOnly = true) {
  return ENTRIES.filter((e) => !homeWorkshopOnly || e.home_workshop).map((e) => ({
    type: e.type,
    name: e.name,
    family: e.family,
    summary: e.summary,
    use_when: e.use_when,
    avoid_when: e.avoid_when,
    strength: e.strength,
    tools: e.tools,
    changes_sizes: e.changes_sizes,
    params: e.params,
    ...(canStop(e.type) ? { stop: STOP_HELP } : {}),
  }));
}
