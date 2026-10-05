// Claude's replies are plain text, but sometimes carry a little Markdown:
// **bold**, `code`, lists and tables. This draws those instead of showing
// the marks. It builds React elements, never HTML, so nothing in a reply
// can inject markup.

import type { ReactNode } from "react";

const ITEM = /^\s*([-*•]|\d+[.)])\s+/;

/** Bold and code inside one line. */
function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*\n]+\*\*|`[^`\n]+`)/g).map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) return <code key={i}>{part.slice(1, -1)}</code>;
    return part;
  });
}

export type Align = "left" | "center" | "right" | null;

/**
 * A table row's cells, as GitHub reads them. The pipes at either end are
 * optional, and `\|` is a pipe inside a cell.
 */
export function cells(line: string): string[] {
  const out: string[] = [];
  let cell = "";
  const row = line.trim();
  for (let i = 0; i < row.length; i++) {
    const ch = row[i]!;
    if (ch === "\\" && row[i + 1] === "|") {
      cell += "|";
      i++;
    } else if (ch === "|") {
      if (i > 0) out.push(cell.trim());
      cell = "";
    } else cell += ch;
  }
  if (cell.trim() || !row.endsWith("|")) out.push(cell.trim());
  return out;
}

/** The line under a table's header, such as `|---|:--:|--:|`, as each column's alignment. Null for any other line. */
export function separator(line: string): Align[] | null {
  if (!line.includes("|")) return null;
  const marks = cells(line);
  if (!marks.length || !marks.every((m) => /^:?-+:?$/.test(m))) return null;
  return marks.map((m) => (m.startsWith(":") && m.endsWith(":") ? "center" : m.endsWith(":") ? "right" : m.startsWith(":") ? "left" : null));
}

export interface Table {
  head: string[];
  align: Align[];
  body: string[][];
  /** The line after the table. */
  end: number;
}

/**
 * The table that starts at this line, if one does: a header row with a
 * pipe, then a separator with as many cells. Its body runs on while lines
 * hold a pipe. A short row is padded, and a long one widens the table, so
 * nothing Claude wrote goes missing.
 */
export function tableAt(lines: string[], i: number): Table | null {
  const first = lines[i];
  const under = lines[i + 1];
  if (first === undefined || under === undefined || !first.includes("|")) return null;
  const align = separator(under);
  const head = cells(first);
  if (!align || align.length !== head.length) return null;
  const body: string[][] = [];
  let end = i + 2;
  while (end < lines.length && lines[end]!.includes("|")) body.push(cells(lines[end++]!));
  const width = Math.max(head.length, ...body.map((r) => r.length));
  const pad = <T,>(r: T[], fill: T) => [...r, ...Array<T>(width - r.length).fill(fill)];
  return { head: pad(head, ""), align: pad(align, null), body: body.map((r) => pad(r, "")), end };
}

/** A table scrolls sideways inside its message when it's wider than the chat. */
function TableView({ head, align, body }: Table) {
  const style = (c: number) => (align[c] ? { textAlign: align[c]! } : undefined);
  return (
    <div className="md-table">
      <table>
        <thead>
          <tr>
            {head.map((h, c) => (
              <th key={c} style={style(c)}>
                {inline(h)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, r) => (
            <tr key={r}>
              {row.map((cell, c) => (
                <td key={c} style={style(c)}>
                  {inline(cell)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** One paragraph: tables, runs of list items as lists, and other lines as lines. */
function Block({ text }: { text: string }) {
  const out: ReactNode[] = [];
  let items: string[] = [];
  let ordered = false;
  let lines: string[] = [];
  const flushItems = () => {
    if (!items.length) return;
    const list = items.map((it, i) => <li key={i}>{inline(it.replace(ITEM, ""))}</li>);
    out.push(ordered ? <ol key={out.length}>{list}</ol> : <ul key={out.length}>{list}</ul>);
    items = [];
  };
  const flushLines = () => {
    if (!lines.length) return;
    out.push(
      <p key={out.length}>
        {lines.flatMap((l, i) => (i ? [<br key={`b${i}`} />, ...inline(l)] : inline(l)))}
      </p>,
    );
    lines = [];
  };
  const all = text.split("\n");
  for (let i = 0; i < all.length; i++) {
    const line = all[i]!;
    const table = tableAt(all, i);
    if (table) {
      flushItems();
      flushLines();
      out.push(<TableView key={out.length} {...table} />);
      i = table.end - 1;
    } else if (ITEM.test(line)) {
      flushLines();
      if (!items.length) ordered = /^\s*\d/.test(line);
      items.push(line);
    } else {
      flushItems();
      lines.push(line);
    }
  }
  flushItems();
  flushLines();
  return <>{out}</>;
}

export function RichText({ text }: { text: string }) {
  return (
    <>
      {text.split(/\n{2,}/).map((block, i) => (
        <Block key={i} text={block} />
      ))}
    </>
  );
}
