// The Cut layout tab: how the cut list's parts come out of the boards and
// sheets you own, then the timber you buy. One drawing per sheet and
// length, each with its letter, what to buy, the offcuts and the waste. The
// stock settings, your own stock among them, are part of the design, so
// each change to them is one you can undo. The layout places each part's
// blank, and a part its cuts shape shows its outline inside the blank, with
// the wood it loses shaded like the stock.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  cutLayout,
  DEFAULT_KERF_MM,
  DEFAULT_TRIM_MM,
  fmt,
  outlineOnBlank,
  ownedStock,
  ripped,
  type Loop,
  type MaterialLayout,
  type MaterialStock,
  type Op,
  type OwnedStock,
  type PlacedPart,
  type StockPiece,
} from "@woodchuck/core";
import { applyOps, type ServerState } from "../api";
import { cutAwayPath } from "../cutAway";
import {
  addOwned,
  cuttingPlanUrl,
  EMPTY_ROW,
  lengthsLabel,
  nothingToBuy,
  ownedLabel,
  ownedText,
  parseOwnedRow,
  parseSizes,
  pieceWord,
  removeOwned,
  stockCount,
  widthsLabel,
  type OwnedRow,
} from "../stockEditor";

/** Applies one stock change. False when the design refused it. */
type Apply = (op: Op, label: string) => Promise<boolean>;

/** Label sizes in screen pixels, largest first, so labels stay readable in a narrow panel. */
const LABEL_PX = [11, 9.5, 8.5];
/** Drawings stop growing at this width, matching the CSS. */
const MAX_DRAWING_PX = 720;
/** How tall a length is drawn, whatever its width. */
const LENGTH_PX = 34;
/** How tall the narrowest strip ripped from a board is drawn, so two lines of label fit it at the smallest size. */
const STRIP_PX = 24;

/** Each shaped part's outline on its blank, by part id. */
type Shapes = Map<string, { outline: Loop; holes: Loop[] }>;

