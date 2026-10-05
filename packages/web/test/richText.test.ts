import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { cells, RichText, separator, tableAt } from "../src/richText.js";

const html = (text: string) => renderToStaticMarkup(createElement(RichText, { text }));

describe("Claude's replies", () => {
  it("draws bold, code and lists instead of their marks", () => {
    expect(html("Ideas:\n- **Option A:** a fin\n- Option B\n\nI'd pick `B`.")).toBe(
      "<p>Ideas:</p><ul><li><strong>Option A:</strong> a fin</li><li>Option B</li></ul><p>I&#x27;d pick <code>B</code>.</p>",
    );
  });

  it("numbers numbered lists and keeps single line breaks", () => {
    expect(html("1. Cut\n2. Glue")).toBe("<ol><li>Cut</li><li>Glue</li></ol>");
    expect(html("one\ntwo")).toBe("<p>one<br/>two</p>");
  });

  it("never turns text into markup", () => {
    expect(html("<b>hi</b> **<i>x</i>**")).toBe("<p>&lt;b&gt;hi&lt;/b&gt; <strong>&lt;i&gt;x&lt;/i&gt;</strong></p>");
  });
});

// Seen in a demo: a cut list written as a Markdown table showed its raw pipes.
describe("tables in Claude's replies", () => {
  const table = (head: string, rows: string) => `<div class="md-table"><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;

  it("draws a header, a separator and body rows as a table", () => {
    expect(html("| Part | Qty | Size |\n|---|---|---|\n| Side | 2 | 600 × 300 |\n| Shelf | 3 | 562 × 280 |")).toBe(
      table("<th>Part</th><th>Qty</th><th>Size</th>", "<tr><td>Side</td><td>2</td><td>600 × 300</td></tr><tr><td>Shelf</td><td>3</td><td>562 × 280</td></tr>"),
    );
    // The pipes at either end are optional, as on GitHub.
    expect(html("Part | Qty\n--- | ---\nSide | 2")).toBe(table("<th>Part</th><th>Qty</th>", "<tr><td>Side</td><td>2</td></tr>"));
  });

  it("draws bold and code inside cells, and keeps each column's alignment", () => {
    expect(html("| **Part** | Qty |\n|:---|---:|\n| `left_side`, `right_side` | **2** |")).toBe(
      `<div class="md-table"><table><thead><tr><th style="text-align:left"><strong>Part</strong></th><th style="text-align:right">Qty</th></tr></thead>` +
        `<tbody><tr><td style="text-align:left"><code>left_side</code>, <code>right_side</code></td><td style="text-align:right"><strong>2</strong></td></tr></tbody></table></div>`,
    );
    expect(html("| a |\n|:-:|\n| b |")).toContain('<td style="text-align:center">b</td>');
    // A pipe written as \| stays in its cell.
    expect(html("| Joint | Note |\n|---|---|\n| dado | 6 \\| 9 mm |")).toContain("<td>6 | 9 mm</td>");
  });

  it("pads a short row and widens the table for a long one, so nothing goes missing", () => {
    expect(html("| Part | Qty | Size |\n|---|---|---|\n| Side | 2\n| Top | 1 | 900 × 400 | solid |")).toBe(
      table(
        "<th>Part</th><th>Qty</th><th>Size</th><th></th>",
        "<tr><td>Side</td><td>2</td><td></td><td></td></tr><tr><td>Top</td><td>1</td><td>900 × 400</td><td>solid</td></tr>",
      ),
    );
  });

  it("sits among the lines and lists around it", () => {
    expect(html("**Birch ply, 18 mm**\n| Part | Qty |\n|---|---|\n| Side | 2 |\nThat's all of it.\n- Plane first")).toBe(
      `<p><strong>Birch ply, 18 mm</strong></p>${table("<th>Part</th><th>Qty</th>", "<tr><td>Side</td><td>2</td></tr>")}<p>That&#x27;s all of it.</p><ul><li>Plane first</li></ul>`,
    );
    // A header with no rows under it is still a table.
    expect(html("| Part | Qty |\n|---|---|")).toBe(table("<th>Part</th><th>Qty</th>", ""));
  });

  it("leaves pipes alone that aren't a table", () => {
    expect(html("Use a dado | or a groove.")).toBe("<p>Use a dado | or a groove.</p>");
    // Rows with no separator under the first.
    expect(html("a | b\nc | d")).toBe("<p>a | b<br/>c | d</p>");
    // A separator with a different number of cells.
    expect(html("| a | b |\n|---|\n| c | d |")).toBe("<p>| a | b |<br/>|---|<br/>| c | d |</p>");
    // A rule of dashes under a line isn't a separator.
    expect(html("Cut list\n---")).toBe("<p>Cut list<br/>---</p>");
  });

  it("never turns a cell into markup", () => {
    expect(html("| <b>x</b> |\n|---|\n| <img src=x onerror=alert(1)> |")).toBe(
      table("<th>&lt;b&gt;x&lt;/b&gt;</th>", "<tr><td>&lt;img src=x onerror=alert(1)&gt;</td></tr>"),
    );
  });
});

describe("a table's rows", () => {
  it("are split on pipes, with the outer pipes optional and \\| kept as a pipe", () => {
    expect(cells("| a | b |")).toEqual(["a", "b"]);
    expect(cells("a | b")).toEqual(["a", "b"]);
    expect(cells("| | b |")).toEqual(["", "b"]);
    expect(cells("| a \\| b |")).toEqual(["a | b"]);
    expect(separator("|:--|:-:|--:|---|")).toEqual(["left", "center", "right", null]);
    expect(separator("---")).toBeNull();
    expect(separator("| a | --- |")).toBeNull();
  });

  it("end at the first line with no pipe", () => {
    const lines = ["| a |", "|---|", "| 1 |", "| 2 |", "done", "| 3 |"];
    expect(tableAt(lines, 0)).toMatchObject({ head: ["a"], body: [["1"], ["2"]], end: 4 });
    expect(tableAt(lines, 2)).toBeNull();
  });
});
