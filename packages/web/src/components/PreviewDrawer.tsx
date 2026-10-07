// The narrow drawer that slides out over the side of the 3D view. It shows
// an older change Claude suggested, drawn on a copy of the design as it is
// now, a worked example of a joint from the library on two sample boards,
// or one of the design's own joints in section, with its sizes and cuts.
// The change Claude is waiting on is drawn on the model itself instead.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  EXAMPLE_STOP_MM,
  JOINT_LIBRARY,
  JOINT_TYPES,
  canStop,
  cutList,
  derive,
  exampleStopEdge,
  jointExample,
  jointSection,
  jointSizes,
  sheetSvg,
  type Box,
  type Derived,
  type Design,
  type JointType,
} from "@woodchuck/core";
import { post, type ServerState } from "../api";
import { WAIT_FOR_CLAUDE } from "../toolbar";
import { partNamer } from "../names";
import { previewChange } from "../ghost";
import { ChangeLists } from "./ChangeLists";
import { Viewport, type Look, type ViewportApi } from "./Viewport";
import type { Lighting } from "./Lights";
import type { Drawer } from "../waiting";

export type { Drawer };

const noop = () => {};

/** A small 3D view of a design that isn't the open one. */
function MiniView({
  r,
  design,
  highlight,
  xray,
  fitKey,
  focus,
  look = "plain",
  lighting = "daylight",
}: {
  r: Pick<Derived, "parts" | "joints" | "hardware">;
  design: Pick<Design, "materials" | "finishes">;
  highlight: string[];
  xray: boolean;
  fitKey: string;
  focus?: Box;
  look?: Look;
  lighting?: Lighting;
}) {
  const api = useRef<ViewportApi | null>(null);
  return (
    <div className="drawer-view">
      <Viewport
        parts={r.parts}
        joints={r.joints}
        hardware={r.hardware}
        selection={[]}
        highlight={highlight}
        view="iso"
        xray={xray}
        fitKey={fitKey}
        mode="pick"
        pins={[]}
        apiRef={api}
        onSelect={noop}
        onPin={noop}
        design={design}
        look={look}
        lighting={lighting}
        faceMode={false}
        faces={[]}
        onFaces={noop}
        {...(focus ? { focus } : {})}
      />
    </div>
  );
}

function ChangePreview({ state, id, onClose, look: mainLook, lighting }: { state: ServerState; id: string; onClose: () => void; look: Look; lighting: Lighting }) {
  const item = state.chat.find((c) => c.kind === "preview" && c.id === id);
  const [side, setSide] = useState<"after" | "before">("after");
  const ops = item?.kind === "preview" ? item.ops : null;
  // The change, worked out against the design as it is now.
  const result = useMemo(() => (ops ? previewChange(state, ops) : null), [ops, state.design, state.derived, state.report]);
  const fits = !!result && !("error" in result);
  // A change of colour or timber only shows in the Finished look.
  const [look, setLook] = useState<Look>(fits && result.aboutFinish ? "finished" : mainLook);
  const [xray, setXray] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (item?.kind !== "preview") return <p className="muted">That preview is gone.</p>;
  // An older change applies straight onto the design as it is now.
  const applyAgain = async () => {
    setError(null);
    const r = await post("/api/previews/apply", { id: item.id });
    if (!r.ok) setError(r.error ?? "That didn't work");
    else onClose();
  };
  const alreadyIn = fits && result.changes.length === 0;
  const name = partNamer(state.derived.parts);

  return (
    <>
      <h3>{item.title}</h3>
      <p>{item.explanation}</p>
      <p className="muted small">
        {alreadyIn
          ? "This is already in your design."
          : item.status === "applied"
            ? "You applied this before, and the design has changed since. Here it is on the design as it is now."
            : item.status === "failed"
              ? `It couldn't be applied then (${item.error ?? "the design had changed"}). Here it is on the design as it is now.`
              : "You didn't apply this when Claude showed it. Here it is on the design as it is now."}
      </p>
      {result && "error" in result && <p className="form-error">This no longer fits the design as it is now: {result.error}</p>}
      {fits && (
        <>
          <div className="row drawer-controls">
            <div className="seg">
              <button className={side === "before" ? "on" : ""} onClick={() => setSide("before")}>
                Now
              </button>
              <button className={side === "after" ? "on" : ""} onClick={() => setSide("after")}>
                With the change
              </button>
            </div>
            <div className="seg">
              <button className={look === "plain" ? "on" : ""} onClick={() => setLook("plain")}>
                Plain
              </button>
              <button className={look === "finished" ? "on" : ""} onClick={() => setLook("finished")}>
                Finished
              </button>
            </div>
            <button className={xray ? "on toggle" : "toggle"} onClick={() => setXray(!xray)}>
              See-through
            </button>
          </div>
          <MiniView
            r={side === "after" ? result.after : state.derived}
            design={side === "after" ? result.proposed : state.design}
            highlight={[...result.changed, ...result.added]}
            xray={xray}
            fitKey={`preview:${item.id}`}
            look={look}
            lighting={lighting}
          />
          {result.changed.length + result.added.length > 0 && <p className="muted small">Parts that move or change size glow pink.</p>}
          <ChangeLists result={result} removed={result.removed.map(name)} />
        </>
      )}
      {error && <p className="form-error">{error}</p>}
      {fits && !alreadyIn && (
        <div className="row drawer-actions">
          <button className="primary" disabled={state.busy} title={state.busy ? WAIT_FOR_CLAUDE : undefined} onClick={() => void applyAgain()}>
            Apply
          </button>
          <span className="muted small">As one change you can undo. Claude hears about it.</span>
        </div>
      )}
    </>
  );
}

