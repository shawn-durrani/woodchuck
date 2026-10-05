// The Shape section of a panel in the Edit tab: the cuts that shape its
// blank, each in workshop words with its problems, and buttons to add,
// change and remove them. A cut's fields take numbers, sums and @faces like
// a part's sizes. While you type, the change is worked out in the browser
// and drawn on the model as a ghost, with the cut's new words or the
// reason the design refuses it. Leaving a field or pressing Enter makes it
// as one undo step, and Esc puts it back. The logic is in shapeEdit.ts.

import { useDeferredValue, useEffect, useMemo, useState } from "react";
import type { DerivedPart, Face, Panel, PanelCut } from "@woodchuck/core";
import { applyOps, type ServerState } from "../api";
import { previewChange, type PreviewResult } from "../ghost";
import { PHONE_QUERY } from "../phone";
import {
  cutTitle,
  draftNote,
  edgeChoices,
  faceDrawing,
  fieldGroups,
  fieldsOf,
  fieldValue,
  NEW_CUT_WORDS,
  newCut,
  opOf,
  problemsFor,
  sameFields,
  shapeProblems,
  slopeFields,
  solvedCut,
  withField,
  type CutFields,
  type FieldGroup,
  type NewCut,
} from "../shapeEdit";
import { Field } from "./Field";

/** What the section works a change out against: the design, its parts and its checks as they are now. */
export type Now = Pick<ServerState, "design" | "derived" | "report">;

/** The line every new surface carries: what this is and why it matters. */
export const SHAPE_WHY = "Cuts shape the blank: slope an edge, cut a hole or a notch. The sizes above still mean the blank you cut from.";

const onPhone = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(PHONE_QUERY).matches;