export function CutLayoutPanel({ state, onSelect }: { state: ServerState; onSelect: (ids: string[]) => void }) {
  const { design, cutlist } = state;
  // A streaming reply replaces the state many times a second, so lay out
  // again only when the parts or the stock change.
  const key = JSON.stringify([cutlist.rows, design.materials, design.stock ?? null]);
  const layout = useMemo(() => cutLayout(design, cutlist), [key]);
  // A cut list row only groups parts whose shapes match, so its rows say when a shape changed.
  const shapes = useMemo<Shapes>(() => {
    const out: Shapes = new Map();
    for (const p of state.derived.parts) {
      const on = p.profile ? outlineOnBlank(p) : null;
      if (on) out.set(p.id, on);
    }
    return out;
  }, [JSON.stringify(cutlist.rows)]);
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
      <div className="layout-print">
        <a className="button" href={cuttingPlanUrl("A4")} target="_blank" rel="noreferrer noopener" title="Every board and sheet on one A4 page when it fits, to take to the saw">
          Print cutting plan
        </a>
      </div>
      <p className="muted small">
        Every board and sheet to cut, your own first and then what to buy, with each part placed on it. Parts sit a saw kerf apart, and a bought
        sheet loses its trim at every edge. Click a part to pick it in the model.
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
      {layout.from_stock.length > 0 && (
        <div className="card">
          <div className="card-title">From your stock</div>
          <ul>
            {layout.from_stock.map((b) => (
              <li key={b.text}>{b.text}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="card">
        <div className="card-title">To buy</div>
        {layout.buy.length ? (
          <ul>
            {layout.buy.map((b) => (
              <li key={b.text}>{b.text}</li>
            ))}
          </ul>
        ) : (
          <div className="muted small">{nothingToBuy(layout)}</div>
        )}
      </div>
      {layout.materials.map((m) => (
        <MaterialSection
          key={m.material}
          m={m}
          own={design.stock?.materials?.[m.material]}
          owned={ownedStock(design, { id: m.material })}
          trim={layout.trim_mm}
          px={px}
          shapes={shapes}
          apply={apply}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

function MaterialSection({
  m,
  own,
  owned,
  trim,
  px,
  shapes,
  apply,
  onSelect,
}: {
  m: MaterialLayout;
  /** The design's own stock settings for this material, if it has any. */
  own: MaterialStock | undefined;
  /** The boards or sheets of it you already have. */
  owned: OwnedStock[];
  trim: number;
  /** How wide the drawings are on screen. */
  px: number;
  shapes: Shapes;
  apply: Apply;
  onSelect: (ids: string[]) => void;
}) {
  const longest = Math.max(0, ...m.stock.map((s) => s.length_mm));
  return (
    <section className="layout-material" data-place={`layout:${m.material}`}>
      <div className="card-sub">{m.name}</div>
      <div className="small">
        {stockCount(m.kind, m.stock)}, waste {fmt(m.waste_pct)}% with offcuts counted
      </div>
      {m.kind === "sheet" ? <SheetField m={m} apply={apply} /> : <SolidFields m={m} lengthsCustom={own?.lengths_mm !== undefined} apply={apply} />}
      {m.kind === "sheet" && m.grained && <div className="muted small">The grain runs along each sheet's length, so no part is turned.</div>}
      <OwnedStockEditor m={m} owned={owned} apply={apply} />
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
      {m.stock.map((s) => (
        <figure key={s.label} className="layout-stock">
          <figcaption className="small">
            <strong>
              {m.kind === "sheet" ? "Sheet" : "Length"} {s.label}
            </strong>
            {s.owned && <span className="badge yours">yours</span>}{" "}
            <span className="muted">
              {m.kind === "sheet" ? `${fmt(s.length_mm)} × ${fmt(s.width_mm)}` : `${fmt(s.width_mm)} × ${fmt(m.thickness_mm)} at ${fmt(s.length_mm)}`}, waste{" "}
              {fmt(s.waste_pct)}%
            </span>
          </figcaption>
          {m.kind === "sheet" ? (
            // Your own sheets are cut to the edge, with no trim.
            <SheetDrawing s={s} trim={s.owned ? 0 : trim} px={px} shapes={shapes} onSelect={onSelect} />
          ) : (
            <LengthDrawing s={s} longest={longest} px={px} shapes={shapes} onSelect={onSelect} />
          )}
          {s.offcuts.length > 0 && (
            <div className="muted small">Offcuts to keep: {s.offcuts.map((o) => `${fmt(o.length_mm)} × ${fmt(o.width_mm)}`).join(", ")}</div>
          )}
        </figure>
      ))}
    </section>
  );
}

function SheetDrawing({ s, trim, px, shapes, onSelect }: { s: StockPiece; trim: number; px: number; shapes: Shapes; onSelect: (ids: string[]) => void }) {
  const L = s.length_mm;
  const W = s.width_mm;
  const fonts = LABEL_PX.map((f) => (f * L) / px);
  return (
    <svg viewBox={`0 0 ${L} ${W}`} role="img" aria-label={`Sheet ${s.label}, ${fmt(L)} × ${fmt(W)}`}>
      <rect className="lay-stock" x={0} y={0} width={L} height={W} />
      {trim > 0 && <rect className="lay-trim" x={trim} y={trim} width={Math.max(0, L - 2 * trim)} height={Math.max(0, W - 2 * trim)} />}
      {s.offcuts.map((o, i) => (
        <rect key={i} className="lay-offcut" x={o.x_mm} y={o.y_mm} width={o.length_mm} height={o.width_mm} />
      ))}
      {s.parts.map((p, i) => {
        const [w, h] = p.rotated ? [p.width_mm, p.length_mm] : [p.length_mm, p.width_mm];
        return <PartBox key={i} p={p} x={p.x_mm} y={p.y_mm} w={w} h={h} fonts={fonts} shape={shapes.get(p.part)} onSelect={onSelect} />;
      })}
    </svg>
  );
}

/**
 * How tall a board is drawn, in screen pixels: at the usual height when
 * each part takes its whole width, and deeper when it's ripped into narrow
 * strips, so each strip still has room for its label. Never more than three
 * times the usual height.
 */
export function boardDepthPx(width_mm: number, strips_mm: readonly number[]): number {
  const narrowest = Math.min(width_mm, ...strips_mm.filter((w) => w > 0));
  return Math.min(3 * LENGTH_PX, Math.max(LENGTH_PX, (STRIP_PX * width_mm) / narrowest));
}

/** A length drawn to scale along it, and thicker than life across it so the labels fit. Parts ripped from it sit side by side across it. */
function LengthDrawing({ s, longest, px, shapes, onSelect }: { s: StockPiece; longest: number; px: number; shapes: Shapes; onSelect: (ids: string[]) => void }) {
  const across = (p: PlacedPart) => (p.rotated ? p.length_mm : p.width_mm);
  const H = (boardDepthPx(s.width_mm, s.parts.map(across)) * longest) / px;
  const sy = H / s.width_mm;
  const fonts = LABEL_PX.map((f) => (f * longest) / px);
  return (
    <svg viewBox={`0 0 ${longest} ${H}`} role="img" aria-label={`Length ${s.label}, ${fmt(s.length_mm)} long`}>
      <rect className="lay-stock" x={0} y={0} width={s.length_mm} height={H} />
      {s.offcuts.map((o, i) => (
        <rect key={i} className="lay-offcut" x={o.x_mm} y={o.y_mm * sy} width={o.length_mm} height={o.width_mm * sy} />
      ))}
      {s.parts.map((p, i) => (
        <PartBox
          key={i}
          p={p}
          x={p.x_mm}
          y={p.y_mm * sy}
          w={p.rotated ? p.width_mm : p.length_mm}
          h={across(p) * sy}
          fonts={fonts}
          shape={p.board ? undefined : shapes.get(p.part)}
          onSelect={onSelect}
          solid
          ripFrom={ripped(s, p, "solid") ? s.width_mm : undefined}
        />
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

/**
 * The labels to try on a placed part, best first: its name and size on
 * one line or two, then the name alone, then its cut list row. Each size
 * is tried in turn, so a ripped part says its rip when there's room.
 */
export function labelTries(name: string, sizes: readonly string[], row: number): string[][] {
  const two = wrap(name);
  return [...sizes.flatMap((size) => [[name, size], [`${name} ${size}`], ...(two ? [[...two, size]] : [])]), [name], ...(two ? [two] : []), [`#${row}`]];
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
  shape,
  ripFrom,
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
  /** The outline its cuts leave on the blank, if they shape it. */
  shape?: { outline: Loop; holes: Loop[] } | undefined;
  /** The width of the board it's ripped from, when it's narrower than that board. */
  ripFrom?: number | undefined;
  onSelect: (ids: string[]) => void;
}) {
  const name = p.board ? `${p.name}, board ${p.board[0]} of ${p.board[1]}` : p.name;
  const size = solid ? fmt(p.length_mm) : `${fmt(p.length_mm)} × ${fmt(p.width_mm)}`;
  const fits = (lines: string[], f: number) => lines.every((t) => t.length * f * 0.56 <= w - f * 0.5) && lines.length * f * 1.25 <= h - f * 0.2;
  // The name and size if they fit, smaller or with the name over two lines
  // if need be, then the name alone, then the cut list row.
  const tries = labelTries(name, ripFrom === undefined ? [size] : [`${size}, rip ${fmt(p.width_mm)}`, size], p.row);
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
      <title>{`${name} (${p.part}), ${fmt(p.length_mm)} × ${fmt(p.width_mm)} mm, cut list row ${p.row}${p.rotated ? ", turned across the sheet" : ""}${ripFrom === undefined ? "" : `, ripped from a ${fmt(ripFrom)} mm board`}`}</title>
      <rect x={x} y={y} width={w} height={h} />
      {shape && <path className="lay-cutaway" d={cutAwayPath(shape, p, x, y, w, h)} fillRule="evenodd" />}
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

/** A solid timber's lengths and the widths it's sold in, side by side. */
function SolidFields({ m, lengthsCustom, apply }: { m: MaterialLayout; lengthsCustom: boolean; apply: Apply }) {
  const [error, setError] = useState<string | null>(null);
  const lengths = (v: number[] | null) => apply({ op: "set_stock", material: m.material, lengths_mm: v }, lengthsLabel(m.name, v));
  return (
    <>
      <div className="stock-fields">
        <SizesField
          label="Lengths"
          aria="Stock lengths in mm"
          sizes_mm={m.lengths_mm ?? []}
          custom={lengthsCustom}
          bad="Lengths are numbers in mm, such as 2400, 3000, 3600"
          onSet={lengths}
          onError={setError}
        />
        {lengthsCustom && (
          <button className="link" onClick={() => lengths(null)}>
            Usual lengths
          </button>
        )}
        <SizesField
          label="Widths sold"
          aria="Board widths sold, in mm"
          sizes_mm={m.widths_mm ?? []}
          custom={m.widths_mm !== undefined}
          placeholder="Each part's own width"
          bad="Widths are numbers in mm, such as 42, 66, 90"
          onSet={(v) => apply({ op: "set_stock", material: m.material, widths_mm: v }, widthsLabel(m.name, v))}
          onError={setError}
        />
      </div>
      {error && <div className="form-error">{error}</div>}
      <div className="muted small">Narrower parts are ripped from the narrowest width that holds them.</div>
    </>
  );
}

/** A list of sizes in mm that applies when you leave the box. Empty sets it back. */
function SizesField({
  label,
  aria,
  sizes_mm,
  custom,
  placeholder,
  bad,
  onSet,
  onError,
}: {
  label: string;
  aria: string;
  sizes_mm: readonly number[];
  /** The design sets these, so emptying the box clears them. */
  custom: boolean;
  placeholder?: string;
  /** What to say when the box holds something that isn't a size. */
  bad: string;
  onSet: (v: number[] | null) => Promise<boolean>;
  onError: (e: string | null) => void;
}) {
  const now = sizes_mm.map(fmt).join(", ");
  const [text, setText] = useState(now);
  useEffect(() => setText(now), [now]);
  const commit = () => {
    const got = parseSizes(text);
    onError(null);
    if (got.kind === "empty" && custom) void onSet(null).then((ok) => ok || setText(now));
    else if (got.kind === "sizes" && got.sizes_mm.map(fmt).join(", ") !== now) void onSet(got.sizes_mm).then((ok) => ok || setText(now));
    else {
      if (got.kind === "bad") onError(bad);
      setText(now);
    }
  };
  return (
    <label className="lengths">
      {label}{" "}
      <input
        aria-label={aria}
        placeholder={placeholder}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      />{" "}
      mm
    </label>
  );
}

/** The boards or sheets of a material you already have. They're cut first, and only the shortfall is bought. */
function OwnedStockEditor({ m, owned, apply }: { m: MaterialLayout; owned: OwnedStock[]; apply: Apply }) {
  const word = pieceWord(m.kind);
  const [row, setRow] = useState<OwnedRow>(EMPTY_ROW);
  const [error, setError] = useState<string | null>(null);
  const set = (next: OwnedStock[]) => apply({ op: "set_stock", material: m.material, owned: next }, ownedLabel(m.name, m.kind, next));
  const add = async () => {
    const got = parseOwnedRow(row, m.kind);
    if ("error" in got) return setError(got.error);
    setError(null);
    if (await set(addOwned(owned, got))) setRow(EMPTY_ROW);
  };
  const box = (key: keyof OwnedRow, aria: string, placeholder?: string) => (
    <input
      className="num"
      inputMode={key === "qty" ? "numeric" : "decimal"}
      aria-label={aria}
      placeholder={placeholder}
      value={row[key]}
      onChange={(e) => setRow({ ...row, [key]: e.target.value })}
      onKeyDown={(e) => e.key === "Enter" && void add()}
    />
  );
  return (
    <div className="owned-stock">
      <div className="owned-title">Your stock</div>
      {owned.length ? (
        <ul className="owned-list small">
          {owned.map((o, i) => (
            <li key={`${o.length_mm}|${o.width_mm}`}>
              {ownedText(o, m.kind)}
              <button className="link" aria-label={`Remove ${ownedText(o, m.kind)}`} onClick={() => void set(removeOwned(owned, i))}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <div className="muted small">{m.kind === "sheet" ? "Sheets" : "Boards"} you already have are cut first, before anything is bought.</div>
      )}
      <div className="stock-fields">
        <span className="owned-add">
          {box("length", `Length of the ${word}s to add, in mm`, "Length")} × {box("width", `Width of the ${word}s to add, in mm`, "Width")} mm,{" "}
          {box("qty", `How many ${word}s to add`)} {row.qty.trim() === "1" ? word : `${word}s`}
        </span>
        <button onClick={() => void add()}>Add</button>
      </div>
      {error && <div className="form-error">{error}</div>}
      {m.left_in_stock.length > 0 && <div className="muted small">Not needed: {m.left_in_stock.map((b) => b.text).join(", ")}.</div>}
    </div>
  );
}
