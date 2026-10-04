// The Cut layout tab: how the cut list's parts come out of the timber you
// buy. One drawing per sheet and length, what to buy, the offcuts and the
// waste. The stock settings are part of the design, so each change to them
// is one you can undo.

import { useCallback, useEffect, useMemo, useState } from "react";
import { cutLayout, DEFAULT_KERF_MM, DEFAULT_TRIM_MM, fmt, type MaterialLayout, type Op, type PlacedPart, type StockPiece } from "@woodchuck/core";
import { applyOps, type ServerState } from "../api";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Applies one stock change. False when the design refused it. */
type Apply = (op: Op, label: string) => Promise<boolean>;

/** Label sizes in screen pixels, largest first, so labels stay readable in a narrow panel. */
const LABEL_PX = [11, 9.5, 8.5];
/** Drawings stop growing at this width, matching the CSS. */
const MAX_DRAWING_PX = 720;
/** How tall a length is drawn, whatever its width. */
const LENGTH_PX = 34;

export function CutLayoutPanel({ state, onSelect }: { state: ServerState; onSelect: (ids: string[]) => void }) {
  const { design, cutlist } = state;
  // A streaming reply replaces the state many times a second, so lay out
  // again only when the parts or the stock change.
  const key = JSON.stringify([cutlist.rows, design.materials, design.stock ?? null]);
  const layout = useMemo(() => cutLayout(design, cutlist), [key]);
  const [error, setError] = useState<string | null>(null);
  // Drawings fill the panel, so labels are sized from its width.
  const [width, setWidth] = useState(0);
  const measure = useCallback((el: HTMLDivElement | null) => {
    if (!el) return;
    const watch = new ResizeObserver(([e]) => setWidth(e!.contentRect.width));
    watch.observe(el);
    return () => watch.disconnect();
  }, []);
  const px = Math.min(width || 360, MAX_DRAWING_PX);
  const apply: Apply = async (op, label) => {
    const r = await applyOps([op], label);
    setError(r.ok ? null : (r.error ?? "Couldn't change the stock"));
    return r.ok;
  };

  if (!cutlist.rows.length) return <div className="empty">Nothing to cut yet.</div>;
  return (
    <div className="panel-body cut-layout" ref={measure}>
      <p className="muted small">
        Every sheet and length to buy, with each part placed on it. Parts sit a saw kerf apart, and a sheet loses its trim at every edge. Click a
        part to pick it in the model.
      </p>
      <div className="stock-fields">
        <NumberField
          label="Saw kerf"
          value={layout.kerf_mm}
          custom={design.stock?.kerf_mm !== undefined}
          onCommit={(v) => apply({ op: "set_stock", kerf_mm: v }, `Set the saw kerf to ${fmt(v ?? DEFAULT_KERF_MM)} mm`)}
        />
        <NumberField
          label="Sheet trim"
          value={layout.trim_mm}
          custom={design.stock?.trim_mm !== undefined}
          onCommit={(v) => apply({ op: "set_stock", trim_mm: v }, `Set the sheet trim to ${fmt(v ?? DEFAULT_TRIM_MM)} mm`)}
        />
      </div>
      {error && <div className="form-error">{error}</div>}
      <div className="card">
        <div className="card-title">To buy</div>
        {layout.buy.length ? (
          <ul>
            {layout.buy.map((b) => (
              <li key={b.text}>{b.text}</li>
            ))}
          </ul>
        ) : (
          <div className="muted small">Nothing fits the stock yet.</div>
        )}
      </div>
      {layout.materials.map((m) => (
        <MaterialSection key={m.material} m={m} trim={layout.trim_mm} px={px} apply={apply} onSelect={onSelect} />
      ))}
    </div>
  );
}