export function ShapeSection({
  now,
  part,
  panel,
  canEdit,
  why = false,
  onDraft,
}: {
  now: Now;
  /** The part you picked, which may be an array copy. */
  part: DerivedPart;
  /** The design's panel it comes from. */
  panel: Panel;
  /** False for a copy, which shares its original's cuts. */
  canEdit: boolean;
  /** Shows how each cut's positions were worked out. */
  why?: boolean;
  /** Hears the change being typed, worked out, or null when there's none. */
  onDraft?: (r: PreviewResult | null) => void;
}) {
  const cuts = panel.cuts ?? [];
  // A phone keeps the section folded until the part has a cut, so the sizes stay in reach.
  const [open, setOpen] = useState(() => cuts.length > 0 || !onPhone());
  const [editing, setEditing] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);
  /** The last change the design refused, on the cut that made it, or on the section for an add. */
  const [error, setError] = useState<{ cut: string | null; text: string } | null>(null);
  const outcome = (cut: string | null, r: { ok: boolean; error?: string }) => {
    setError(r.ok ? null : { cut, text: r.error ?? "That change wasn't taken" });
    return r.ok;
  };
  const whole = shapeProblems(now.report.issues, panel);
  // A cut being edited that's gone, by undo or from elsewhere, closes its editor.
  const shown = editing && cuts.some((c) => c.id === editing) ? editing : null;

  const add = async (kind: NewCut) => {
    const { cut, op } = newCut(kind, panel, part);
    setChoosing(false);
    if (outcome(null, await applyOps([op], `Add ${NEW_CUT_WORDS[kind]} to ${panel.id}`))) {
      setEditing(cut);
      setOpen(true);
    }
  };
  const remove = async (cut: PanelCut) => {
    if (outcome(cut.id, await applyOps([{ op: "delete_cut", id: panel.id, cut: cut.id }], `Remove cut ${cut.id} from ${panel.id}`)) && shown === cut.id) setEditing(null);
  };

  return (
    <details className="shape-section" open={open} onToggle={(e) => setOpen(e.currentTarget.open)} data-place={`shape:${panel.id}`}>
      <summary>
        <span className="shape-title">Shape</span>{" "}
        <span className="muted small">{cuts.length ? `${cuts.length} cut${cuts.length === 1 ? "" : "s"}` : "the blank, uncut"}</span>
      </summary>
      <p className="muted small shape-why">{SHAPE_WHY}</p>
      {!canEdit && cuts.length > 0 && <p className="muted small">Copies share the first one's cuts, so change them there.</p>}
      {whole.map((i) => (
        <div key={i.key} className={`small ${i.severity === "error" ? "bad-text" : "warn-text"}`}>
          {i.message}
        </div>
      ))}
      {cuts.length > 0 && (
        <ul className="cut-rows">
          {cuts.map((cut) => {
            const solved = solvedCut(part, cut.id);
            const problems = problemsFor(now.report.issues, panel.id, cut.id);
            const isOpen = shown === cut.id;
            return (
              <li key={cut.id} className={`cut-row${isOpen ? " editing" : ""}`} data-place={`cut:${panel.id}.${cut.id}`}>
                <div className="cut-row-head">
                  <span className="cut-name">
                    <strong>{cutTitle(cut, part)}</strong> <code className="small">{cut.id}</code>
                  </span>
                  {canEdit && (
                    <span className="cut-actions">
                      <button aria-expanded={isOpen} onClick={() => setEditing(isOpen ? null : cut.id)}>
                        {isOpen ? "Done" : "Edit"}
                      </button>
                      <button className="danger" onClick={() => void remove(cut)}>
                        Remove
                      </button>
                    </span>
                  )}
                </div>
                <div className="cut-note">{solved?.text ?? "It takes no wood as it stands."}</div>
                {cut.note && <div className="muted small">{cut.note}</div>}
                {why && solved && <div className="trace">{solved.trace}</div>}
                {problems.map((i) => (
                  <div key={i.key} className={`small ${i.severity === "error" ? "bad-text" : "warn-text"}`}>
                    {i.message}
                  </div>
                ))}
                {error?.cut === cut.id && (
                  <div className="form-error field-error" role="alert">
                    {error.text}
                  </div>
                )}
                {isOpen && <CutEditor now={now} part={part} panel={panel} cut={cut} onDraft={onDraft} onResult={(r) => outcome(cut.id, r)} />}
              </li>
            );
          })}
        </ul>
      )}
      {canEdit && (
        <div className="shape-add">
          {choosing ? (
            <div className="hole-pick" role="group" aria-label="The hole's shape">
              <span className="muted small">A hole that's</span>
              <span className="hole-shapes">
                <button onClick={() => void add("round")}>Round</button>
                <button onClick={() => void add("rect")}>Rectangle</button>
                <button onClick={() => void add("slot")}>Slot</button>
              </span>
              <button className="link" onClick={() => setChoosing(false)}>
                Cancel
              </button>
            </div>
          ) : (
            <>
              <button title="Takes wood off one edge along a straight line, from full width at one end to two thirds at the other" onClick={() => void add("slope")}>
                Slope an edge
              </button>
              <button title="Cuts a round hole, a rectangle or a slot right through, centred to start" onClick={() => setChoosing(true)}>
                Cut a hole
              </button>
              <button title="Takes a corner out, 100 × 75 at the bottom front to start, as for a toe kick" onClick={() => void add("notch")}>
                Notch
              </button>
            </>
          )}
        </div>
      )}
      {error?.cut === null && (
        <div className="form-error field-error" role="alert">
          {error.text}
        </div>
      )}
    </details>
  );
}

