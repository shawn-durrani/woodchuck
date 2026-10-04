// A missing tool's card. Where it came up quotes the design, so the
// box that puts it in a public issue starts unticked. With no repository
// named, GitHub is off, and the card keeps the request and says how to turn
// it on.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ToolRequest } from "../src/api.js";
import { MissingTool, specForClaudeCode } from "../src/components/MissingTool.js";
import { exampleConsent, TOOL_KEPT } from "../src/github.js";

const r: ToolRequest = {
  id: "tr_1",
  name: "scarf_joint",
  purpose: "Join two short boards end to end.",
  example: "rail_a meets rail_b behind the third drawer",
  inputs: "host, guest, slope",
  effect: "Cuts a slope on both ends",
  check: "Both slopes show",
  count: 1,
  status: "open",
};
const card = (repo: string | null, over: Partial<ToolRequest> = {}) => renderToStaticMarkup(createElement(MissingTool, { r: { ...r, ...over }, repo }));
const text = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'");

describe("a missing tool's card", () => {
  it("asks before the issue quotes the design, with the box unticked", () => {
    const html = card("globex/woodchuck");
    const box = /<input type="checkbox"[^>]*>/.exec(html)![0];
    expect(box).not.toContain("checked");
    expect(text(html)).toContain(exampleConsent("globex/woodchuck"));
    expect(exampleConsent("globex/woodchuck")).toBe("Include where it came up. It quotes your design, and anyone who can see globex/woodchuck can read the issue.");
    expect(text(html)).toContain("File as a GitHub issue for Claude Code");
    expect(html).toContain('title="Opens an issue on globex/woodchuck with this spec, for Claude Code to build"');
  });

  it("keeps the request in the app while GitHub is off, and says how to turn it on", () => {
    const html = text(card(null));
    expect(html).toContain(TOOL_KEPT);
    expect(TOOL_KEPT).toContain("add WOODCHUCK_REPO=owner/name to the .env file in the Woodchuck folder, then restart Woodchuck");
    expect(html).not.toContain("File as a GitHub issue");
    expect(html).not.toContain("Include where it came up");
    // The spec is still there to copy by hand.
    expect(html).toContain("Copy the spec");
    expect(specForClaudeCode(r)).toContain("Where it came up: rail_a meets rail_b behind the third drawer");
  });

  it("links an issue already filed, with no box to tick", () => {
    const html = card("globex/woodchuck", { issue_url: "https://github.com/globex/woodchuck/issues/4", status: "approved" });
    expect(html).not.toContain('type="checkbox"');
    expect(text(html)).toContain("Filed on GitHub for Claude Code as issue #4");
  });

  it("says a built tool arrives with the next update, not that it's live", () => {
    const html = text(card("globex/woodchuck", { status: "built", pr_url: "https://github.com/globex/woodchuck/pull/7" }));
    expect(html).toContain("It's built and merged (PR #7). Woodchuck has it once it's updated.");
    expect(html).not.toMatch(/live/);
  });
});
