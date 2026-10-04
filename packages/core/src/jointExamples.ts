// A worked example of each joint in the library: two sample boards, laid
// out the way the joint is usually used and built with the same operations
// as any design, so every size and cut in it is real.

import { applyOps, type Op } from "./ops.js";
import { JOINT_LIBRARY } from "./joints.js";
import { emptyDesign, type AxisSpec, type Design, type JointType } from "./types.js";

const solid = (id: string, t: number): Op => ({
  op: "define_material",
  id,
  name: `${t} mm timber`,
  kind: "solid",
  thickness_mm: t,
  grained: true,
  species: "tasmanian_oak",
});
const ply = (id: string, t: number): Op => ({
  op: "define_material",
  id,
  name: `${t} mm plywood`,
  kind: "sheet",
  thickness_mm: t,
  grained: true,
  species: "birch_ply",
});

/** A side standing on the floor with a board meeting its inside face, for housings and fasteners. */
function sideAndShelf(y: AxisSpec): Op[] {
  return [
    solid("stock", 18),
    {
      op: "add_panel",
      id: "side",
      name: "Side",
      material: "stock",
      thickness_axis: "x",
      grain_axis: "y",
      x: { start: { at: "0" } },
      y: { start: { at: "0" }, size: "360" },
      z: { start: { at: "0" }, size: "200" },
    },
    {
      op: "add_panel",
      id: "shelf",
      name: "Shelf",
      material: "stock",
      thickness_axis: "y",
      grain_axis: "x",
      x: { start: { face: "side.right" }, size: "300" },
      y,
      z: { start: { at: "0" }, size: "200" },
    },
  ];
}

