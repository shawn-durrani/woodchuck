// The switch over the 3D view while Claude waits on a suggested change.
// Now shows the design as it is, with the change drawn over it as a ghost.
// With the change shows the design as it would be, with the changed parts
// outlined. Nothing is applied either way: Apply is in the waiting bar.

import type { Side } from "../ghost";

export function GhostSwitch({
  title,
  side,
  hidden,
  error,
  words,
  finishNote,
  onSide,
  onHide,
  onShow,
  onFinished,
}: {
  title: string;
  side: Side;
  hidden: boolean;
  /** Why the change no longer fits the design, if it doesn't. */
  error: string | null;
  /** What moves, such as "5 parts move up 40 mm". */
  words: string[];
  /** The change is to colours or timber, which only the Finished look shows. */
  finishNote: boolean;
  onSide: (s: Side) => void;
  onHide: () => void;
  onShow: () => void;
  onFinished: () => void;
}) {
  if (hidden) {
    return (
      <div className="ghost-switch put-away">
        <button title="Draw Claude's suggested change on the model again" onClick={onShow}>
          Show the suggested change
        </button>
      </div>
    );
  }
  return (
    <div className="ghost-switch" role="group" aria-label={`Claude's suggested change: ${title}`}>
      <div className="ghost-tag">
        <strong>{title}</strong>
        <span className="muted small">Suggested, not applied</span>
      </div>
      {error ? (
        <div className="form-error small">It no longer fits the design: {error}</div>
      ) : (
        <div className="ghost-controls">
          <div className="seg" role="radiogroup" aria-label="Which design the model shows">
            <button role="radio" aria-checked={side === "now"} className={side === "now" ? "on" : ""} title="The design as it is, with the change drawn over it" onClick={() => onSide("now")}>
              Now
            </button>
            <button role="radio" aria-checked={side === "after"} className={side === "after" ? "on" : ""} title="The design as it would be. Nothing is applied" onClick={() => onSide("after")}>
              With the change
            </button>
          </div>
          <button className="link small" title="Put the ghost away. The waiting bar still holds the change" onClick={onHide}>
            Hide
          </button>
        </div>
      )}
      {!error && side === "now" && words.length > 0 && <div className="ghost-words small">{words.join(" · ")}</div>}
      {!error && finishNote && (
        <div className="small">
          Colours show in the Finished look.{" "}
          <button className="link" onClick={onFinished}>
            Show the Finished look
          </button>
        </div>
      )}
    </div>
  );
}
