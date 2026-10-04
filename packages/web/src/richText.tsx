// Claude's replies are plain text, but sometimes carry a little Markdown:
// **bold**, `code` and lists. This draws those instead of showing the
// marks. It builds React elements, never HTML, so nothing in a reply can
// inject markup.

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

/** One paragraph: runs of list items become lists, other lines stay as lines. */
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
  for (const line of text.split("\n")) {
    if (ITEM.test(line)) {
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
