// A real part from the library, or one Claude has proposed: where its
// numbers came from, its figures, and a drawing of its model.

import { useMemo } from "react";
import { renderPartPreview, type LibraryPart } from "@woodchuck/core";
import { usePaper } from "../theme";

export function PartCard({ part, children, id }: { part: LibraryPart; children?: React.ReactNode; id?: string }) {
  const paper = usePaper();
  const preview = useMemo(() => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(renderPartPreview(part, 360, 220, paper))}`, [part, paper]);
  return (
    <div className="card part-card" id={id}>
      <div className="card-title">
        {part.name} <span className="muted small">{part.kind.replace(/_/g, " ")}</span>
      </div>
      <div className="small muted">
        {[part.maker, part.model, part.sku && `SKU ${part.sku}`].filter(Boolean).join(" · ")} <code>{part.id}</code>
      </div>
      <img className="part-preview" src={preview} alt={`Model of ${part.name}`} />
      <table className="kv small">
        <tbody>
          {Object.entries(part.specs).map(([k, v]) => (
            <tr key={k}>
              <th>{k.replace(/_/g, " ")}</th>
              <td>{String(v)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {part.mounting && <p className="small">{part.mounting}</p>}
      {part.notes && <p className="small muted">{part.notes}</p>}
      <div className="card-sub">Where the numbers came from</div>
      <ul className="small">
        {part.sources.map((s, i) => (
          <li key={i}>
            {s.url ? (
              <a href={s.url} target="_blank" rel="noreferrer noopener">
                {s.title || s.url}
              </a>
            ) : (
              s.title
            )}
            {s.note && <span className="muted"> {s.note}</span>}
          </li>
        ))}
      </ul>
      {children}
    </div>
  );
}