const LAYOUTS: Record<JointType, () => Op[]> = {
  dado: () => [...sideAndShelf({ start: { at: "180" } }), { op: "add_joint", id: "joint", type: "dado", host: "side", guest: "shelf" }],
  rabbet: () => [...sideAndShelf({ end: { face: "side.top" } }), { op: "add_joint", id: "joint", type: "rabbet", host: "side", guest: "shelf" }],
  groove: () => [
    solid("stock", 15),
    ply("bottom_ply", 6),
    {
      op: "add_panel",
      id: "drawer_side",
      name: "Drawer side",
      material: "stock",
      thickness_axis: "x",
      grain_axis: "z",
      x: { start: { at: "0" } },
      y: { start: { at: "0" }, size: "120" },
      z: { start: { at: "0" }, size: "350" },
    },
    {
      op: "add_panel",
      id: "drawer_bottom",
      name: "Drawer bottom",
      material: "bottom_ply",
      thickness_axis: "y",
      grain_axis: "z",
      x: { start: { face: "drawer_side.right" }, size: "250" },
      y: { start: { at: "12" } },
      z: { start: { at: "0" }, size: "350" },
    },
    { op: "add_joint", id: "joint", type: "groove", host: "drawer_side", guest: "drawer_bottom" },
  ],
  tongue: () => [
    solid("stock", 19),
    {
      op: "add_panel",
      id: "board_a",
      name: "Board A",
      material: "stock",
      thickness_axis: "y",
      grain_axis: "x",
      x: { start: { at: "0" }, size: "400" },
      y: { start: { at: "0" } },
      z: { start: { at: "0" }, size: "120" },
    },
    {
      op: "add_panel",
      id: "board_b",
      name: "Board B",
      material: "stock",
      thickness_axis: "y",
      grain_axis: "x",
      x: { start: { at: "0" }, size: "400" },
      y: { start: { at: "0" } },
      z: { start: { face: "board_a.front" }, size: "120" },
    },
    { op: "add_joint", id: "joint", type: "tongue", host: "board_a", guest: "board_b" },
  ],
  mortise_tenon: () => [
    solid("leg_stock", 45),
    solid("rail_stock", 20),
    {
      op: "add_panel",
      id: "leg",
      name: "Leg",
      material: "leg_stock",
      thickness_axis: "x",
      grain_axis: "y",
      x: { start: { at: "0" } },
      y: { start: { at: "0" }, size: "450" },
      z: { start: { at: "0" }, size: "45" },
    },
    {
      op: "add_panel",
      id: "rail",
      name: "Rail",
      material: "rail_stock",
      thickness_axis: "z",
      grain_axis: "x",
      x: { start: { face: "leg.right" }, size: "300" },
      y: { start: { at: "340" }, size: "80" },
      z: { start: { face: "leg.back", offset: "12.5" } },
    },
    { op: "add_joint", id: "joint", type: "mortise_tenon", host: "leg", guest: "rail" },
  ],
  half_lap: () => [
    solid("stock", 20),
    {
      op: "add_panel",
      id: "rail",
      name: "Rail",
      material: "stock",
      thickness_axis: "y",
      grain_axis: "x",
      x: { start: { at: "0" }, size: "400" },
      y: { start: { at: "0" } },
      z: { start: { at: "0" }, size: "60" },
    },
    {
      op: "add_panel",
      id: "cross_rail",
      name: "Cross rail",
      material: "stock",
      thickness_axis: "y",
      grain_axis: "z",
      x: { start: { at: "170" }, size: "60" },
      y: { start: { at: "0" } },
      z: { start: { at: "-120" }, size: "300" },
    },
    { op: "add_joint", id: "joint", type: "half_lap", host: "rail", guest: "cross_rail" },
  ],
  box_joint: () => [
    ply("stock", 12),
    {
      op: "add_panel",
      id: "front",
      name: "Front",
      material: "stock",
      thickness_axis: "z",
      grain_axis: "x",
      x: { start: { at: "0" }, size: "250" },
      y: { start: { at: "0" }, size: "100" },
      z: { start: { at: "0" } },
    },
    {
      op: "add_panel",
      id: "side",
      name: "Side",
      material: "stock",
      thickness_axis: "x",
      grain_axis: "z",
      x: { start: { at: "0" } },
      y: { start: { at: "0" }, size: "100" },
      z: { start: { at: "0" }, size: "200" },
    },
    { op: "add_joint", id: "joint", type: "box_joint", host: "front", guest: "side" },
  ],
  through_slot: () => [
    solid("post_stock", 42),
    solid("bearer_stock", 28),
    {
      op: "add_panel",
      id: "post",
      name: "Post",
      material: "post_stock",
      thickness_axis: "z",
      grain_axis: "y",
      x: { start: { at: "0" }, size: "90" },
      y: { start: { at: "0" }, size: "600" },
      z: { start: { at: "129" } },
    },
    {
      op: "add_panel",
      id: "bearer",
      name: "Bearer",
      material: "bearer_stock",
      thickness_axis: "x",
      grain_axis: "z",
      x: { start: { at: "31" } },
      y: { start: { at: "400" }, size: "50" },
      z: { start: { at: "0" }, size: "300" },
    },
    { op: "add_joint", id: "joint", type: "through_slot", host: "post", guest: "bearer" },
  ],
  butt: () => fastened("butt"),
  screws: () => fastened("screws"),
  pocket_screws: () => fastened("pocket_screws"),
  dowels: () => fastened("dowels"),
};

/** A top sitting on a side, held by a fastener. */
function fastened(type: JointType): Op[] {
  return [
    solid("stock", 18),
    {
      op: "add_panel",
      id: "top",
      name: "Top",
      material: "stock",
      thickness_axis: "y",
      grain_axis: "x",
      x: { start: { at: "0" }, size: "300" },
      y: { start: { at: "300" } },
      z: { start: { at: "0" }, size: "180" },
    },
    {
      op: "add_panel",
      id: "side",
      name: "Side",
      material: "stock",
      thickness_axis: "x",
      grain_axis: "y",
      x: { start: { at: "0" } },
      y: { start: { at: "0" }, end: { face: "top.bottom" } },
      z: { start: { at: "0" }, size: "180" },
    },
    { op: "add_joint", id: "joint", type, host: "top", guest: "side" },
  ];
}

/** Two sample boards joined with this joint, as a design of their own. */
export function jointExample(type: JointType): Design {
  return applyOps(emptyDesign(`${JOINT_LIBRARY[type].name}, worked example`), LAYOUTS[type]());
}
