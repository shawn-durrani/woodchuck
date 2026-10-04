// The parts library, on the All designs and parts page: every part you've
// approved, searchable by name, kind and maker, with its specs, its sources
// and the designs that use it. A part still waiting for its pull request
// shows where that has got to.

import { useEffect, useState } from "react";
import { PART_KINDS, type LibraryPart } from "@woodchuck/core";
import { post, type PullRequestStatus, type ServerState } from "../api";
import { WAIT_FOR_CLAUDE } from "../toolbar";
import { canRemove, pullRequestBadge, pullRequestNote, retryLabel } from "../partShare";
import { PartCard } from "./PartCard";

interface Listed {
  part: LibraryPart;
  pending?: PullRequestStatus;
  used_by: { slug: string; name: string }[];
}

/** Where a part's pull request has got to, with a link to it and a way to try again. A closed one can also be removed. */
export function PullRequestNote({ id, pr, repo }: { id: string; pr: PullRequestStatus; repo: string | null }) {
  const note = pullRequestNote(pr, repo);
  const [busy, setBusy] = useState<"retry" | "remove" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ask = async (what: "retry" | "remove") => {
    setBusy(what);
    const r = await post(`/api/library/${what}`, { id });
    setBusy(null);
    setError(r.ok ? null : (r.error ?? (what === "retry" ? "Couldn't try again" : "Couldn't remove it")));
  };
  return (
    <div className={`pr-note small ${note.retry ? "waiting" : ""} ${pr.state === "closed" ? "closed" : ""}`}>
      {note.text}{" "}
      {pr.url && (
        <a href={pr.url} target="_blank" rel="noreferrer noopener">
          View it on GitHub
        </a>
      )}{" "}
      <span className="pr-actions">
        {note.retry && (
          <button disabled={busy !== null} onClick={() => ask("retry")}>
            {busy === "retry" ? "Trying…" : retryLabel(pr)}
          </button>
        )}
        {canRemove(pr) && (
          <button
            className="danger"
            disabled={busy !== null}
            onClick={() => {
              if (confirm("Remove this part from the library? Designs that use it keep their own copy of its specs.")) void ask("remove");
            }}
          >
            {busy === "remove" ? "Removing…" : "Remove from library"}
          </button>
        )}
      </span>
      {error && <div className="form-error">{error}</div>}
    </div>
  );
}

/** What the chat's part card says once a part is approved. */
export function ApprovedPartStatus({ library, id, repo }: { library: ServerState["library"]; id: string; repo: string | null }) {
  const pr = library.pending[id];
  if (pr) return <PullRequestNote id={id} pr={pr} repo={repo} />;
  if (library.parts.some((p) => p.id === id)) return <div className="muted small">In the library, and shared in the repo.</div>;
  return <div className="muted small">Removed from the library.</div>;
}

export function LibraryPanel({ state }: { state: ServerState }) {
  const { proposals, broken, pending } = state.library;
  const [q, setQ] = useState("");
  const [kind, setKind] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [listing, setListing] = useState<{ total: number; parts: Listed[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Ask again when a part, a pull request or any design has changed.
  const stamp = JSON.stringify([state.library.parts.map((p) => p.id), pending, state.projects.map((p) => [p.slug, p.changed])]);

  useEffect(() => {
    let live = true;
    const timer = setTimeout(
      async () => {
        try {
          const r = await fetch(`/api/library?${new URLSearchParams({ q, kind })}`);
          const body = (await r.json()) as { total: number; parts: Listed[]; error?: string };
          if (!live) return;
          if (r.ok) setListing(body);
          setError(r.ok ? null : (body.error ?? "Couldn't load the library"));
        } catch {
          if (live) setError("Couldn't load the library");
        }
      },
      q ? 150 : 0,
    );
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [q, kind, stamp]);

  return (
    <div className="library-panel">
      <p className="muted small">
        Real parts Claude has researched and you've approved. An approved part works in every design at once, and the app opens a pull request that adds it
        to library/parts, so it's shared. To add one, tell Claude the part, paste a link, or attach its spec sheet.
      </p>
      {broken.map((b) => (
        <div key={`${b.pending ? "pending" : "library"}/${b.file}`} className="issue error">
          {b.pending ? `The approved part ${b.file} in the data folder` : `library/parts/${b.file}`} can't be read: {b.error}
        </div>
      ))}
      {proposals.length > 0 && <div className="card-sub">Waiting for you in the chat</div>}
      {proposals.map((p) => (
        <PartCard key={p.id} part={p.part} />
      ))}
      <div className="card-sub">In the library{listing ? ` (${listing.total})` : ""}</div>
      {listing && listing.total > 0 && (
        <div className="library-search">
          <input type="search" placeholder="Search by name, kind or maker" aria-label="Search parts" value={q} onChange={(e) => setQ(e.target.value)} />
          <select aria-label="Kind of part" value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">All kinds</option>
            {PART_KINDS.map((k) => (
              <option key={k} value={k}>
                {k.replace(/_/g, " ")}
              </option>
            ))}
          </select>
        </div>
      )}
      {error && <div className="form-error">{error}</div>}
      {listing && listing.parts.length === 0 && <div className="empty">{listing.total === 0 ? "No parts yet." : "No parts match."}</div>}
      <ul className="library-list">
        {listing?.parts.map(({ part, used_by }) => {
          const pr = pending[part.id];
          return (
            <li key={part.id}>
              <button className="library-row" aria-expanded={open === part.id} onClick={() => setOpen(open === part.id ? null : part.id)}>
                <span className="library-name">{part.name}</span>
                <span className="muted small">{[part.kind.replace(/_/g, " "), part.maker].filter(Boolean).join(" · ")}</span>
                {pr && <span className="badge warn">{pullRequestBadge(pr, state.repo)}</span>}
                {used_by.length > 0 && <span className="badge">{`in ${used_by.length} design${used_by.length === 1 ? "" : "s"}`}</span>}
              </button>
              {open === part.id && (
                <PartCard part={part}>
                  {pr && <PullRequestNote id={part.id} pr={pr} repo={state.repo} />}
                  <div className="card-sub">Designs that use it</div>
                  {used_by.length === 0 ? (
                    <p className="small muted">None yet. Ask Claude to fit it by its id, {part.id}.</p>
                  ) : (
                    <ul className="small">
                      {used_by.map((d) => (
                        <li key={d.slug}>
                          <button
                            className="link"
                            disabled={state.busy || d.slug === state.project.slug}
                            title={d.slug === state.project.slug ? "This design is open" : state.busy ? WAIT_FOR_CLAUDE : `Open ${d.name}`}
                            onClick={async () => {
                              const r = await post("/api/projects/open", { slug: d.slug });
                              setError(r.ok ? null : (r.error ?? "Couldn't open it"));
                            }}
                          >
                            {d.name}
                          </button>
                          {d.slug === state.project.slug && <span className="muted"> open now</span>}
                        </li>
                      ))}
                    </ul>
                  )}
                </PartCard>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
