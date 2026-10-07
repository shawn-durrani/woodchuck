// The HTTP side: it answers this machine's pages and refuses others.

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/index.js";
import { Store } from "../src/store.js";
import { scriptedClient } from "../src/scripted.js";

let dir: string;
let base: string;
let close: () => Promise<void>;
const filed: { title: string; body: string }[] = [];
const pictures: unknown[] = [];

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "woodchuck-http-"));
  const app = createApp({
    dataDir: dir,
    repo: "globex/woodchuck",
    // The tests sync tool requests by hand. The app's own check, 5 s after it starts, would race them on a busy computer.
    watchTools: false,
    client: scriptedClient([]),
    issueLookup: async () => ({ closed: true, completed: true, pr: { number: 7, url: "https://github.com/example/woodchuck/pull/7" } }),
    takePicture: async (req) => {
      pictures.push(req);
      return Buffer.from("png");
    },
    fileIssue: async (title, body) => {
      filed.push({ title, body });
      return "https://github.com/example/woodchuck/issues/99";
    },
  });
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  close = app.close;
});
// Close the app before deleting its folder, so no queued broadcast reads it.
afterAll(async () => {
  await close();
  rmSync(dir, { recursive: true, force: true });
});

const postJson = (p: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

describe("the local server", () => {
  it("creates the example and serves its cut list", async () => {
    expect((await postJson("/api/projects", { name: "Console", example: "record_console" })).status).toBe(200);
    const state = (await (await fetch(`${base}/api/state`)).json()) as { report: { errors: number }; cutlist: { rows: unknown[] } };
    expect(state.report.errors).toBe(1);
    expect(state.cutlist.rows).toHaveLength(12);
    const csv = await (await fetch(`${base}/api/cutlist.csv`)).text();
    expect(csv.split("\n")[0]).toBe("Row,Name,Qty,Material,Length mm,Width mm,Thickness mm,Grain along length,Machining,Shape,Parts");
  });

  it("serves the workshop drawings as a PDF on A4, a page for each sheet", async () => {
    const r = await fetch(`${base}/api/drawings.pdf`);
    expect(r.headers.get("content-type")).toBe("application/pdf");
    expect(r.headers.get("content-disposition")).toMatch(/^attachment; filename=".+-drawings\.pdf"$/);
    const pdf = Buffer.from(await r.arrayBuffer()).toString("latin1");
    expect(pdf.startsWith("%PDF-1.4")).toBe(true);
    // The arrangement, 12 parts, then the cut list, drilling and hardware lists.
    expect(pdf.match(/\/Type \/Page\b/g)).toHaveLength(16);
    expect(pdf).toContain("/Count 16");
    expect(pdf).toContain("/MediaBox [0 0 841.89 595.276]");
    const a3 = Buffer.from(await (await fetch(`${base}/api/drawings.pdf?paper=A3`)).arrayBuffer()).toString("latin1");
    expect(a3).toContain("/MediaBox [0 0 1190.551 841.89]");
    expect(a3).not.toContain("/MediaBox [0 0 841.89 595.276]");
    const sheet = await fetch(`${base}/api/drawings/1.svg`);
    expect(sheet.headers.get("content-type")).toBe("image/svg+xml");
    expect(await sheet.text()).toContain(">2040</text>");
    expect((await fetch(`${base}/api/drawings/17.svg`)).status).toBe(404);
  });

  it("applies your edits as one undoable change and refuses bad ones", async () => {
    expect((await postJson("/api/ops", { ops: [{ op: "set_param", name: "slide_gap", expr: "5", unit: "mm" }] })).status).toBe(200);
    const bad = await postJson("/api/ops", { ops: [{ op: "delete_part", id: "left_side" }] });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toMatch(/still used by/);
    expect((await postJson("/api/undo", {})).status).toBe(200);
  });

  it("makes, refuses and undoes a cut through the same route, the one way in so far", async () => {
    const slope = { op: "set_edge_cut", id: "drawer_side_l", cut: "slope", edge: "top", start: { face: "drawer_side_l.top" }, end: { face: "drawer_side_l.top", offset: "-60" } };
    expect((await postJson("/api/ops", { ops: [slope] })).status).toBe(200);
    type State = {
      derived: { parts: { id: string; profile?: { cuts: { kind: string }[] } }[] };
      cutlist: { rows: { parts: string[]; shape?: string[] }[] };
    };
    const state = (await (await fetch(`${base}/api/state`)).json()) as State;
    expect(state.derived.parts.find((p) => p.id === "drawer_side_l#3")?.profile?.cuts.map((c) => c.kind)).toEqual(["slope"]);
    expect(state.cutlist.rows.find((r) => r.parts.includes("drawer_side_l"))?.shape?.[0]).toMatch(/^top edge sloped from /);
    const bad = await postJson("/api/ops", { ops: [{ ...slope, edge: "left" }] });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toMatch(/broad face of drawer_side_l/);
    expect((await postJson("/api/undo", {})).status).toBe(200);
    const after = (await (await fetch(`${base}/api/state`)).json()) as State;
    expect(after.derived.parts.some((p) => p.profile)).toBe(false);
  });

  it("switches the chat's model for this design, from the allowed list only", async () => {
    expect((await postJson("/api/model", { model: "claude-sonnet-5-5" })).status).toBe(200);
    const state = (await (await fetch(`${base}/api/state`)).json()) as { model: string; models: { id: string }[] };
    expect(state.model).toBe("claude-sonnet-5-5");
    expect(state.models.map((m) => m.id)).toEqual(["claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-1"]);
    expect((await postJson("/api/model", { model: "gpt-9" })).status).toBe(400);
  });

  it("refuses attachments that aren't pictures or PDFs", async () => {
    const r = await postJson("/api/chat", { text: "Like this", images: [{ media_type: "text/html", data: "aGk=" }] });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toMatch(/JPEG, PNG, WebP or GIF/);
  });

  it("says whether a restart would interrupt Claude", async () => {
    expect(await (await fetch(`${base}/api/busy`)).json()).toEqual({ busy: false, reasons: [] });
  });

  it("starts fresh with a blank design and chat, and deletes designs", async () => {
    expect((await postJson("/api/projects", {})).status).toBe(200);
    type S = { project: { slug: string; name: string }; projects: { slug: string }[]; chat: unknown[]; design: { parts: unknown[] } };
    const fresh = (await (await fetch(`${base}/api/state`)).json()) as S;
    expect(fresh.project.name).toBe("New design");
    expect(fresh.chat).toEqual([]);
    expect(fresh.design.parts).toEqual([]);
    const count = fresh.projects.length;
    expect((await postJson("/api/projects/delete", { slug: fresh.project.slug })).status).toBe(200);
    const after = (await (await fetch(`${base}/api/state`)).json()) as S;
    expect(after.projects).toHaveLength(count - 1);
    expect(after.project.slug).not.toBe(fresh.project.slug);
  });

  it("refuses malformed pins and views", async () => {
    const pin = (r: Response) => r.json() as Promise<{ error: string }>;
    const bad = await postJson("/api/chat", { text: "x", pins: [{ n: 1, part: "a", face: "inside", point_mm: [0, 0, 0] }] });
    expect(bad.status).toBe(400);
    expect((await pin(bad)).error).toMatch(/Pins must/);
    const view = await postJson("/api/chat", { text: "x", view: { media_type: "image/gif", data: "aGk=" } });
    expect(view.status).toBe(400);
  });

  it("downloads a design and opens it again as a new one", async () => {
    const file = (await (await fetch(`${base}/api/design.json`)).json()) as { name: string };
    expect((await postJson("/api/projects/import", { design: { nope: true } })).status).toBe(400);
    expect((await postJson("/api/projects/import", { design: file })).status).toBe(200);
    const state = (await (await fetch(`${base}/api/state`)).json()) as { project: { name: string }; versions: { message: string }[] };
    expect(state.project.name).toBe(file.name);
    expect(state.versions[0]!.message).toBe("Opened from a file");
  });

  it("files a missing tool's spec as an issue for Claude Code, once, leaving out where it came up unless you ask", async () => {
    const spec = { name: "scarf_joint", purpose: "Join two short boards end to end.", inputs: "host, guest, slope", effect: "Cuts a slope on both ends", check: "Both slopes show" };
    new Store(dir).addToolRequest({ ...spec, example: "rail_a meets rail_b behind the third drawer" });
    const first = await postJson("/api/tool-requests/issue", { id: "tr_1" });
    expect(await first.json()).toEqual({ ok: true, url: "https://github.com/example/woodchuck/issues/99" });
    await postJson("/api/tool-requests/issue", { id: "tr_1" });
    expect(filed).toHaveLength(1);
    expect(filed[0]!.title).toBe("Build the scarf_joint tool Claude asked for");
    expect(filed[0]!.body).toMatch(/^Claude in Woodchuck needed a tool the app doesn't have yet/);
    // The issue is public, so text from the design stays out of it by default.
    expect(filed[0]!.body).not.toContain("Where it came up");
    expect(filed[0]!.body).not.toContain("third drawer");
    expect(filed[0]!.body).toContain("- **Inputs:** host, guest, slope");
    const state = (await (await fetch(`${base}/api/state`)).json()) as { tool_requests: { status: string; issue_url: string }[] };
    expect(state.tool_requests[0]).toMatchObject({ status: "approved", issue_url: "https://github.com/example/woodchuck/issues/99" });

    // Ticking the box puts it in.
    new Store(dir).addToolRequest({ ...spec, name: "tapered_leg", example: "the front legs taper from 45 to 30" });
    await postJson("/api/tool-requests/issue", { id: "tr_2", include_example: true });
    expect(filed).toHaveLength(2);
    expect(filed[1]!.body).toContain("Where it came up: the front legs taper from 45 to 30");
  });

  it("checks a tool request's status before keeping it", async () => {
    const bad = await postJson("/api/tool-requests/status", { id: "tr_2", status: "shipped" });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe("Pick a status of open, approved, built, declined");
    expect((await postJson("/api/tool-requests/status", { id: "nope", status: "declined" })).status).toBe(404);
    expect((await postJson("/api/tool-requests/status", { id: "tr_2", status: "declined" })).status).toBe(200);
    const state = (await (await fetch(`${base}/api/state`)).json()) as { tool_requests: { id: string; status: string }[] };
    expect(state.tool_requests.map((r) => [r.id, r.status])).toEqual([
      ["tr_1", "approved"],
      ["tr_2", "declined"],
    ]);
  });

  it("marks a sent tool built once its issue's PR has merged", async () => {
    const r = await postJson("/api/tool-requests/sync", {});
    expect(await r.json()).toEqual({ ok: true, changed: [{ id: "tr_1", status: "built" }] });
    const state = (await (await fetch(`${base}/api/state`)).json()) as { tool_requests: { status: string; pr_url: string }[] };
    expect(state.tool_requests[0]).toMatchObject({ status: "built", pr_url: "https://github.com/example/woodchuck/pull/7" });
  });

  it("draws a picture of the design and keeps it with the renders", async () => {
    const r = await fetch(`${base}/api/picture?look=finished&lighting=evening&view=front&w=99999&preview=v1`);
    const j = (await r.json()) as { ok: boolean; url: string };
    expect(j.ok).toBe(true);
    expect(pictures.at(-1)).toEqual({ look: "finished", lighting: "evening", view: "front", width: 2400, height: 800, preview: "v1" });
    expect(await (await fetch(`${base}${j.url}`)).text()).toBe("png");
  });

  it("passes a view change to every open window, but not to render pages", async () => {
    const open = (q = "") =>
      new Promise<WebSocket>((resolve) => {
        const ws = new WebSocket(`${base.replace("http", "ws")}/ws${q}`);
        ws.addEventListener("open", () => resolve(ws), { once: true });
      });
    expect(((await (await postJson("/api/view", { look: "finished" })).json()) as { windows: number }).windows).toBe(0);
    const win = await open();
    const render = await open("?role=render");
    const got = new Promise<unknown>((resolve) =>
      win.addEventListener("message", (m) => {
        const msg = JSON.parse(String(m.data)) as { type: string; view?: unknown };
        if (msg.type === "view") resolve(msg.view);
      }),
    );
    const r = (await (await postJson("/api/view", { look: "finished", view: "front", from: "Crossband" })).json()) as { windows: number; shown: string };
    expect(r).toMatchObject({ windows: 1, shown: "the Finished look and the front view" });
    expect(await got).toEqual({ look: "finished", view: "front", from: "Crossband" });
    expect((await postJson("/api/view", { look: "shiny" })).status).toBe(400);
    expect((await postJson("/api/view", { select: ["nope"] })).status).toBe(400);
    expect((await postJson("/api/view", { drawer: "preview" })).status).toBe(400);
    // Issue #66: a joint to pull apart has to be one of the design's.
    const noJoint = await postJson("/api/view", { focusJoint: "nope" });
    expect(noJoint.status).toBe(400);
    expect(((await noJoint.json()) as { error: string }).error).toMatch(/^There's no joint nope/);
    win.close();
    render.close();
  });

  it("passes an orbit on with its speed, and says so in words", async () => {
    const win = await new Promise<WebSocket>((resolve) => {
      const ws = new WebSocket(`${base.replace("http", "ws")}/ws`);
      ws.addEventListener("open", () => resolve(ws), { once: true });
    });
    const views: unknown[] = [];
    win.addEventListener("message", (m) => {
      const msg = JSON.parse(String(m.data)) as { type: string; view?: unknown };
      if (msg.type === "view") views.push(msg.view);
    });
    const start = (await (await postJson("/api/view", { orbit: "start", from: "Crossband" })).json()) as { windows: number; shown: string };
    expect(start).toMatchObject({ windows: 1, shown: "the model turning 12° a second to the right" });
    const stop = (await (await postJson("/api/view", { orbit: "stop", from: "Crossband" })).json()) as { shown: string };
    expect(stop.shown).toBe("the model held still");
    expect((await postJson("/api/view", { orbit: "start", orbitSpeed: 500 })).status).toBe(400);
    expect((await postJson("/api/view", { orbit: "start", mode: "plan" })).status).toBe(400);
    while (views.length < 2) await new Promise((r) => setTimeout(r, 10));
    expect(views).toEqual([
      { orbit: "start", orbitSpeed: 12, from: "Crossband" },
      { orbit: "stop", from: "Crossband" },
    ]);
    win.close();
  });

  it("keeps a room photo with the design, and takes it away again", async () => {
    expect((await postJson("/api/backdrop", { media_type: "image/gif", data: "R0lG" })).status).toBe(400);
    const r = (await (await postJson("/api/backdrop", { media_type: "image/jpeg", data: Buffer.from("jpeg").toString("base64") })).json()) as { name: string };
    expect(r.name).toMatch(/\.jpg$/);
    const state = (await (await fetch(`${base}/api/state`)).json()) as { backdrop: string | null };
    expect(state.backdrop).toBe(r.name);
    expect(await (await fetch(`${base}/api/references/${r.name}`)).text()).toBe("jpeg");
    await postJson("/api/backdrop/clear", {});
    expect(((await (await fetch(`${base}/api/state`)).json()) as { backdrop: string | null }).backdrop).toBeNull();
  });

  it("says how to add a key when there's none for the AI blend", async () => {
    const saved = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const r = await postJson("/api/blend", { image: "", mask: "", size: "1024x1024" });
      expect(r.status).toBe(501);
      expect(((await r.json()) as { error: string }).error).toMatch(/OPENAI_API_KEY/);
    } finally {
      if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
    }
  });

  it("stars a design without counting it as a change", async () => {
    type P = { slug: string; starred: boolean; changed: string | null };
    const list = async () => ((await (await fetch(`${base}/api/state`)).json()) as { projects: P[]; project: { slug: string } });
    const before = await list();
    const slug = before.project.slug;
    // The version history's .git sits beside the designs and isn't one.
    mkdirSync(path.join(dir, "projects", ".git"), { recursive: true });
    expect((await list()).projects.map((p) => p.slug).filter((s) => s.startsWith("."))).toEqual([]);
    const was = before.projects.find((p) => p.slug === slug)!;
    expect(was.starred).toBe(false);
    expect((await postJson("/api/projects/star", { slug, starred: true })).status).toBe(200);
    const after = (await list()).projects.find((p) => p.slug === slug)!;
    expect(after.starred).toBe(true);
    expect(after.changed).toBe(was.changed);
    await postJson("/api/projects/star", { slug, starred: false });
    expect((await list()).projects.find((p) => p.slug === slug)!.starred).toBe(false);
    expect((await postJson("/api/projects/star", { slug: "nope", starred: true })).status).toBe(404);
  });

  it("stars only a design in the list, so a slug can't reach a folder outside it", async () => {
    const outside = path.join(dir, "outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(path.join(outside, "design.json"), "{}");
    for (const slug of ["../outside", "..", "../..", "../projects/../outside"]) {
      expect((await postJson("/api/projects/star", { slug, starred: true })).status, slug).toBe(404);
    }
    expect(existsSync(path.join(outside, "settings.json"))).toBe(false);
    expect(existsSync(path.join(dir, "settings.json"))).toBe(false);
  });

  it("refuses other sites and non-JSON posts", async () => {
    expect((await postJson("/api/undo", {}, { origin: "https://example.com" })).status).toBe(403);
    // fetch won't send a different Host header, so use a raw request.
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(`${base}/api/state`, { headers: { host: "evil.example" } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(403);
    expect((await fetch(`${base}/api/undo`, { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" })).status).toBe(415);
  });
});