function MaterialSection({
  m,
  trim,
  px,
  apply,
  onSelect,
}: {
  m: MaterialLayout;
  trim: number;
  /** How wide the drawings are on screen. */
  px: number;
  apply: Apply;
  onSelect: (ids: string[]) => void;
}) {
  const longest = Math.max(0, ...m.stock.map((s) => s.length_mm));
  return (
    <section className="layout-material" data-place={`layout:${m.material}`}>
      <div className="card-sub">{m.name}</div>
      <div className="small">
        {plural(m.stock.length, m.kind === "sheet" ? "sheet" : "length")}, waste {fmt(m.waste_pct)}% with offcuts counted
      </div>
      {m.kind === "sheet" ? <SheetField m={m} apply={apply} /> : <LengthsField m={m} apply={apply} />}
      {m.kind === "sheet" && m.grained && <div className="muted small">The grain runs along each sheet's length, so no part is turned.</div>}
      {m.notes.map((n) => (
        <div key={n} className="layout-note small">
          {n}.
        </div>
      ))}
      {m.unplaced.map((u) => (
        <div key={u.part} className="issue warning" onClick={() => onSelect([u.part])}>
          {u.name} ({u.part}) isn't laid out: {u.reason}.
        </div>
      ))}
      {m.stock.map((s, i) => (
        <figure key={i} className="layout-stock">
          <figcaption className="small">
            <strong>
              {m.kind === "sheet" ? "Sheet" : "Length"} {i + 1} of {m.stock.length}
            </strong>{" "}
            <span className="muted">
              {m.kind === "sheet" ? `${fmt(s.length_mm)} × ${fmt(s.width_mm)}` : `${fmt(s.width_mm)} × ${fmt(m.thickness_mm)} at ${fmt(s.length_mm)}`}, waste{" "}
              {fmt(s.waste_pct)}%
            </span>
          </figcaption>
          {m.kind === "sheet" ? (
            <SheetDrawing s={s} trim={trim} px={px} onSelect={onSelect} />
          ) : (
            <LengthDrawing s={s} longest={longest} px={px} onSelect={onSelect} />
          )}
          {s.offcuts.length > 0 && (
            <div className="muted small">Offcuts to keep: {s.offcuts.map((o) => `${fmt(o.length_mm)} × ${fmt(o.width_mm)}`).join(", ")}</div>
          )}
        </figure>
      ))}
    </section>
  );
}

function SheetDrawing({ s, trim, px, onSelect }: { s: StockPiece; trim: number; px: number; onSelect: (ids: string[]) => void }) {
  const L = s.length_mm;
  const W = s.width_mm;
  const fonts = LABEL_PX.map((f) => (f * L) / px);
  return (
    <svg viewBox={`0 0 ${L} ${W}`} role="img" aria-label={`Sheet ${fmt(L)} × ${fmt(W)}`}>
      <rect className="lay-stock" x={0} y={0} width={L} height={W} />
      <rect className="lay-trim" x={trim} y={trim} width={Math.max(0, L - 2 * trim)} height={Math.max(0, W - 2 * trim)} />
      {s.offcuts.map((o, i) => (
        <rect key={i} className="lay-offcut" x={o.x_mm} y={o.y_mm} width={o.length_mm} height={o.width_mm} />
      ))}
      {s.parts.map((p, i) => {
        const [w, h] = p.rotated ? [p.width_mm, p.length_mm] : [p.length_mm, p.width_mm];
        return <PartBox key={i} p={p} x={p.x_mm} y={p.y_mm} w={w} h={h} fonts={fonts} onSelect={onSelect} />;
      })}
    </svg>
  );
}

/** A length drawn to scale along it, and thicker than life across it so the labels fit. */
function LengthDrawing({ s, longest, px, onSelect }: { s: StockPiece; longest: number; px: number; onSelect: (ids: string[]) => void }) {
  const H = (LENGTH_PX * longest) / px;
  const fonts = LABEL_PX.map((f) => (f * longest) / px);
  return (
    <svg viewBox={`0 0 ${longest} ${H}`} role="img" aria-label={`Length ${fmt(s.length_mm)}`}>
      <rect className="lay-stock" x={0} y={0} width={s.length_mm} height={H} />
      {s.offcuts.map((o, i) => (
        <rect key={i} className="lay-offcut" x={o.x_mm} y={0} width={o.length_mm} height={H} />
      ))}
      {s.parts.map((p, i) => (
        <PartBox key={i} p={p} x={p.x_mm} y={0} w={p.length_mm} h={H} fonts={fonts} onSelect={onSelect} solid />
      ))}
    </svg>
  );
}

/** A name split into two lines as even as its words allow, or null for one word. */
function wrap(name: string): [string, string] | null {
  const words = name.split(" ");
  let best: [string, string] | null = null;
  for (let i = 1; i < words.length; i++) {
    const lines: [string, string] = [words.slice(0, i).join(" "), words.slice(i).join(" ")];
    if (!best || Math.max(...lines.map((l) => l.length)) < Math.max(...best.map((l) => l.length))) best = lines;
  }
  return best;
}

/** A placed part with the biggest label that fits it. The tooltip always has the lot. */
function PartBox({
  p,
  x,
  y,
  w,
  h,
  fonts,
  solid,
  onSelect,
}: {
  p: PlacedPart;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Label sizes to try, in the drawing's units. */
  fonts: number[];
  solid?: boolean;
  onSelect: (ids: string[]) => void;
}) {
  const name = p.board ? `${p.name}, board ${p.board[0]} of ${p.board[1]}` : p.name;
  const size = solid ? fmt(p.length_mm) : `${fmt(p.length_mm)} × ${fmt(p.width_mm)}`;
  const fits = (lines: string[], f: number) => lines.every((t) => t.length * f * 0.56 <= w - f * 0.5) && lines.length * f * 1.25 <= h - f * 0.2;
  // The name and size if they fit, smaller or with the name over two lines
  // if need be, then the name alone, then the cut list row.
  const two = wrap(name);
  const tries = [[name, size], [`${name} ${size}`], ...(two ? [[...two, size]] : []), [name], ...(two ? [two] : []), [`#${p.row}`]];
  let label: { lines: string[]; f: number } | null = null;
  for (const lines of tries) {
    const f = fonts.find((f) => fits(lines, f));
    if (f) {
      label = { lines, f };
      break;
    }
  }
  return (
    <g className="lay-part" onClick={() => onSelect([p.part])}>
      <title>{`${name} (${p.part}), ${fmt(p.length_mm)} × ${fmt(p.width_mm)} mm, cut list row ${p.row}${p.rotated ? ", turned across the sheet" : ""}`}</title>
      <rect x={x} y={y} width={w} height={h} />
      {label?.lines.map((t, i) => (
        <text key={i} x={x + w / 2} y={y + h / 2 + (i - (label.lines.length - 1) / 2) * label.f * 1.2} fontSize={label.f} textAnchor="middle" dominantBaseline="central">
          {t}
        </text>
      ))}
    </g>
  );
}

/** A number in mm that applies when you leave the box. Empty goes back to the default. */
function NumberField({ label, value, custom, onCommit }: { label: string; value: number; custom: boolean; onCommit: (v: number | null) => Promise<boolean> }) {
  const [text, setText] = useState(fmt(value));
  useEffect(() => setText(fmt(value)), [value]);
  // A refused value goes back to the one in force, and the panel says why.
  const reset = () => setText(fmt(value));
  const commit = () => {
    const t = text.trim();
    const n = Number(t);
    if (t === "" && custom) void onCommit(null).then((ok) => ok || reset());
    else if (t !== "" && Number.isFinite(n) && n !== value) void onCommit(n).then((ok) => ok || reset());
    else reset();
  };
  return (
    <label title="Leave it empty for the default">
      {label}{" "}
      <input
        className="num"
        inputMode="decimal"
        aria-label={`${label} in mm`}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      />{" "}
      mm
    </label>
  );
}

function SheetField({ m, apply }: { m: MaterialLayout; apply: Apply }) {
  const [L, W] = m.sheet_mm ?? [0, 0];
  const [text, setText] = useState([fmt(L), fmt(W)]);
  useEffect(() => setText([fmt(L), fmt(W)]), [L, W]);
  const reset = () => setText([fmt(L), fmt(W)]);
  const commit = () => {
    const [l, w] = text.map((t) => Number(t.trim()));
    if (text.every((t) => t.trim() === "") && m.custom) {
      void apply({ op: "set_stock", material: m.material, sheet_mm: null }, `Set ${m.name} back to its usual sheet`).then((ok) => ok || reset());
    } else if (text.every((t) => t.trim() !== "") && Number.isFinite(l) && Number.isFinite(w) && (l !== L || w !== W)) {
      void apply({ op: "set_stock", material: m.material, sheet_mm: [l!, w!] }, `Set ${m.name} to ${fmt(l!)} × ${fmt(w!)} sheets`).then((ok) => ok || reset());
    } else reset();
  };
  const box = (i: 0 | 1) => (
    <input
      className="num"
      inputMode="decimal"
      aria-label={i === 0 ? "Sheet length along the grain" : "Sheet width"}
      value={text[i]}
      onChange={(e) => setText(i === 0 ? [e.target.value, text[1]!] : [text[0]!, e.target.value])}
      // Moving between the two boxes isn't leaving the sheet size.
      onBlur={(e) => e.currentTarget.parentElement?.contains(e.relatedTarget as Node | null) || commit()}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
    />
  );
  return (
    <div className="stock-fields">
      <label>
        Sheet {box(0)} × {box(1)} mm
      </label>
      {m.custom && (
        <button className="link" onClick={() => apply({ op: "set_stock", material: m.material, sheet_mm: null }, `Set ${m.name} back to its usual sheet`)}>
          Usual size
        </button>
      )}
    </div>
  );
}

function LengthsField({ m, apply }: { m: MaterialLayout; apply: Apply }) {
  const now = (m.lengths_mm ?? []).map(fmt).join(", ");
  const [text, setText] = useState(now);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setText(now), [now]);
  const commit = () => {
    const parts = text.split(/[\s,]+/).filter(Boolean);
    const lengths = [...new Set(parts.map(Number))].sort((a, b) => a - b);
    setError(null);
    if (!parts.length && m.custom) {
      void apply({ op: "set_stock", material: m.material, lengths_mm: null }, `Set ${m.name} back to the usual lengths`).then((ok) => ok || setText(now));
    } else if (!parts.length || lengths.some((n) => !Number.isFinite(n))) {
      if (parts.length) setError("Lengths are numbers in mm, such as 2400, 3000, 3600");
      setText(now);
    } else if (lengths.map(fmt).join(", ") !== now) {
      void apply({ op: "set_stock", material: m.material, lengths_mm: lengths }, `Set ${m.name} to ${lengths.map(fmt).join(", ")} mm lengths`).then(
        (ok) => ok || setText(now),
      );
    }
  };
  return (
    <>
      <div className="stock-fields">
        <label className="lengths">
          Lengths{" "}
          <input
            aria-label="Stock lengths in mm"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          />{" "}
          mm
        </label>
        {m.custom && (
          <button className="link" onClick={() => apply({ op: "set_stock", material: m.material, lengths_mm: null }, `Set ${m.name} back to the usual lengths`)}>
            Usual lengths
          </button>
        )}
      </div>
      {error && <div className="form-error">{error}</div>}
    </>
  );
}
