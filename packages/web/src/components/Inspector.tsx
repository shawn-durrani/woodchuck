// The selected part: its sizes, how each one is worked out, and fields to
// change where it starts, ends or how big it is. A panel's Shape section
// below them holds its cuts.
//
// A bound is typed as an expression ("450"), or as a face starting with @
// ("@left_side.right + 2").

import { useState } from "react";
import {
  fmt,
  JOINT_LIBRARY,
  machiningText,
  type Axis,
  type AxisSpec,
  type DerivedJoint,
  type DerivedPart,
  type Design,
  type JointType,
  type Panel,
} from "@woodchuck/core";
import { applyOps } from "../api";
import { boundText, parseBound } from "../bounds";
import type { PreviewResult } from "../ghost";
import { editAllLabel, partNamer, plural } from "../names";
import { Field } from "./Field";
import { ShapeSection, type Now } from "./ShapeSection";

const AXES: Axis[] = ["x", "y", "z"];
const AXIS_LABEL: Record<Axis, string> = { x: "x (left → right)", y: "y (floor ↑)", z: "z (back → front)" };

export function Inspector({
  design,
  parts,
  joints,
  selection,
  onShowJoint,
  onSelect,
  now,
  onDraft,
}: {
  design: Design;
  parts: DerivedPart[];
  joints: DerivedJoint[];
  selection: string[];
  /** Opens a worked example of a joint beside the model. */
  onShowJoint: (type: JointType) => void;
  /** Picks other parts, such as an array's original to edit every copy. */
  onSelect: (ids: string[]) => void;
  /** The design with its parts and checks, which a change to a cut is worked out against. */
  now?: Now;
  /** Hears a change to a cut while you type it, so the model can draw it. */
  onDraft?: (r: PreviewResult | null) => void;
}) {
  /** The last refused change, on the part and field that made it, such as "x.end" or "delete". */
  const [error, setError] = useState<{ part: string; field: string; text: string } | null>(null);
  const [why, setWhy] = useState(false);
  if (selection.length === 0) return <div className="empty">Click a part in the 3D view to see and change it.</div>;
  if (selection.length > 1) {
    const name = partNamer(parts);
    return (
      <div className="inspector">
        <p>{selection.length} parts selected. Ask Claude about them, or pick one to edit.</p>
        <ul>
          {selection.map((s) => (
            <li key={s} title={s}>
              {name(s)}
            </li>
          ))}
        </ul>
      </div>
    );
  }
  const d = parts.find((p) => p.id === selection[0]);
  if (!d) return <div className="empty">That part no longer exists.</div>;
  const panel: Panel | undefined = design.parts.find((p) => p.id === d.source);
  const material = design.materials.find((m) => m.id === d.material);
  const isCopy = d.copy > 1;
  const canEdit = !!panel && !isCopy;
  // An array's copies follow its original, so a copy offers to edit them all.
  const editAll = editAllLabel(d, parts);
  const copies = parts.filter((p) => p.source === d.source).length;

  const errorAt = (field: string) =>
    error?.part === d.id && error.field === field ? (
      <div className="form-error field-error" role="alert">
        {error.text}
      </div>
    ) : null;
  // Records how a change went, against the field that made it. A success clears that field's error.
  const outcome = (field: string, r: { ok: boolean; error?: string }) => {
    if (r.ok) setError((e) => (e?.part === d.id && e.field === field ? null : e));
    else setError({ part: d.id, field, text: r.error ?? "That change wasn't taken" });
    return r.ok;
  };

  const saveAxis = async (a: Axis, field: keyof AxisSpec, text: string): Promise<boolean> => {
    if (!panel) return false;
    const spec: AxisSpec = { ...panel[a] };
    if (field === "size") {
      if (text.trim()) spec.size = text.trim();
      else delete spec.size;
    } else {
      const b = parseBound(text);
      if (b) spec[field] = b;
      else delete spec[field];
    }
    const r = await applyOps([{ op: "update_panel", id: panel.id, [a]: spec }], `Change ${panel.id} ${a}`);
    return outcome(`${a}.${field}`, r);
  };

  const dims = (x: { length: number; width: number; thickness: number }) => `${fmt(x.length)} × ${fmt(x.width)} × ${fmt(x.thickness)}`;

  return (
    <div className="inspector">
      <div className="part-head">
        <strong>{d.name}</strong> <code>{d.id}</code>
        {d.unverified && <span className="badge warn">unverified</span>}
        {d.decor && <span className="badge">decor</span>}
      </div>
      <div className="muted">
        {material?.name ?? d.material}
        {d.tags.length > 0 && ` · ${d.tags.join(", ")}`}
      </div>
      <table className="kv">
        <tbody>
          <tr>
            <th>Finished</th>
            <td>{dims(d.finished)} mm</td>
          </tr>
          <tr>
            <th>Cut</th>
            <td>
              {dims(d.cut)} mm {d.extensions.length > 0 && <span className="muted">(includes joinery)</span>}
            </td>
          </tr>
        </tbody>
      </table>
      {isCopy && (
        <div className="array-copy">
          <p className="muted">
            This is copy {d.copy} of {copies}, so its sizes follow the first one.
          </p>
          {editAll && (
            <button className="primary" title={`Selects ${d.source}, the first one, where a change goes to every copy`} onClick={() => onSelect([d.source])}>
              {editAll}
            </button>
          )}
        </div>
      )}
      {!isCopy && copies > 1 && <p className="muted small">A change here goes to all {copies} {plural(d.name)}.</p>}
      {panel &&
        AXES.map((a) => {
          const t = d.axes[a];
          const thick = panel.thickness_axis === a;
          return (
            <div key={a} className="axis">
              <div className="axis-head">
                {AXIS_LABEL[a]}
                {a === panel.grain_axis && <span className="badge">grain</span>}
                {thick && <span className="badge">thickness</span>}
                <span className="muted">
                  {" "}
                  {fmt(t.start.value)} → {fmt(t.end.value)}
                </span>
              </div>
              <div className="axis-fields">
                <label>
                  start
                  <Field value={boundText(panel[a].start)} disabled={!canEdit} invalid={!!errorAt(`${a}.start`)} onSave={(v) => saveAxis(a, "start", v)} />
                </label>
                <label>
                  end
                  <Field value={boundText(panel[a].end)} disabled={!canEdit} invalid={!!errorAt(`${a}.end`)} onSave={(v) => saveAxis(a, "end", v)} />
                </label>
                <label>
                  size
                  <Field
                    value={thick ? `${fmt(t.size.value)} (material)` : (panel[a].size ?? "")}
                    disabled={!canEdit || thick}
                    invalid={!!errorAt(`${a}.size`)}
                    onSave={(v) => saveAxis(a, "size", v)}
                  />
                </label>
              </div>
              {errorAt(`${a}.start`)}
              {errorAt(`${a}.end`)}
              {errorAt(`${a}.size`)}
              {why && (
                <div className="trace">
                  <div>start = {t.start.text}</div>
                  <div>end = {t.end.text}</div>
                  <div>size = {t.size.text}</div>
                </div>
              )}
            </div>
          );
        })}
      <div className="row">
        <button className="link" onClick={() => setWhy(!why)}>
          {why ? "Hide the working" : "Show the working"}
        </button>
        {canEdit && (
          <button
            className="danger"
            onClick={async () => outcome("delete", await applyOps([{ op: "delete_part", id: d.id }], `Delete ${d.id}`))}
          >
            Delete part
          </button>
        )}
      </div>
      {errorAt("delete")}
      {panel && now && <ShapeSection key={panel.id} now={now} part={d} panel={panel} canEdit={canEdit} why={why} onDraft={onDraft} />}
      {d.extensions.length > 0 && (
        <>
          <div className="card-sub">Joinery adds</div>
          <ul>
            {d.extensions.map((e) => (
              <li key={e.joint}>
                {fmt(e.depth_mm)} mm into {e.host} ({e.joint})
              </li>
            ))}
          </ul>
        </>
      )}
      {d.machining.length > 0 && (
        <>
          <div className="card-sub">Machining on this part</div>
          <ul>
            {d.machining.map((m) => (
              <li key={m.joint + m.label}>{machiningText(m)}</li>
            ))}
          </ul>
        </>
      )}
      {joints.filter((j) => j.host === d.id || j.guest === d.id).length > 0 && (
        <>
          <div className="card-sub">Joints</div>
          {joints
            .filter((j) => j.host === d.id || j.guest === d.id)
            .map((j) => {
              const entry = JOINT_LIBRARY[j.type];
              const other = j.host === d.id ? j.guest : j.host;
              const params = Object.entries(j.params).filter(([k]) => k !== "fit" || j.params.fit);
              return (
                <div key={j.id} className="joint-card" data-place={`joint:${j.id}`}>
                  <div>
                    <strong>{entry.name}</strong> with <code>{other}</code> <span className="muted small">({j.id})</span>{" "}
                    <button className="link small" onClick={() => onShowJoint(j.type)} title="See a worked example of this joint">
                      what's this?
                    </button>
                  </div>
                  {params.length > 0 && (
                    <div className="small">
                      {params
                        .map(([k, v]) => `${k} ${fmt(v as number)}${j.defaulted.includes(k as never) ? " (usual)" : ""}`)
                        .join(" · ")}
                    </div>
                  )}
                  <div className="small muted">{entry.use_when}</div>
                  {j.problems.map((p) => (
                    <div key={p.message} className={`small ${p.severity === "error" ? "bad-text" : "warn-text"}`}>
                      {p.message}
                    </div>
                  ))}
                </div>
              );
            })}
          <p className="muted small">Turn on See-through to see these joints in the model.</p>
        </>
      )}
      <p className="muted small">Type a number or expression, or @part.face to sit against another part. Give two of start, end and size.</p>
    </div>
  );
}
