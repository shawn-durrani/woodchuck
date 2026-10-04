import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RichText } from "../src/richText.js";

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
