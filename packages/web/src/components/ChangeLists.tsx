// What a suggested change does, in three short lists: what changes, the
// problems it brings and the ones it fixes. The waiting bar shows them for
// the change Claude is waiting on, and the drawer for an older one.

import type { PreviewResult } from "../ghost";

export function ChangeLists({ result, removed, compact = false }: { result: PreviewResult; removed: string[]; compact?: boolean }) {
  const Head = compact ? "div" : "h4";
  return (
    <div className={compact ? "change-lists compact" : "change-lists"}>
      {result.changes.length + removed.length > 0 && (
        <>
          <Head className="change-head">What changes</Head>
          <ul className="small">
            {result.changes.map((c) => (
              <li key={c}>{c}</li>
            ))}
            {removed.length > 0 && <li title={result.removed.join(", ")}>Removes {removed.join(", ")}</li>}
          </ul>
        </>
      )}
      {result.newProblems.length > 0 && (
        <>
          <Head className="change-head bad-text">New problems</Head>
          <ul className="small bad-text">
            {result.newProblems.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        </>
      )}
      {result.fixes.length > 0 && (
        <>
          <Head className="change-head">Fixes</Head>
          <ul className="small">
            {result.fixes.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
