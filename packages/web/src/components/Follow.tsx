// What following Claude shows: the "Following Claude · stop" chip over the
// 3D view, the caption at the top of the side panel's tab, and the
// per-browser setting beside Theme. useFollow.ts drives them.

import type { StopView } from "../following";

/** The chip over the 3D view while the screen follows Claude, or plays Show me how. Its stop is the one click that doesn't count as a touch. */
export function FollowChip({ mode, onStop }: { mode: "live" | "replay" | null; onStop: () => void }) {
  if (!mode) return null;
  return (
    <div className="follow-chip" role="status" data-follow-stop>
      <span className="follow-dot" aria-hidden="true" />
      {mode === "replay" ? "Showing how Claude did it" : "Following Claude"} ·{" "}
      <button type="button" className="link" title={mode === "replay" ? "Stop showing the steps" : "Stop following. Claude keeps working."} onClick={onStop}>
        stop
      </button>
    </div>
  );
}

/** At the top of the tab: what Claude just did there, such as "Claude set Seat height in Sizes". */
export function FollowCaption({ view }: { view: Pick<StopView, "caption" | "more"> | null }) {
  if (!view) return null;
  return (
    <div className="follow-caption" role="status">
      <span className="follow-dot" aria-hidden="true" />
      <span className="follow-words">{view.caption}</span>
      {view.more > 0 && <span className="follow-more">{`and ${view.more} more`}</span>}
    </div>
  );
}

/** "Follow Claude while it works", kept in this browser. */
export function FollowSwitch({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  return (
    <label
      className="follow-switch small muted"
      title="While Claude works, the side panel opens where it's working and lights the control it used. Touching anything stops it until Claude's next turn. Kept in this browser."
    >
      <input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked)} />
      Follow Claude<span className="follow-long"> while it works</span>
    </label>
  );
}
