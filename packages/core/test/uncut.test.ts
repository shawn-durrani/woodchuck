// A design with no cuts derives exactly as it did before cuts existed. The
// digests below are SHA-256 of the JSON that derive and the cut list gave
// for each example on main before shapes were added. A change that means to
// alter what these examples derive updates them in the same pull request,
// and one that doesn't must leave them alone.

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { applyOp, applyOps, cutList, derive, emptyDesign, jointExample, recordConsoleOps, toPlain, type Design, type JointType } from "../src/index.js";

const sha = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");

/** [derive, cut list] for each example. */
const BEFORE_CUTS: Record<string, [string, string]> = {
  "record console": ["f3d9ff7aa6537ac1f8130b9580dd30d546cb9f49a6c4f52561a1b423ba824730", "735eba2cf6831f4d1df4b676f433ba5d4afc90054fb89d227129c10ee4fcb85d"],
  butt: ["9fc9e407b0a83eb245d6730ff47c16e0d9a0ac8da37f45b705fff15bdb373b73", "3cd9539d64341570588caf8047afae57115d71938775e179a9d7def801e60374"],
  screws: ["24c880a9a0d91f844b47fea029d49aadd17be7fd98334c398277c9aadd2e2516", "948dd9db82ae310533d90448517e410e913d40746e58718c1ffcf5dfc9579ed0"],
  pocket_screws: ["64402961113a4a832ce27618e16a351abd5a6bc975ae76603c8b2f6c250d41f8", "fa43849cea8f3af97c28435a96f25f12c78d9c0cc059071c58e7e0b22b627a4a"],
  dowels: ["8d40f00552fc22cbce7b16b2d1b66073d1b21762dadd5a3ac508bd5b94725f26", "b464684f991ba9f7f84c3266927226512243dce6b40af48b94f7187c9b7b3f1f"],
  dado: ["124414c526ffa8be6361a128cc9effe88a3ff4a6b0f5c9a71d42cb2b375bfa1f", "2309a1fc5de3239d29da84d1ce74f8981b2af7727296bbf2e4d856388d17bd16"],
  groove: ["6ec0c5a53b49aa71fa59c12d952502e053ff34b4a559bb5a406101a588260309", "4616c4f4dd643c164611a09984eaba3cafd6778929c95b97b9278d2963bf1af1"],
  rabbet: ["11db3754b7abd3f66157be5c75da23ae7d244a0e3e434ee450ff5a5b50018857", "58a2275236f7e04ff4408692cbc5cac4e0d941a21a133e022a4715425106fb67"],
  tongue: ["6b64b854645edaac3b0b3d570fef73efc2b3ca9e48acd87b2066882c0af92044", "648d729cf519860d424ff09e5e9e7b8054a4c21d76f9a0d16050f420eae133bc"],
  mortise_tenon: ["a78e580dbace3d3e1353e7a3cfbc373b77c9dd0900a5873fa8af702e444ba382", "61fe2b3af0d178893235fffd1fc82cf6b0c7d769e04f881facb42cc816999cd8"],
  half_lap: ["cc17fce149e29f4fb9efe22e69f32c085e6b0aea9a9c5996388268b07c8b5481", "b5c156e34446cf69ccbb216c2579b5795dcc8897b6275aa13e3614e367d3b154"],
  box_joint: ["d8ae3c03621ea757936ab6f267fef8ededf72aeb4de2337e44be1be09f4062ca", "6675b2be2e692a8c502c83d823e556156ca7c7b08662f442328de6edff7078c0"],
  through_slot: ["6a6f922db9801020384c41cd57e5335b4c0107b5222a7f78c2c37e2004c8189a", "dc6a0f7ece55947e9ca6553e3ac4d862c69f9e9dcca3da502bb65837f00241f8"],
};

const designFor = (name: string): Design =>
  name === "record console" ? applyOps(emptyDesign("test"), recordConsoleOps()) : jointExample(name as JointType);

describe("designs with no cuts", () => {
  it.each(Object.keys(BEFORE_CUTS))("derive the %s example exactly as before cuts existed", (name) => {
    const d = designFor(name);
    const r = derive(d);
    expect([sha(toPlain(r)), sha(cutList(d, r))]).toEqual(BEFORE_CUTS[name]);
  });

  it("derive the same with an empty list of cuts, or a cut made and taken off", () => {
    const d = designFor("record console");
    const plain = JSON.stringify(toPlain(derive(d)));
    const empty: Design = { ...d, parts: d.parts.map((p) => ({ ...p, cuts: [] })) };
    expect(JSON.stringify(toPlain(derive(empty)))).toBe(plain);
    const undone = applyOps(d, [
      { op: "set_edge_cut", id: "drawer_side_l", cut: "slope", edge: "top", start: { face: "drawer_side_l.top" }, end: { face: "drawer_side_l.top", offset: "-60" } },
      { op: "delete_cut", id: "drawer_side_l", cut: "slope" },
    ]);
    expect(undone).toEqual(d);
  });

  it("change nothing but the cut part when one part gets a cut", () => {
    const d = designFor("record console");
    const before = toPlain(derive(d));
    const cut = applyOp(d, {
      op: "set_edge_cut",
      id: "partition",
      cut: "chamfer",
      edge: "front",
      start: { face: "partition.front" },
      start_along: { face: "partition.top", offset: "-20" },
      end: { face: "partition.front", offset: "-20" },
    });
    const after = toPlain(derive(cut));
    const changed = after.parts.filter((p, i) => JSON.stringify(p) !== JSON.stringify(before.parts[i])).map((p) => p.id);
    expect(changed).toEqual(["partition", "partition#2", "partition#3", "partition#4"]);
    expect(after.parts.map(({ profile: _, ...p }) => p)).toEqual(before.parts);
    expect(after.issues).toEqual(before.issues);
  });
});