/** One cut's fields, its face drawn small, and what a change would do while you type it. */
export function CutEditor({
  now,
  part,
  panel,
  cut,
  onDraft,
  onResult,
}: {
  now: Now;
  part: DerivedPart;
  panel: Panel;
  cut: PanelCut;
  onDraft?: (r: PreviewResult | null) => void;
  onResult: (r: { ok: boolean; error?: string }) => boolean;
}) {
  const fields = useMemo(() => fieldsOf(cut, panel), [cut, panel]);
  /** The box being typed in and its text, before it's made. */
  const [typing, setTyping] = useState<{ key: string; text: string } | null>(null);
  // Working a change out takes a moment on a big design, so typing never waits for it.
  const pending = useDeferredValue(typing);
  const result = useMemo(() => {
    if (!pending) return null;
    const next = withField(fields, pending.key, pending.text);
    return sameFields(next, fields) ? null : previewChange(now, [opOf(panel.id, cut.id, next)]);
  }, [pending, fields, now, panel.id, cut.id]);
  const fits = result && !("error" in result) ? result : null;
  useEffect(() => onDraft?.(fits), [fits, onDraft]);
  // The ghost goes with the editor.
  useEffect(() => () => onDraft?.(null), [onDraft]);

  const save = (key: string) => async (text: string) => onResult(await applyOps([opOf(panel.id, cut.id, withField(fields, key, text))], `Change cut ${cut.id} on ${panel.id}`));
  const draftFor = (key: string) => (text: string | null) => setTyping((t) => (text === null ? (t?.key === key ? null : t) : { key, text }));
  const setEdge = async (edge: Face) => {
    if (fields.kind !== "edge" || edge === fields.edge) return;
    const next: CutFields = { ...slopeFields(panel, part, edge), note: fields.note };
    onResult(await applyOps([opOf(panel.id, cut.id, next)], `Move cut ${cut.id} on ${panel.id} to the ${edge} edge`));
  };

  const groups = fieldGroups(panel, fields);
  const more = groups.filter((g) => g.more);
  const shownPart = fits?.after.parts.find((p) => p.id === part.id) ?? part;
  const drawing = faceDrawing(shownPart, { ...(fields.kind === "edge" ? { edge: fields.edge } : {}), cut: cut.id });
  const note = result ? draftNote(result, part.id, cut.id) : null;
  const group = (g: FieldGroup) => (
    <div key={g.title} className="cut-group">
      <div className="axis-head">{g.title}</div>
      <div className={`axis-fields fields-${g.fields.length}`}>
        {g.fields.map((s) => (
          <label key={s.key}>
            {s.label}
            <Field value={fieldValue(fields, s.key)} placeholder={s.placeholder} onSave={save(s.key)} onDraft={draftFor(s.key)} invalid={!!note?.error && typing?.key === s.key} />
          </label>
        ))}
      </div>
    </div>
  );

  return (
    <div className="cut-editor">
      <div className="cut-editor-top">
        <svg className="face-drawing" viewBox={`0 0 ${drawing.width} ${drawing.height}`} role="img" aria-label={`${part.name} seen face on, with its cuts`}>
          <path className="fd-blank" d={drawing.blank} />
          <path className="fd-wood" d={drawing.wood} fillRule="evenodd" />
          {drawing.hole && <path className="fd-hole" d={drawing.hole} />}
          {drawing.edges.map((e) => (
            <g key={e.face}>
              <line className={`fd-edge${e.on ? " on" : ""}`} x1={e.x1} y1={e.y1} x2={e.x2} y2={e.y2} />
              <text className={`fd-label${e.on ? " on" : ""}`} x={e.label.x} y={e.label.y} textAnchor={e.label.anchor}>
                {e.face}
              </text>
            </g>
          ))}
          {drawing.ends.map((p, i) => (
            <g key={i}>
              <circle className="fd-end" cx={p.x} cy={p.y} r={3} />
              <text className="fd-end-text" x={p.x + (p.anchor === "start" ? 5 : -5)} y={p.y + 13} textAnchor={p.anchor}>
                {p.text}
              </text>
            </g>
          ))}
        </svg>
        {fields.kind === "edge" && (
          <div className="edge-pick">
            <div className="axis-head">The edge it takes wood from</div>
            <div className="seg" role="radiogroup" aria-label="The edge it takes wood from">
              {edgeChoices(panel).map((f) => (
                <button key={f} role="radio" aria-checked={f === fields.edge} className={f === fields.edge ? "on" : ""} onClick={() => void setEdge(f)}>
                  {f}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
      {groups.filter((g) => !g.more).map(group)}
      {more.length > 0 && (
        <details className="cut-more" open={more.some((g) => g.fields.some((s) => fieldValue(fields, s.key) !== "")) || undefined}>
          <summary className="small">More</summary>
          {more.map(group)}
        </details>
      )}
      <div className="cut-readout" role="status" aria-live="polite">
        {note?.error ? (
          <div className="form-error">The design won't take that: {note.error}</div>
        ) : note ? (
          <>
            <div className="muted small">With this change</div>
            <div className="cut-note">{note.note ?? "It would take no wood."}</div>
            {note.problems.map((p) => (
              <div key={p.message} className={`small ${p.severity === "error" ? "bad-text" : "warn-text"}`}>
                {p.message}
              </div>
            ))}
          </>
        ) : (
          <div className="muted small">The model shows a change as you type it. Enter or leaving the box makes it, and Esc puts it back.</div>
        )}
      </div>
    </div>
  );
}
