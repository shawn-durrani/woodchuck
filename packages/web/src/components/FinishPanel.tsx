// The Finish tab: choose what to finish (the faces or pieces you've
// selected, all of one timber, or everything in a material), then click a
// colour. Each click
// is one undoable change, and Claude hears about it. Also sets each
// material's timber and says how much oil the design needs.

import { useEffect, useState } from "react";
import {
  PALETTES,
  RAW,
  SPECIES,
  SPECIES_IDS,
  FACES,
  finishOn,
  finishSchedule,
  finishesWithin,
  finishLabel,
  finishedColour,
  speciesOf,
  type Face,
  type FinishColour,
  type FinishPalette,
  type Material,
} from "@woodchuck/core";
import { post, type ServerState } from "../api";
import { facesOf, finishTargets } from "../select";

type Target = { kind: "faces" } | { kind: "parts" } | { kind: "materials"; key: string; ids: string[]; label: string };

// The short Osmo card first, then Linolie's long one.
const SHOWN = [...PALETTES].sort((a, b) => a.colours.length - b.colours.length);

const FACE_LABEL: Record<Face, string> = { top: "Top", bottom: "Bottom", front: "Front", back: "Back", left: "Left", right: "Right" };
const FACE_ORDER: Face[] = ["top", "bottom", "front", "back", "left", "right"];

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function FinishPanel({
  state,
  selection,
  faces,
  faceMode,
  onFaceMode,
  faceFilter,
  onFaceFilter,
  lastFace,
  look,
  onShowFinished,
}: {
  state: ServerState;
  selection: string[];
  faces: string[];
  /** Clicks on the model pick single faces rather than whole pieces. */
  faceMode: boolean;
  onFaceMode: (on: boolean) => void;
  /** Which faces of the selected pieces a colour goes on. */
  faceFilter: Face[];
  onFaceFilter: (f: Face[]) => void;
  /** The face under the last click, as "part.face". */
  lastFace: string | null;
  look: "plain" | "finished";
  onShowFinished: () => void;
}) {
  const { design } = state;
  const parts = state.derived.parts;
  const [chosen, setChosen] = useState<string | null>(null);
  // A new selection is what you mean to finish next.
  const picked = `${faces.join(",")}|${selection.join(",")}`;
  useEffect(() => setChosen(null), [picked]);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Everything you can finish at once: what's selected, each timber used by
  // more than one material, and each material.
  const pieceCount = (ids: string[]) => parts.filter((p) => ids.includes(p.material) && !p.decor && !p.unverified).length;
  const options: Target[] = [];
  if (faces.length) options.push({ kind: "faces" });
  if (selection.length) options.push({ kind: "parts" });
  const bySpecies = new Map<string, string[]>();
  for (const m of design.materials) bySpecies.set(speciesOf(m).id, [...(bySpecies.get(speciesOf(m).id) ?? []), m.id]);
  for (const [sp, ids] of bySpecies) {
    if (ids.length > 1) options.push({ kind: "materials", key: `species:${sp}`, ids, label: `All ${SPECIES[sp]!.name} · ${plural(pieceCount(ids), "piece")}` });
  }
  for (const m of design.materials) {
    options.push({ kind: "materials", key: `material:${m.id}`, ids: [m.id], label: `${m.name} · ${plural(pieceCount([m.id]), "piece")}` });
  }
  const keyOf = (t: Target) => (t.kind === "materials" ? t.key : t.kind);
  const target: Target | null = options.find((o) => keyOf(o) === chosen) ?? options[0] ?? null;

  // The faces a colour lands on, as "part.face", and the keys to send.
  const allFaces = faceFilter.length === FACES.length;
  const pieceTargets = finishTargets(selection, parts);
  const targets =
    target?.kind === "faces"
      ? finishTargets(faces, parts)
      : target?.kind === "parts"
        ? allFaces
          ? pieceTargets
          : pieceTargets.flatMap((t) => faceFilter.map((f) => `${t}.${f}`))
        : target
          ? target.ids.map((id) => `material:${id}`)
          : [];
  // Colours set more closely inside the target would hide the new one, so
  // a colour replaces them: a piece's own faces, or everything in a material.
  const hidden =
    target?.kind === "materials"
      ? finishesWithin(design, target.ids)
      : target?.kind === "parts" && allFaces
        ? pieceTargets.flatMap((t) => FACES.map((f) => `${t}.${f}`)).filter((k) => design.finishes?.[k] !== undefined)
        : [];

  // The timber the swatches show: the target material's, or the first selected part's.
  const firstPart = parts.find((p) => p.id === (target?.kind === "faces" ? faces[0]?.split(".")[0] : selection[0]));
  const material: Material | undefined =
    target?.kind === "materials" ? design.materials.find((m) => m.id === target.ids[0]) : design.materials.find((m) => m.id === firstPart?.material);
  const species = speciesOf(material);

  // What's on the target now, if it's all the same.
  const current = (() => {
    if (!target) return null;
    const found = new Set<string>();
    const pick =
      target.kind === "faces"
        ? faces
        : target.kind === "parts"
          ? selection.flatMap((id) => faceFilter.map((f) => `${id}.${f}`))
          : facesOf(parts.filter((p) => target.ids.includes(p.material) && !p.decor && !p.unverified).map((p) => p.id));
    for (const key of pick) {
      const dot = key.lastIndexOf(".");
      const p = parts.find((x) => x.id === key.slice(0, dot));
      if (p) found.add(finishOn(design, p, key.slice(dot + 1) as Face) ?? RAW);
    }
    return found.size === 1 ? [...found][0]! : found.size ? "mixed" : null;
  })();

  const apply = async (finish: string | null) => {
    if (!targets.length) return;
    setError(null);
    if (finish && look === "plain") onShowFinished();
    const what =
      target?.kind === "materials"
        ? target.key.startsWith("species:")
          ? `all ${SPECIES[target.key.slice(8)]?.name ?? "of it"}`
          : `all ${material?.name ?? target.ids[0]}`
        : targets.length === 1
          ? targets[0]
          : target?.kind === "parts"
            ? `${plural(selection.length, "piece")}${allFaces ? "" : ` (${faceFilter.join(", ")})`}`
            : plural(targets.length, "face");
    const label = finish ? `Finish ${what} with ${finishLabel(finish)}` : `Take the finish off ${what}`;
    const ops: unknown[] = [{ op: "set_finish", targets, finish }];
    if (finish && hidden.length) ops.push({ op: "set_finish", targets: hidden, finish: null });
    const r = await post("/api/ops", { ops, label });
    if (!r.ok) setError(r.error ?? "That didn't work");
  };

  const setSpecies = async (m: Material, id: string) => {
    setError(null);
    const r = await post("/api/ops", { ops: [{ op: "define_material", ...m, species: id }], label: `${m.name} is ${SPECIES[id]?.name ?? id}` });
    if (!r.ok) setError(r.error ?? "That didn't work");
  };

  const q = search.trim().toLowerCase();
  const matches = (c: FinishColour, p: FinishPalette) =>
    !q || c.name.toLowerCase().includes(q) || String(c.number ?? "") === q || p.maker.toLowerCase().includes(q);
  // A palette shown with its maker's photo beside each estimate, which the legend explains.
  const photographed = SHOWN.find((p) => p.photographed_on && p.colours.some((c) => c.swatch && matches(c, p)));
  const schedule = finishSchedule(design, parts);

  if (!design.materials.length) {
    return <div className="empty">Once the design has a material, you can choose its timber and finish here.</div>;
  }

  return (
    <div className="panel-body finish-panel">
      {look === "plain" && (
        <p className="notice small">
          The Plain look doesn't show finishes.{" "}
          <button className="link" onClick={onShowFinished}>
            Show them
          </button>
        </p>
      )}
      <h4 className="first">What to finish</h4>
      <div className="target-list" role="radiogroup" aria-label="What a colour goes on">
        {options.map((o) => {
          const k = keyOf(o);
          const label =
            o.kind === "faces"
              ? `Selected faces · ${faces.length}`
              : o.kind === "parts"
                ? `Selected: ${selection.slice(0, 3).join(", ")}${selection.length > 3 ? ` and ${selection.length - 3} more` : ""}`
                : o.label;
          return (
            <button
              key={k}
              role="radio"
              aria-checked={target !== null && keyOf(target) === k}
              className={`target-option ${target && keyOf(target) === k ? "on" : ""}`}
              data-place={`target:${k}`}
              onClick={() => setChosen(k)}
            >
              {label}
            </button>
          );
        })}
      </div>
      {target?.kind === "parts" && (
        <div className="face-filter">
          <span className="muted small">Faces</span>
          {FACE_ORDER.map((f) => {
            const on = faceFilter.includes(f);
            return (
              <button
                key={f}
                className={`face-chip ${on ? "on" : ""}`}
                aria-pressed={on}
                title={on ? `Leave the ${f} face out` : `Include the ${f} face`}
                onClick={() => onFaceFilter(on ? faceFilter.filter((x) => x !== f) : [...faceFilter, f])}
              >
                {FACE_LABEL[f]}
              </button>
            );
          })}
          {!allFaces && (
            <button className="link small" onClick={() => onFaceFilter([...FACES])}>
              all
            </button>
          )}
        </div>
      )}
      {target?.kind === "parts" && (
        <p className="muted small">
          {allFaces ? "Untick a face to leave it out, such as a back against the wall." : `The colour goes on the ${faceFilter.length ? faceFilter.join(", ") : "no"} face${faceFilter.length === 1 ? "" : "s"}, shown in blue.`}
          {selection.length === 1 && lastFace?.startsWith(`${selection[0]}.`) && (faceFilter.length !== 1 || !lastFace.endsWith(`.${faceFilter[0]}`)) && (
            <>
              {" "}
              <button className="link" onClick={() => onFaceFilter([lastFace.slice(lastFace.lastIndexOf(".") + 1) as Face])}>
                Only the {lastFace.slice(lastFace.lastIndexOf(".") + 1)} face you clicked
              </button>
            </>
          )}
        </p>
      )}
      <p className="small">
        Now: {current === "mixed" ? "a mix of finishes" : finishLabel(current ?? undefined)}
        {target?.kind !== "materials" && current && (
          <>
            {" "}
            <button className="link" onClick={() => void apply(null)} title="Clear these, so they take their piece's or material's finish">
              use the piece or material finish
            </button>
          </>
        )}
      </p>
      {target?.kind === "materials" && hidden.length > 0 && (
        <p className="muted small">
          {plural(new Set(hidden.map((k) => k.split(/[.#]/)[0])).size, "piece")} in it {hidden.length === 1 ? "has" : "have"} a colour of {hidden.length === 1 ? "its" : "their"} own. A colour here replaces {hidden.length === 1 ? "it" : "them"} too, so everything matches.
        </p>
      )}
      <div className="row">
        <span className="muted small">Clicking the model picks</span>
        <div className="seg" role="group" aria-label="What a click on the model picks">
          <button className={faceMode ? "" : "on"} onClick={() => onFaceMode(false)} title="A click picks the whole piece">
            Whole pieces
          </button>
          <button className={faceMode ? "on" : ""} onClick={() => onFaceMode(true)} title="A click picks just the face under it">
            Single faces
          </button>
        </div>
      </div>
      {faceMode && <p className="muted small">Click faces to pick them; shift-click adds or removes one. In Box mode, dragging takes every face inside, hidden ones too.</p>}
      {error && <p className="form-error">{error}</p>}
      <input className="finish-search" placeholder="Search colours by name or number" value={search} onChange={(e) => setSearch(e.target.value)} />
      <h4>Finishes</h4>
      <p className="muted small swatch-legend">
        {photographed
          ? `Left: on ${species.name}, estimated · Right: ${photographed.maker}'s photo on ${SPECIES[photographed.photographed_on!]?.name}`
          : `On ${species.name}, estimated`}
      </p>
      <div className="swatches">
        {!q && (
          <button className={`swatch ${current === RAW ? "on" : ""}`} data-place={`swatch:${RAW}`} title="Bare timber, no finish" onClick={() => void apply(RAW)}>
            <span className="chip-colour" style={{ background: finishedColour(species.id, RAW) }} />
            <span className="swatch-name">Bare timber</span>
          </button>
        )}
        {SHOWN.flatMap((p) => {
          const photo = p.photographed_on ? SPECIES[p.photographed_on]?.name : undefined;
          return p.colours
            .filter((c) => matches(c, p))
            .map((c) => {
              const id = `${p.id}/${c.id}`;
              const label = finishLabel(id);
              return (
                <button
                  key={id}
                  className={`swatch ${current === id ? "on" : ""}`}
                  data-place={`swatch:${id}`}
                 
                  title={`${p.maker} ${p.name} ${label}.${c.note ? ` ${c.note}.` : ""} ${photo && c.swatch ? `Left: on ${species.name}, estimated. Right: ${p.maker}'s photo on ${photo}.` : `On ${species.name}, estimated.`}`}
                  onClick={() => void apply(id)}
                >
                  <span className="chip-colour">
                    <span style={{ background: finishedColour(species.id, id) }} />
                    {photo && c.swatch && <span style={{ background: c.swatch }} />}
                  </span>
                  <span className="swatch-name">{label}</span>
                </button>
              );
            });
        })}
      </div>
      <p className="muted small">
        {SHOWN.map((p, i) => (
          <span key={p.id}>
            {i > 0 && " "}
            {p.maker} {p.name}:{" "}
            <a href={p.url} target="_blank" rel="noreferrer noopener">
              {p.source.toLowerCase()}
            </a>
            {"."}
          </span>
        ))}{" "}
        Try a sample on an offcut before you commit.
      </p>

      <h4>Timber</h4>
      {design.materials.map((m) => (
        <label key={m.id} className="row small">
          <span>{m.name}</span>
          <select value={speciesOf(m).id} onChange={(e) => void setSpecies(m, e.target.value)}>
            {SPECIES_IDS.map((id) => (
              <option key={id} value={id}>
                {SPECIES[id]!.name}
                {!m.species && speciesOf(m).id === id ? " (assumed)" : ""}
              </option>
            ))}
          </select>
        </label>
      ))}

      <h4>Oil needed</h4>
      {schedule.length ? (
        <table className="small">
          <tbody>
            {schedule.map((u) => (
              <tr key={u.finish}>
                <td>{u.label}</td>
                <td>{u.area_m2} m²</td>
                <td>{`about ${u.litres} L`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted small">Nothing is finished yet.</p>
      )}
      <p className="muted small">
        Counts every finished face at each maker's coverage for two coats ({SHOWN.map((p) => `${p.maker} ${p.m2_per_litre} m² a litre`).join(", ")}). Buy a little extra for end grain, which drinks more.
      </p>
    </div>
  );
}
