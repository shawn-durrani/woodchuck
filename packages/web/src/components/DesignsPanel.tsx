// The designs on the All designs and parts page: every design, starred
// ones first, each with when it last changed. A click opens one; the star
// marks it to find again.

import { useState } from "react";
import { post, type ServerState } from "../api";
import { WAIT_FOR_CLAUDE } from "../toolbar";

/** "3 minutes ago", "yesterday", "12 Sep": short enough for a list. */
export function whenChanged(iso: string | null, now = Date.now()): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  const mins = Math.round((now - t) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  return new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/** Starred designs first, then the most recently changed. */
export function ordered<T extends { starred: boolean; changed: string | null; name: string }>(designs: T[]): T[] {
  return [...designs].sort(
    (a, b) => Number(b.starred) - Number(a.starred) || (b.changed ?? "").localeCompare(a.changed ?? "") || a.name.localeCompare(b.name),
  );
}

export function StarButton({ slug, starred, busy }: { slug: string; starred: boolean; busy?: boolean }) {
  return (
    <button
      className={`star ${starred ? "on" : ""}`}
      disabled={busy}
      aria-pressed={starred}
      title={starred ? "Unstar this design" : "Star this design to find it again"}
      aria-label={starred ? "Unstar this design" : "Star this design"}
      onClick={() => void post("/api/projects/star", { slug, starred: !starred })}
    >
      {starred ? "★" : "☆"}
    </button>
  );
}

export function DesignsPanel({ state }: { state: ServerState }) {
  const [error, setError] = useState<string | null>(null);
  const designs = ordered(state.projects);
  const starredCount = designs.filter((d) => d.starred).length;
  return (
    <div className="designs-panel">
      <p className="muted small">
        {starredCount
          ? `${starredCount} starred. Starred designs come first here and in the design menu's Open list.`
          : "Star a design to keep it at the top of this list and the design menu's Open list."}
      </p>
      {error && <p className="form-error">{error}</p>}
      <ul className="design-list">
        {designs.map((d, i) => (
          <li key={d.slug} className={`${d.slug === state.project.slug ? "open" : ""} ${d.starred && designs[i + 1] && !designs[i + 1]!.starred ? "last-starred" : ""}`}>
            <StarButton slug={d.slug} starred={d.starred} />
            <button
              className="link design-open"
              disabled={state.busy || d.slug === state.project.slug}
              onClick={async () => {
                const r = await post("/api/projects/open", { slug: d.slug });
                setError(r.ok ? null : (r.error ?? "Couldn't open it"));
              }}
              title={d.slug === state.project.slug ? "This design is open" : state.busy ? WAIT_FOR_CLAUDE : `Open ${d.name}`}
            >
              {d.name}
            </button>
            <span className="muted small">{d.slug === state.project.slug ? "open now" : whenChanged(d.changed)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
