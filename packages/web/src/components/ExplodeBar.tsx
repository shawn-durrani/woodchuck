// The bar over the 3D view while Explode is on. Its slider runs from the
// piece together to fully apart, and the stages take turns along it, so
// dragging it back watches the piece go together in order. With one joint
// pulled apart, it names the joint and what holds it, and Whole piece goes
// back to the lot. It also says when some parts can't come apart in a
// straight line, so they pass through each other on the way apart.

import { useRef } from "react";

export interface ExplodeBarJoint {
  /** Such as "Mortise and tenon: Front rail into Leg". */
  title: string;
  /** Parts the moving one passes through, by name, because they hold it too. */
  passes: string[];
  /** The part that moves, by name. */
  mover: string;
}

export function ExplodeBar({
  amount,
  stages,
  joint,
  locked,
  onAmount,
  onWholePiece,
  onClose,
}: {
  amount: number;
  /** How many stages the piece comes apart in. */
  stages: number;
  /** One joint pulled apart on its own, or null for the whole piece. */
  joint: ExplodeBarJoint | null;
  /** Sets of parts, by name, whose joints hold each other every way, so they pass through each other on the way apart. */
  locked: string[][];
  onAmount: (amount: number) => void;
  onWholePiece: () => void;
  onClose: () => void;
}) {
  // While the slider is held, the view waits to frame the piece again until it's let go.
  const held = useRef(false);
  const hold = (on: boolean) => {
    if (held.current === on) return;
    held.current = on;
    document.body.classList.toggle("dragging", on);
  };
  return (
    <div className="explode-bar" role="group" aria-label={joint ? `${joint.title}, pulled apart` : "The piece pulled apart"}>
      <div className="explode-head">
        {joint ? (
          <>
            <strong>{joint.title}</strong>
            <button className="link small" title="Pull the whole piece apart instead" onClick={onWholePiece}>
              Whole piece
            </button>
          </>
        ) : (
          <span className="small">
            <strong>Exploded</strong>{" "}
            <span className="muted">
              {stages > 1 ? `In ${stages} stages, the last part on first off.` : "Each part off the way it goes on."}
            </span>
          </span>
        )}
        <button className="link explode-close" title="Put it back together (E)" aria-label="Put it back together" onClick={onClose}>
          ×
        </button>
      </div>
      <label className="explode-slider">
        <span className="small muted">Together</span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.005}
          value={amount}
          aria-label="How far apart"
          onPointerDown={() => hold(true)}
          onPointerUp={() => hold(false)}
          onPointerCancel={() => hold(false)}
          onBlur={() => hold(false)}
          onChange={(e) => onAmount(Number(e.target.value))}
        />
        <span className="small muted">Apart</span>
      </label>
      {joint && joint.passes.length > 0 && (
        <div className="small muted">
          Shown on its own. In the piece, {joint.passes.join(" and ")} {joint.passes.length > 1 ? "hold" : "holds"} {joint.mover} too, so this joint comes apart once{" "}
          {joint.passes.length > 1 ? "they're" : "that's"} off.
        </div>
      )}
      {!joint &&
        locked.map((set) => (
          <div key={set.join(",")} className="small warn-text">
            {set.join(", ")} can't slide apart in a straight line, so here they pass through each other on the way apart.
          </div>
        ))}
    </div>
  );
}