function JointExample({ joint, note, stopped: asked, onPick }: { joint: JointType; note?: string; stopped?: boolean; onPick: (t: JointType) => void }) {
  const [xray, setXray] = useState(true);
  // A housing that can stop is shown stopped short of an edge of its host.
  const [stopOn, setStopOn] = useState(!!asked);
  const stopped = stopOn && canStop(joint);
  const { design, r, cuts, focus } = useMemo(() => {
    const design = jointExample(joint, { stopped });
    const r = derive(design);
    const cuts = cutList(design, r).rows.flatMap((row) => row.machining.map((m) => `${row.name}: ${m}`));
    // Frame the joint itself, with a little of each board around it.
    const boxes = r.joints.flatMap((j) => j.features.flatMap((f) => (f.box ? [f.box] : f.from && f.to ? [{ min: f.from, max: f.to }] : [])));
    const min = [0, 1, 2].map((i) => Math.min(...boxes.flatMap((b) => [b.min[i]!, b.max[i]!])) - 90) as [number, number, number];
    const max = [0, 1, 2].map((i) => Math.max(...boxes.flatMap((b) => [b.min[i]!, b.max[i]!])) + 90) as [number, number, number];
    return { design, r, cuts, focus: boxes.length ? { min, max } : undefined };
  }, [joint, stopped]);
  const e = JOINT_LIBRARY[joint];
  return (
    <>
      <div className="row">
        <select value={joint} onChange={(ev) => onPick(ev.target.value as JointType)}>
          {JOINT_TYPES.map((t) => (
            <option key={t} value={t}>
              {JOINT_LIBRARY[t].name}
            </option>
          ))}
        </select>
        <button className={xray ? "on toggle" : "toggle"} onClick={() => setXray(!xray)}>
          See-through
        </button>
        {canStop(joint) && (
          <button className={stopped ? "on toggle" : "toggle"} onClick={() => setStopOn(!stopped)} title="Stop it short of an edge, so its end doesn't show there">
            Stopped
          </button>
        )}
      </div>
      {note && <p>{note}</p>}
      <MiniView r={r} design={design} highlight={[]} xray={xray} fitKey={`joint:${joint}${stopped ? ":stopped" : ""}`} {...(focus ? { focus } : {})} />
      {stopped && (
        <p className="small">
          Stopped {EXAMPLE_STOP_MM} mm short of the {exampleStopEdge(joint)}, so that edge shows no slot. The other board keeps its size, and its corner there is notched to match.
        </p>
      )}
      <p className="muted small">Two sample boards, built with the same tools as your design. Tongues show in the board's colour, cut-outs in red, fixings as rods.</p>
      <p>{e.summary}</p>
      <dl className="small joint-facts">
        <dt>Use it when</dt>
        <dd>{e.use_when}</dd>
        <dt>Avoid it when</dt>
        <dd>{e.avoid_when}</dd>
        <dt>Strength</dt>
        <dd>{e.strength}</dd>
        <dt>Tools</dt>
        <dd>
          {e.tools.join(", ")}
          {e.home_workshop ? "" : ". Beyond a standard home workshop"}
        </dd>
        <dt>Sizes</dt>
        <dd>{e.changes_sizes}</dd>
      </dl>
      {cuts.length > 0 && (
        <>
          <h4>Cuts in this example</h4>
          <ul className="small">
            {cuts.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

/**
 * One of the design's own joints: two cuts through it, at true scale, with
 * its settings and the cuts each part needs, as the cut list words them.
 */
function OwnJoint({ state, id }: { state: ServerState; id: string }) {
  const section = useMemo(() => jointSection(state.derived, id), [state.derived, id]);
  const sizes = useMemo(() => jointSizes(state.derived, id), [state.derived, id]);
  const names = useMemo(() => partNamer(state.derived.parts), [state.derived.parts]);
  const svg = useMemo(
    () =>
      section
        ? sheetSvg({ kind: "part", title: section.title, paper: "A4", width_mm: section.width_mm, height_mm: section.height_mm, scale: null, marks: section.marks, dims: section.dims })
        : null,
    [section],
  );
  // The drawing on its own, to zoom in on or print. Its sizes are in millimetres, so it prints at true scale.
  const [full, setFull] = useState<string | null>(null);
  useEffect(() => {
    if (!svg) return setFull(null);
    const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    setFull(url);
    return () => URL.revokeObjectURL(url);
  }, [svg]);
  const j = state.derived.joints.find((x) => x.id === id);
  if (!j || !sizes) return <p className="muted">That joint isn't in the design any more.</p>;
  return (
    <>
      <h3>{JOINT_LIBRARY[j.type].name}</h3>
      <p className="small muted">
        {names(j.guest)} into {names(j.host)} <code>{id}</code>
      </p>
      {svg && section ? (
        <>
          <div className="joint-section" role="img" aria-label={`${section.title}, cut through`} dangerouslySetInnerHTML={{ __html: svg }} />
          <p className="muted small">
            Cut through the joint at {section.scales.map((n) => `1:${n}`).join(" and ")}. Hatching is wood the cut passes through, white is wood cut away, and
            grey is a fixing.{" "}
            {full && (
              <a href={full} target="_blank" rel="noopener" title="The drawing on its own. Printed at 100%, it's true to scale">
                Open full size
              </a>
            )}
          </p>
        </>
      ) : (
        <p className="small muted">This joint can't be cut through yet, since it isn't placed.</p>
      )}
      <h4>Sizes</h4>
      <dl className="small joint-facts">
        {sizes.settings.map((x) => (
          <div key={x.name} className="joint-size">
            <dt>{x.name}</dt>
            <dd>
              {x.value}
              {x.usual ? " (usual)" : ""}
            </dd>
          </div>
        ))}
        {sizes.stopped && (
          <div className="joint-size">
            <dt>Stopped</dt>
            <dd>{sizes.stopped}</dd>
          </div>
        )}
      </dl>
      <h4>Cuts</h4>
      {sizes.cuts.length ? (
        sizes.cuts.map((c) => (
          <div key={c.part} className="small">
            <strong>{names(c.part)}</strong> <code>{c.part}</code>
            <ul>
              {c.lines.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          </div>
        ))
      ) : (
        <p className="small muted">Nothing to cut. The parts just meet.</p>
      )}
    </>
  );
}

export function PreviewDrawer({
  state,
  drawer,
  onClose,
  onOpen,
  look,
  lighting,
  paired = false,
}: {
  state: ServerState;
  drawer: Drawer;
  onClose: () => void;
  onOpen: (d: Drawer) => void;
  /** The main view's look and lighting, which a preview starts from. */
  look: Look;
  lighting: Lighting;
  /** A suggested change and a worked example are both open, side by side. */
  paired?: boolean;
}) {
  return (
    <aside
      className={`drawer slot-${drawer.kind}${paired ? " paired" : ""}`}
      aria-label={drawer.kind === "preview" ? "Preview of a suggested change" : drawer.kind === "joint" ? "A joint in section, with its sizes" : "Worked joint example"}
    >
      <header className="drawer-head">
        <span className="muted small">{drawer.kind === "preview" ? "Suggested change" : drawer.kind === "joint" ? "Section and sizes" : "Worked example"}</span>
        <button className="link" onClick={onClose} title="Close">
          Close
        </button>
      </header>
      <div className="drawer-body">
        {drawer.kind === "preview" ? (
          <ChangePreview state={state} id={drawer.id} onClose={onClose} look={look} lighting={lighting} />
        ) : drawer.kind === "joint" ? (
          <OwnJoint state={state} id={drawer.id} />
        ) : (
          <JointExample
            key={drawer.stopped ? "stopped" : "plain"}
            joint={drawer.joint}
            {...(drawer.note ? { note: drawer.note } : {})}
            {...(drawer.stopped ? { stopped: true } : {})}
            onPick={(t) => onOpen({ kind: "example", joint: t })}
          />
        )}
      </div>
    </aside>
  );
}
