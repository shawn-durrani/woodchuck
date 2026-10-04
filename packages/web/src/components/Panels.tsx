// The smaller panels: parameters as sliders, the cut list, the tool
// requests Claude has made, the workshop drawings' download and the 2D
// view. The tabs that hold them are in SidePanel.tsx.

import { useEffect, useRef, useState } from "react";
import { fmt, literalValue, paperParams, paramLabel, type Param } from "@woodchuck/core";
import { applyOps, post, type ServerState } from "../api";
import { usePaper } from "../theme";
import { MissingTool } from "./MissingTool";
import { savedNote } from "../signals";
import { PLAN_VIEWS, type Paper, type PlanView } from "../toolbar";

function ParamRow({ p, value }: { p: Param; value: number | string }) {
  const literal = literalValue(p.expr);
  const [v, setV] = useState(literal ?? 0);
  const [expr, setExpr] = useState(p.expr);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (literal !== null) setV(literal);
    setExpr(p.expr);
  }, [p.expr, literal]);
  const save = async (e: string) => {
    const r = await applyOps([{ op: "set_param", name: p.name, expr: e, unit: p.unit }], `Set ${p.name}`);
    if (r.ok) return setError(null);
    // A value the design refused goes back to the one in force, with the reason beside it.
    setError(r.error ?? "That value wasn't taken");
    if (literal !== null) setV(literal);
    setExpr(p.expr);
  };
  // The size's own words lead, and its id stays small, for Claude and the formulas.
  const label = <span className="param-name">{paramLabel(p)}</span>;
  const id = (
    <code className="param-id" title="The size's id, which formulas and Claude use">
      {p.name}
    </code>
  );

  if (literal !== null) {
    const span = Math.max(Math.abs(literal), 10);
    const min = p.min ?? Math.max(0, literal - span);
    const max = p.max ?? literal + span;
    const step = p.step ?? (p.unit === "count" ? 1 : 1);
    return (
      <div className="param" data-place={`param:${p.name}`}>
        <div className="param-head">
          {label}
          {id}
        </div>
        <div className="param-row">
          <input
            type="range"
            min={min}
            max={max}
            step={step}
            value={v}
            aria-label={paramLabel(p)}
            onChange={(e) => setV(Number(e.target.value))}
            onPointerUp={() => v !== literal && void save(String(v))}
            onKeyUp={() => v !== literal && void save(String(v))}
          />
          <input
            className="num"
            type="number"
            value={v}
            step={step}
            aria-label={`${paramLabel(p)}, in ${p.unit}`}
            onChange={(e) => setV(Number(e.target.value))}
            onBlur={() => v !== literal && void save(String(v))}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          />
          <span className="unit">{p.unit === "none" ? "" : p.unit}</span>
        </div>
        {error && (
          <div className="form-error field-error" role="alert">
            {error}
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="param" data-place={`param:${p.name}`}>
      <div className="param-head">
        {label}
        <span>
          = <strong>{typeof value === "number" ? fmt(value) : value}</strong> {p.unit === "none" ? "" : p.unit}
        </span>
        {id}
      </div>
      <input
        className="expr"
        value={expr}
        aria-label={`${paramLabel(p)}, worked out as`}
        onChange={(e) => setExpr(e.target.value)}
        onBlur={() => expr !== p.expr && void save(expr)}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      />
      {error && (
        <div className="form-error field-error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

export function ParamsPanel({ state }: { state: ServerState }) {
  if (!state.design.params.length) return <div className="empty">No sizes yet. Claude adds them as it builds, and plain numbers show here as sliders.</div>;
  const sliders = state.design.params.filter((p) => literalValue(p.expr) !== null);
  const derived = state.design.params.filter((p) => literalValue(p.expr) === null);
  const valueOf = (name: string) => {
    const v = state.derived.params[name];
    return v && "value" in v ? v.value : (v?.error ?? "?");
  };
  return (
    <div className="sizes">
      {sliders.map((p) => (
        <ParamRow key={p.name} p={p} value={valueOf(p.name)} />
      ))}
      {derived.length > 0 && <div className="card-sub">Worked out from others</div>}
      {derived.map((p) => (
        <ParamRow key={p.name} p={p} value={valueOf(p.name)} />
      ))}
    </div>
  );
}

export function CutListPanel({ state, onSelect }: { state: ServerState; onSelect: (ids: string[]) => void }) {
  const { rows, hardware, excluded } = state.cutlist;
  if (!rows.length) return <div className="empty">Nothing to cut yet.</div>;
  return (
    <div className="panel-body">
      <p className="muted">Cut sizes include joinery. Lengths run along the grain.</p>
      <table className="cut">
        <thead>
          <tr>
            <th>#</th>
            <th>Part</th>
            <th>Qty</th>
            <th>L</th>
            <th>W</th>
            <th>T</th>
            <th>Material</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.row} onClick={() => onSelect(r.parts)} title={r.machining.join("\n")}>
              <td>{r.row}</td>
              <td>
                {r.name}
                {r.machining.length > 0 && <span className="muted small"> · {r.machining.length} machining</span>}
              </td>
              <td>{r.qty}</td>
              <td>{r.length_mm}</td>
              <td>{r.width_mm}</td>
              <td>{r.thickness_mm}</td>
              <td className="small">{r.material_name}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {hardware.length > 0 && (
        <>
          <div className="card-sub">Hardware</div>
          <ul>
            {hardware.map((h) => (
              <li key={h.name + h.spec}>
                {h.qty} × {h.name} <span className="muted small">{h.spec}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {excluded.length > 0 && <p className="muted small">Left off: {excluded.map((e) => `${e.id} (${e.reason})`).join(", ")}</p>}
    </div>
  );
}

export function RequestsPanel({ state }: { state: ServerState }) {
  const reqs = state.tool_requests;
  const waiting = [...reqs].filter((r) => r.status === "open" || r.status === "approved").sort((a, b) => b.count - a.count);
  const rest = reqs.filter((r) => r.status === "built" || r.status === "declined");
  return (
    <div className="requests-panel">
      <p className="muted small">
        When Claude needs a tool the app doesn't have, it stops instead of guessing and writes up the tool it needs. File that spec as a GitHub issue,
        and Claude Code builds it from there. The app checks GitHub every few minutes, marks the tool built once its PR merges, and tells the design
        that asked.
      </p>
      {/* With GitHub off there's nothing to check, and each card says how to turn it on. */}
      {state.repo && <CheckNow />}
      {reqs.length === 0 && <div className="empty">No missing tools so far.</div>}
      {waiting.map((r) => (
        <div key={r.id}>
          <MissingTool r={r} repo={state.repo} />
          <StatusPicker r={r} />
        </div>
      ))}
      {rest.length > 0 && <div className="card-sub">Built or declined</div>}
      {rest.map((r) => (
        <div key={r.id} className="card">
          <div className="card-title">
            {r.name} <span className="muted small">{r.status}</span>
          </div>
          <p className="small">{r.purpose}</p>
          <StatusPicker r={r} />
        </div>
      ))}
    </div>
  );
}

function CheckNow() {
  const [note, setNote] = useState<string | null>(null);
  return (
    <div className="row">
      <button
        onClick={async () => {
          setNote("Checking GitHub…");
          const r = await fetch("/api/tool-requests/sync", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
          const body = (await r.json()) as { changed?: { id: string; status: string }[]; error?: string };
          setNote(!r.ok ? (body.error ?? "Couldn't check") : body.changed?.length ? `${body.changed.length} updated` : "Nothing new yet");
        }}
      >
        Check now
      </button>
      {note && <span className="muted small">{note}</span>}
    </div>
  );
}

function StatusPicker({ r }: { r: ServerState["tool_requests"][number] }) {
  return (
    <label className="small muted status-pick">
      Status{" "}
      <select value={r.status} onChange={(e) => post("/api/tool-requests/status", { id: r.id, status: e.target.value })}>
        <option value="open">Waiting</option>
        <option value="approved">Sent to build</option>
        <option value="built">Built</option>
        <option value="declined">Not needed</option>
      </select>
    </label>
  );
}

/** Where the workshop drawings download from, on a paper. */
export const drawingsUrl = (paper: Paper) => `/api/drawings.pdf?paper=${paper}`;
export const drawingsNote = (slug: string, paper: Paper) => savedNote(`the workshop drawings on ${paper}`, `${slug}-drawings.pdf`);

/** The workshop drawings' download, with the paper beside it. Most home printers take A4, and A3 draws the general arrangement larger. */
export function DrawingsLink({ slug, paper, onPaper, onSaved, big = false, empty = false }: { slug: string; paper: Paper; onPaper: (p: Paper) => void; onSaved: (text: string) => void; big?: boolean; empty?: boolean }) {
  const tip = "Plans, a drawing of each part, and the cut, drilling and hardware lists, to print at 100%";
  return (
    <span className="cut-drawings">
      {empty ? (
        <button className={big ? "primary" : ""} disabled title="Nothing to draw yet. Ask Claude to build something first.">
          Workshop drawings (PDF)
        </button>
      ) : (
        <a className={`button${big ? " primary-link" : ""}`} href={drawingsUrl(paper)} title={tip} onClick={() => onSaved(drawingsNote(slug, paper))}>
          Workshop drawings (PDF)
        </a>
      )}
      <select value={paper} aria-label="Paper for the workshop drawings" title="Paper for the workshop drawings" onChange={(e) => onPaper(e.target.value as Paper)}>
        <option value="A4">A4</option>
        <option value="A3">A3</option>
      </select>
    </span>
  );
}

/**
 * The drawings are drawn this much smaller than the space they fill, so
 * they scale up on screen and their sizes stay easy to read.
 */
const PLAN_ZOOM = 1.4;

/** The 2D view: one drawing at a time, as large as the space allows, with its overall sizes. */
export function ViewsPanel({
  version,
  xray,
  view,
  onView,
  slug,
  paper,
  onPaper,
  onSaved,
  empty,
}: {
  version: number;
  xray: boolean;
  view: PlanView;
  onView: (v: PlanView) => void;
  slug: string;
  paper: Paper;
  onPaper: (p: Paper) => void;
  onSaved: (text: string) => void;
  empty: boolean;
}) {
  const sheet = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  // Ask for a drawing shaped like the space, once the space stops changing.
  useEffect(() => {
    const el = sheet.current;
    if (!el) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const measure = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const r = el.getBoundingClientRect();
        const step = (v: number) => Math.max(320, Math.round(v / PLAN_ZOOM / 20) * 20);
        if (r.width > 0 && r.height > 0) setSize({ w: step(r.width), h: step(r.height) });
      }, 120);
    };
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    return () => {
      clearTimeout(timer);
      watch.disconnect();
    };
  }, []);
  const label = PLAN_VIEWS.find((p) => p.id === view)?.label ?? view;
  // The server draws the drawing, so the sheet's colours go with the request.
  const colours = paperParams(usePaper());
  return (
    <div className="plan-view">
      <div className="plan-head">
        <div className="seg" role="radiogroup" aria-label="Which drawing">
          {PLAN_VIEWS.map((p) => (
            <button key={p.id} role="radio" aria-checked={p.id === view} className={p.id === view ? "on" : ""} onClick={() => onView(p.id)}>
              {p.label}
            </button>
          ))}
        </div>
        <DrawingsLink slug={slug} paper={paper} onPaper={onPaper} onSaved={onSaved} big empty={empty} />
      </div>
      <div className="plan-sheet" ref={sheet}>
        {size && <img src={`/api/views/${view}.svg?w=${size.w}&h=${size.h}&v=${version}${xray ? "&xray=1" : ""}&${colours}`} alt={`The ${label.toLowerCase()} drawing`} />}
      </div>
    </div>
  );
}

// The parts library has its own file.
export { LibraryPanel } from "./LibraryPanel";
