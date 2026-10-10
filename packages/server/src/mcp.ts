// Woodchuck as an MCP server, so a chat elsewhere (Crossband) can work on
// the open design. It speaks MCP over stdio and talks to the running app
// over HTTP, so every change shows live in the Woodchuck window too.
//
// Nothing here edits a design itself. Messages go to Woodchuck's own
// Claude, which changes the design only through its woodworking tools,
// and previews are answered the same way as in the app. Colours and the
// design's existing parameters can also change straight away, through the
// same operations as the app's own controls.
//
// Any tool but the two that send Woodchuck's Claude a message also asks the
// app to warm its prompt cache, which it does only once the cache has gone
// cold, so the next message doesn't wait on a cold cache.
//
// Run it with: tsx packages/server/src/mcp.ts (WOODCHUCK_URL defaults to
// http://127.0.0.1:8905).

import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { JOINT_TYPES, ORBIT_SPEED, SIDE_TABS, type JointType } from "@woodchuck/core";
import { background, describe, hasReply, itemsAfter, progressText, type Item, type Progress } from "./progress.js";
import type { AppState } from "./answers.js";
import { READ_PARTS } from "./reads.js";

const BASE = (process.env.WOODCHUCK_URL ?? "http://127.0.0.1:8905").replace(/\/$/, "");
/** True when an address works only on the computer it names, as 127.0.0.1 does. */
export function localOnly(base: string): boolean {
  const host = new URL(base).hostname.replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "::1" || host.endsWith(".localhost") || /^127\./.test(host);
}
/** The app's links open only on the computer it runs on, so they're no use in a reply read elsewhere. */
const LOCAL = localOnly(BASE);
const LOCAL_LINKS = "These links open only on the computer Woodchuck runs on, so they're no use in a reply to someone on another device.";

/** Named in the note the Woodchuck window shows when its view is changed. */
const CALLER = process.env.WOODCHUCK_CALLER ?? "another app";
/** The caller's name at the start of a line. */
const CALLER_AT_START = CALLER.charAt(0).toUpperCase() + CALLER.slice(1);

/**
 * How long woodchuck_ask waits for a quick answer before handing the work
 * over. A chat app holds its turn while a tool runs, so it's kept short.
 */
const ASK_WAIT_MS = 6_000;
/** How long woodchuck_reply waits for a request to finish. */
const REPLY_WAIT_MS = 8_000;

export { describe, itemsAfter, type Item };

/** Every design by id, with the open one's file to download. */
export function designList(s: AppState): string {
  const all = s.projects ?? [];
  return [
    "Designs, by id:",
    ...all.map((p) => `- ${p.slug}: ${p.name}${p.starred ? ", starred" : ""}${p.slug === s.project.slug ? ", open" : ""}${p.changed ? `, changed ${p.changed.slice(0, 10)}` : ""}`),
    `The open design's file: ${BASE}/api/design.json`,
    ...(LOCAL ? ["That link opens only on the computer Woodchuck runs on. woodchuck_read with what file gives the file itself."] : []),
  ].join("\n");
}

/**
 * What woodchuck_picture says with its picture. The picture comes with the
 * result, and a link that opens only on this computer would show as a
 * broken image anywhere else, so it's offered for a reply only when it
 * opens elsewhere too.
 */
export function pictureText(name: string, preview: boolean, url: string, local: boolean): string {
  const what = `Here's ${name}${preview ? " with the preview's change, not yet applied" : ""}. The picture comes with this result, so a chat that shows a tool's pictures already shows it to the woodworker.`;
  return local
    ? `${what} Its link, ${url}, opens only on the computer Woodchuck runs on, so don't put it in a reply.`
    : `${what} For a chat that can't, put this line in your reply, on its own, to show it:\n\n![${name}](${url})`;
}

/** The workshop drawings by sheet, with links to print them. */
export function drawingsText(name: string, titles: string[], paper: string, base: string, local: boolean, notes = false): string {
  return [
    `Workshop drawings for ${name}, on ${paper}, in ${titles.length} sheets:`,
    ...titles.map((t, i) => `- Sheet ${i + 1}: ${t}`),
    "Give sheet, by its number, to get that sheet as a picture. woodchuck_read with what parts gives the part sheets' words.",
    `To print at 100%: ${base}/api/drawings.pdf?paper=${paper}${notes ? "&notes=1" : ""}`,
    `Cutting plan alone, to print and take to the saw: ${base}/api/cutting-plan.pdf?paper=${paper}`,
    `Cut list, as a spreadsheet file: ${base}/api/cutlist.csv`,
    ...(local ? [LOCAL_LINKS] : []),
  ].join("\n");
}

/** The largest number woodchuck_set_param takes, a kilometre in mm. */
const MAX_VALUE = 1_000_000;

/**
 * Read by a voice model, where "15" and "50" sound alike, so it says the
 * change back before calling. Crossband keeps 900 characters of a
 * description, and a test holds this one under that.
 */
export const SET_PARAM_DESCRIPTION =
  "Change sizes in the open Woodchuck design straight away, without asking Woodchuck's Claude, by setting parameters it already has. " +
  "Use it only when the woodworker names a size that maps to an existing parameter; call woodchuck_design first for the names. " +
  "Before calling, say the change back (parameter, old → new in mm) and get a yes, unless the woodworker said which size and the exact number in one breath. " +
  "Give value_mm for a size in mm, value for another unit such as a count, or expression for a formula. " +
  "A change over 20%, or to 0 or below, is refused unless confirmed is true. " +
  "Sizes worked out from it move too. It works mid-build as its own undo step, and Woodchuck's Claude is told. " +
  "Anything that adds, removes or reshapes parts, or needs a new parameter, goes to woodchuck_ask.";

/** The least time between two asks to warm Woodchuck's cache. Woodchuck decides whether one is needed. */
const WARM_ASK_EVERY_MS = 60_000;
let warmAskedAt = -Infinity;

/**
 * Asks Woodchuck to warm its Claude's prompt cache, without waiting. A tool
 * call from another app is a sign the woodworker is about to talk about the
 * design, and Woodchuck sends a warm-up only when the cache has gone cold.
 * The tools that send its Claude a message never ask, since that message
 * writes the cache itself.
 */
function warmUp() {
  if (Date.now() - warmAskedAt < WARM_ASK_EVERY_MS) return;
  warmAskedAt = Date.now();
  void fetch(`${BASE}/api/warm`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ from: "mcp" }) })
    .then((r) => r.body?.cancel())
    .catch(() => undefined);
}

async function getState(): Promise<AppState> {
  const r = await fetch(`${BASE}/api/state`);
  if (!r.ok) throw new Error(`Woodchuck answered ${r.status}`);
  return (await r.json()) as AppState;
}

async function postJson(path: string, body: unknown): Promise<{ status: number; error?: string; steered?: boolean }> {
  const r = await fetch(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = (await r.json().catch(() => ({}))) as { error?: string; steered?: boolean };
  return { status: r.status, ...(j.error ? { error: j.error } : {}), ...(j.steered ? { steered: true } : {}) };
}

/**
 * Asks the app for a tool's answer. The app works every answer out, from the
 * design it has open, so this server only relays, and a new version of
 * Woodchuck reaches the chat app with no restart of it.
 */
async function ask(path: string, body?: Record<string, unknown>): Promise<{ text: string; plan?: boolean }> {
  const r = await fetch(`${BASE}${path}`, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ caller: CALLER, ...body }) } : undefined);
  const j = (await r.json().catch(() => ({}))) as { text?: unknown; plan?: boolean; error?: string };
  if (!r.ok || typeof j.text !== "string") throw new Error(j.error ?? `Woodchuck answered ${r.status}`);
  return { text: j.text, ...(j.plan ? { plan: true } : {}) };
}

/** Woodchuck's reason for refusing, as one sentence after "Nothing changed." */
const refusal = (r: { status: number; error?: string }) => text(`Nothing changed. ${String(r.error ?? `Woodchuck answered ${r.status}`).replace(/\.?$/, ".")}`);

/**
 * Undoes or redoes the change it names, once. Sent again, the change is
 * already where it was asked to go, so nothing more happens.
 */
async function historyStep(which: "undo" | "redo", change: number) {
  const r = await fetch(`${BASE}/api/${which}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ change }) });
  const j = (await r.json().catch(() => ({}))) as { error?: string; already?: boolean; entry?: { id: number; label: string } | null };
  if (!r.ok) return refusal({ status: r.status, ...(j.error ? { error: j.error } : {}) });
  const label = j.entry?.label ?? "";
  if (j.already) return text(`Change ${change}, "${label}", is ${which === "undo" ? "undone" : "in the design"} already, so nothing changed.`);
  return which === "undo"
    ? text(`Undid change ${change}, "${label}". woodchuck_redo with change ${change} puts it back.`)
    : text(`Redid change ${change}, "${label}". woodchuck_undo with change ${change} takes it out again.`);
}

export interface DesignRequest {
  action: "list" | "open" | "new" | "copy" | "rename" | "star" | "delete";
  design?: string | undefined;
  name?: string | undefined;
  example?: boolean | undefined;
  starred?: boolean | undefined;
  confirmed?: boolean | undefined;
}

/**
 * The design menu, for another chat. Each action names the design or the
 * name it means, so sent twice it does its job once: a design already
 * open, made, named, starred or gone is left as it is.
 */
async function designAction(a: DesignRequest) {
  const s = await getState();
  const all = s.projects ?? [];
  const byId = (id?: string) => all.find((p) => p.slug === id);
  const ids = () => `Designs: ${all.map((p) => p.slug).join(", ")}.`;
  switch (a.action) {
    case "list":
      return text(designList(s));
    case "open": {
      const p = byId(a.design);
      if (!p) return text(`Nothing changed. There's no design ${a.design ?? "named"}. ${ids()}`);
      if (p.slug === s.project.slug) return text(`${p.name} is open already.`);
      const r = await postJson("/api/projects/open", { slug: p.slug });
      return r.status >= 300 ? refusal(r) : text(`Opened ${p.name}.`);
    }
    case "new":
    case "copy": {
      const name = a.name?.trim();
      if (!name) return text(`Nothing changed. Say what to call the ${a.action === "new" ? "new design" : "copy"}.`);
      // Sent again, the design it made is the one open.
      const made = s.design.name === name && (a.action === "copy" || (a.example ? s.project.example === "record_console" : !s.design.parts.length));
      if (made) return text(`${name} is open already, so nothing changed.`);
      const clash = all.find((p) => p.name === name);
      if (clash) return text(`Nothing changed. There's already a design called ${name} (${clash.slug}). Open it, or pick another name.`);
      const r = a.action === "new" ? await postJson("/api/projects", { name, ...(a.example ? { example: "record_console" } : {}) }) : await postJson("/api/projects/copy", { name });
      if (r.status >= 300) return refusal(r);
      return text(a.action === "new" ? `Started ${name}${a.example ? " from the record console example" : ""}. It's open now.` : `Copied ${s.design.name} as ${name}. The copy is open now.`);
    }
    case "rename": {
      const name = a.name?.trim();
      if (!name) return text("Nothing changed. Say the new name.");
      if (s.design.name === name) return text(`It's called ${name} already, so nothing changed.`);
      const r = await postJson("/api/ops", { ops: [{ op: "rename_design", name }], label: `${CALLER_AT_START}: rename to ${name}` });
      return r.status >= 300 ? refusal(r) : text(`Renamed ${s.design.name} to ${name}. It's one change the woodworker can undo.`);
    }
    case "star": {
      const p = byId(a.design ?? s.project.slug);
      if (!p) return text(`Nothing changed. There's no design ${a.design}. ${ids()}`);
      if (a.starred === undefined) return text("Nothing changed. Say starred true to star it, or false to take the star off.");
      const r = await postJson("/api/projects/star", { slug: p.slug, starred: a.starred });
      return r.status >= 300 ? refusal(r) : text(`${p.name} is ${a.starred ? "starred" : "not starred"}.`);
    }
    case "delete": {
      if (!a.design) return text("Nothing changed. Say which design to delete, by its id from list.");
      const p = byId(a.design);
      if (!p) return text(`There's no design ${a.design}, so there's nothing to delete.`);
      if (!a.confirmed) {
        return text(`Nothing changed yet. Deleting ${p.name} takes it and its chat out of Woodchuck, and it can't be undone. Ask the woodworker, then call again with confirmed true.`);
      }
      const r = await postJson("/api/projects/delete", { slug: p.slug });
      if (r.status >= 300) return refusal(r);
      return text(`Deleted ${p.name}. ${(await getState()).project.name} is open now.`);
    }
  }
}

/** A version's short id, as woodchuck_history gives it. */
const shortSha = (sha: string) => sha.slice(0, 7);

/** The design's saved versions, newest first, by short id. */
export function versionList(s: AppState, max = 15): string {
  const all = s.versions ?? [];
  if (!all.length) return "There are no saved versions of this design yet.";
  const lines = all.slice(0, max).map((v) => `- ${shortSha(v.sha)}: ${v.message}, ${v.at.slice(0, 16).replace("T", " ")}, by ${v.author === "claude" ? "Woodchuck's Claude" : "the woodworker"}`);
  return ["Versions of the open design, newest first, by id:", ...lines, ...(all.length > max ? [`and ${all.length - max} older`] : [])].join("\n");
}

export interface PhotoRequest {
  show?: boolean | undefined;
  lens_degrees?: number | undefined;
  shadow?: number | undefined;
  blend?: boolean | undefined;
  remove?: boolean | undefined;
  confirmed?: boolean | undefined;
}

/**
 * The room photo bar, for another chat. Showing it and setting its lens and
 * shadow end the same however often they're sent. Removing the photo and
 * the AI blend wait for the woodworker's yes, and each blend is a new one
 * that costs money.
 */
async function photoAction(a: PhotoRequest) {
  const s = await getState();
  if (a.remove) {
    if (!s.backdrop) return text("There's no room photo with this design, so there's nothing to remove.");
    if (!a.confirmed) return text("Nothing changed yet. Removing the room photo takes it off this design. Ask the woodworker, then call again with confirmed true.");
    const r = await postJson("/api/backdrop/clear", {});
    return r.status >= 300 ? refusal(r) : text("Removed the room photo from this design.");
  }
  const view: Record<string, unknown> = {};
  if (a.show !== undefined) view.photo = a.show;
  if (a.lens_degrees !== undefined) view.photoLens = a.lens_degrees;
  if (a.shadow !== undefined) view.photoShadow = a.shadow;
  if (a.blend) {
    if (!s.backdrop) return text("Nothing changed. There's no room photo to blend into. The woodworker loads one with Share, then Photo.");
    if (!s.has_openai_key) return text("Nothing changed. The AI blend needs an OpenAI API key in Woodchuck's .env file.");
    if (!a.confirmed) return text("Nothing changed yet. The AI blend sends the room photo to OpenAI, and each blend costs money. Ask the woodworker, then call again with confirmed true.");
    view.blend = true;
  }
  if (!Object.keys(view).length) return text("Nothing changed. Say show, lens_degrees, shadow, blend or remove.");
  if (view.photo === true && !s.backdrop) return text("Nothing changed. There's no room photo with this design. The woodworker loads one with Share, then Photo.");
  const r = await fetch(`${BASE}/api/view`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ from: CALLER, ...view }) });
  const j = (await r.json().catch(() => ({}))) as { windows?: number; shown?: string; error?: string };
  if (!r.ok) return refusal({ status: r.status, ...(j.error ? { error: j.error } : {}) });
  if (!j.windows) return text(`No Woodchuck window is open, so nothing changed. Open ${BASE} in a browser on this computer, then try again.`);
  return text(`The Woodchuck window now shows ${j.shown}.${view.blend ? " The blended picture appears over the photo when OpenAI sends it back, in about a minute." : ""}`);
}

/** Sends the open window a view change, and says how many windows took it. */
async function showView(view: Record<string, unknown>): Promise<number> {
  const v = await fetch(`${BASE}/api/view`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ from: CALLER, ...view }) });
  return ((await v.json().catch(() => ({}))) as { windows?: number }).windows ?? 0;
}

async function getProgress(): Promise<Progress> {
  const r = await fetch(`${BASE}/api/progress`);
  if (!r.ok) throw new Error(`Woodchuck answered ${r.status}`);
  return (await r.json()) as Progress;
}

/** Watches the request until Claude stops working on it, or the time is up, whichever comes first. */
async function watch(ms: number): Promise<Progress> {
  const end = Date.now() + ms;
  let p = await getProgress();
  while (p.state === "running" && Date.now() < end) {
    await new Promise((r) => setTimeout(r, Math.min(500, Math.max(0, end - Date.now()))));
    p = await getProgress();
  }
  return p;
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
/** Words for the model, and the background block another app watches the request by. */
const withProgress = (t: string, p: Progress) => ({ content: [{ type: "text" as const, text: t }], structuredContent: background(p) });
const unreachable = (e: unknown) =>
  text(`Woodchuck isn't answering at ${BASE} (${(e as Error).message}). Check it's running on this computer.`);

/** What to say once a request has been handed over: the answer if it's ready, or how it's going. */
function answer(p: Progress): string {
  if (hasReply(p.state)) return p.reply;
  if (p.state === "idle") return progressText(p);
  return `Woodchuck's Claude has started on it, and the Woodchuck window shows it working.\n${progressText(p)}\nCall woodchuck_progress when the woodworker asks how it's going.`;
}

/**
 * Sends a message to Woodchuck's Claude and never waits long. With Claude
 * idle it starts a turn and waits a few seconds for a quick answer. Mid-build
 * the message goes in after Claude's current step, and this returns at once.
 */
async function send(body: Record<string, unknown>, waitMs = ASK_WAIT_MS) {
  const r = await postJson("/api/chat", { selection: [], ...body });
  if (r.status >= 300) return text(`Woodchuck refused that: ${r.error ?? r.status}`);
  if (r.steered) {
    const p = await getProgress();
    return withProgress(
      `Passed on. Woodchuck's Claude is mid-build, so it reads the message after its current step and carries on with it in mind. The Woodchuck window shows it as sent while Claude worked.\n${progressText(p)}`,
      p,
    );
  }
  const p = await watch(waitMs);
  return withProgress(answer(p), p);
}

/** Tests pass shorter waits. */
export function buildServer(o: { askWaitMs?: number; replyWaitMs?: number } = {}): McpServer {
  const askWait = o.askWaitMs ?? ASK_WAIT_MS;
  const replyWait = o.replyWaitMs ?? REPLY_WAIT_MS;
  const server = new McpServer({ name: "woodchuck", version: "1.0.0" });

  server.registerTool(
    "woodchuck_ask",
    {
      title: "Ask Woodchuck",
      description:
        "Send a message to Woodchuck, the woodworker's furniture design app. Woodchuck's own Claude reads it and changes the open design only through its woodworking tools: sizes, joints, timber, and finishes from the Linolie Satin Wood Oil and Osmo Polyx-Oil cards. Use it for anything about the design, such as trying other colours. Pass the woodworker's request on in plain words. It never waits long: a quick answer comes straight back, and a longer build carries on in the Woodchuck window while you keep talking. Sent while Woodchuck's Claude is mid-build, the message redirects the build: it reads it after its current step and carries on with it in mind. Changes show live in the Woodchuck window; use woodchuck_view to change what that window shows, and woodchuck_picture to see the design here.",
      inputSchema: { message: z.string().min(1).describe("What to ask or tell Woodchuck, in plain words") },
    },
    async ({ message }) => {
      try {
        return await send({ text: message }, askWait);
      } catch (e) {
        return unreachable(e);
      }
    },
  );

  server.registerTool(
    "woodchuck_reply",
    {
      title: "Woodchuck's latest reply",
      description:
        "Get what Woodchuck's Claude said and did in its latest request, once it's finished or waiting on an answer. Waits a few seconds at most, then says how it's going if it's still working.",
      inputSchema: {},
    },
    async () => {
      warmUp();
      try {
        const p = await watch(replyWait);
        return withProgress(p.state === "running" ? `It's still working.\n${progressText(p)}` : answer(p), p);
      } catch (e) {
        return unreachable(e);
      }
    },
  );

  server.registerTool(
    "woodchuck_progress",
    {
      title: "How Woodchuck's build is going",
      description:
        "Say how Woodchuck's Claude is getting on, straight away: what it's doing, how many steps and how long it's taken, whether it's waiting on the woodworker, and its reply once it's done. Use it whenever someone asks how it's going. Never call it in a loop to wait; it answers at once, and the work carries on either way.",
      inputSchema: {},
    },
    async () => {
      warmUp();
      try {
        const p = await getProgress();
        const said = hasReply(p.state) ? `\n\n${p.reply}` : "";
        return withProgress(`${progressText(p)}${said}`, p);
      } catch (e) {
        return unreachable(e);
      }
    },
  );

  server.registerTool(
    "woodchuck_preview",
    {
      title: "Answer Woodchuck's preview",
      description:
        "Answer the preview Woodchuck's Claude is showing: apply makes the change as one step the woodworker can undo; not_now leaves the design as it is. Only call this when the woodworker has said which.",
      inputSchema: {
        choice: z.enum(["apply", "not_now"]),
        note: z.string().optional().describe("Anything the woodworker added, such as what to change instead"),
      },
    },
    async ({ choice, note }) => {
      try {
        const s = await getState();
        if (!s.waiting.includes("preview")) return text("Woodchuck isn't waiting on a preview right now.");
        return await send({ text: `${choice === "apply" ? "Apply it." : "Not now."}${note ? ` ${note}` : ""}`, preview: choice }, askWait);
      } catch (e) {
        return unreachable(e);
      }
    },
  );

  server.registerTool(
    "woodchuck_view",
    {
      title: "Change the Woodchuck window's view",
      // Crossband cuts a description at 900 characters, so the detail is in the inputs.
      description:
        "Change what the open Woodchuck window shows. It never changes the design. Use it whenever the woodworker wants to see something in Woodchuck, rather than asking Woodchuck's Claude. For the cut list or the cutting layout, such as \"show me the cut list\", open tab \"make\"; for problems, \"check\"; for colours, \"finish\"; for sizes or a picked part, \"edit\"; for past versions, \"history\". For a one-off turn, such as \"turn it a bit\", use turn_degrees. For a turn that keeps going, such as \"spin it slowly\", \"keep rotating\" or \"show it off while we talk\", use orbit \"start\", and orbit \"stop\" to hold it still. It can also show the 2D plan views, set the look, lighting and camera view, zoom, fit the model, turn see-through on, pull the piece or a joint apart, place the room photo, fill the window, highlight parts, show the waiting preview or a worked joint, and render a picture to the downloads.",
      inputSchema: {
        plan_views: z.boolean().optional().describe("true shows the 2D plan views (front, top, side and iso drawings); false goes back to the 3D view"),
        look: z.enum(["finished", "plain"]).optional(),
        lighting: z.enum(["daylight", "evening", "workshop"]).optional(),
        view: z.enum(["iso", "front", "top", "left", "right", "back"]).optional(),
        fit: z.boolean().optional().describe("Bring the whole model back into view"),
        turn_degrees: z.number().min(-360).max(360).optional().describe("Turn the camera around the model; positive turns it to the right. A bit is about 20"),
        orbit: z
          .enum(["start", "stop"])
          .optional()
          .describe(
            "start keeps the camera turning slowly around the model until stop; stop holds it still. An orbit keeps going while the look, lighting, zoom or fit change, and stops by itself when the woodworker takes the camera, picks a camera view or opens the plan views",
          ),
        orbit_degrees_per_second: z
          .number()
          .min(-ORBIT_SPEED.max)
          .max(ORBIT_SPEED.max)
          .optional()
          .describe(`How fast an orbit turns, in degrees a second, at least ${ORBIT_SPEED.min} either way; positive turns it to the right. The default ${ORBIT_SPEED.default} is a slow showcase spin, once round in half a minute`),
        zoom: z.number().min(0.2).max(5).optional().describe("Above 1 moves closer, below 1 further away; 1.5 is a step in"),
        see_through: z.boolean().optional().describe("Show the parts see-through so the joints show"),
        explode: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("Pull the piece apart the way it goes together: 1 fully apart, 0 back together, and anything between partly apart, the last part on coming off first"),
        focus_joint: z
          .string()
          .optional()
          .describe('Pull one of the design\'s joints apart on its own, by its id from woodchuck_status, with the rest faded and its section and sizes beside it, for "how does this joint go together" or "what size is that tenon". "" goes back to the whole piece'),
        photo: z.boolean().optional().describe("Place the design in its room photo, or put the photo away"),
        render: z.boolean().optional().describe("After the other changes, save a picture of what the window shows to the woodworker's downloads"),
        fill_window: z.boolean().optional().describe("true fills the window with the 3D view; false brings the panels back"),
        highlight: z.array(z.string()).optional().describe("Part ids to pick so they're highlighted; an empty list clears it"),
        show_preview: z.boolean().optional().describe("Open the preview Woodchuck's Claude is waiting on"),
        show_joint: z.enum(JOINT_TYPES as unknown as [JointType, ...JointType[]]).optional().describe("Open a worked example of this joint"),
        close_drawer: z.boolean().optional(),
        tab: z
          .enum(SIDE_TABS)
          .optional()
          .describe(
            "Open this tab of the side panel, by its name on screen. make holds the workshop drawings, the cut list and the cutting layout; check the problems, each with a fix; finish the timber and colours; edit the picked part and the design's sizes; history every change and version",
          ),
      },
    },
    async (a) => {
      warmUp();
      try {
        const view: Record<string, unknown> = { from: CALLER };
        if (a.plan_views !== undefined) view.mode = a.plan_views ? "plan" : "3d";
        if (a.turn_degrees) view.turn = a.turn_degrees;
        // A speed on its own means start turning at that speed.
        if (a.orbit) view.orbit = a.orbit;
        else if (a.orbit_degrees_per_second !== undefined) view.orbit = "start";
        if (a.orbit_degrees_per_second !== undefined) view.orbitSpeed = a.orbit_degrees_per_second;
        if (a.zoom) view.zoom = a.zoom;
        if (a.see_through !== undefined) view.seeThrough = a.see_through;
        if (a.explode !== undefined) view.explode = a.explode;
        if (a.focus_joint !== undefined) view.focusJoint = a.focus_joint;
        if (a.photo !== undefined) view.photo = a.photo;
        if (a.render) view.render = true;
        if (a.look) view.look = a.look;
        if (a.lighting) view.lighting = a.lighting;
        if (a.view) view.view = a.view;
        if (a.fit) view.fit = true;
        if (a.fill_window !== undefined) view.fill = a.fill_window;
        if (a.highlight) view.select = a.highlight;
        if (a.show_preview) view.drawer = "preview";
        else if (a.show_joint) view.drawer = { joint: a.show_joint };
        else if (a.close_drawer) view.drawer = "close";
        if (a.tab) view.tab = a.tab;
        const r = await fetch(`${BASE}/api/view`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(view) });
        const j = (await r.json()) as { windows?: number; shown?: string; error?: string };
        if (!r.ok) return text(`Woodchuck refused that: ${j.error ?? r.status}`);
        if (!j.windows) return text(`No Woodchuck window is open, so nothing changed. Open ${BASE} in a browser on this computer, then try again.`);
        const orbiting = view.orbit === "start" ? ' It keeps turning until you send orbit "stop", or the woodworker takes the camera.' : "";
        return text(`The Woodchuck window now shows ${j.shown}.${orbiting}`);
      } catch (e) {
        return unreachable(e);
      }
    },
  );

  server.registerTool(
    "woodchuck_finish",
    {
      title: "Change colours in Woodchuck",
      description:
        "Put a finish on part of the open Woodchuck design straight away, without asking Woodchuck's Claude: fast, for trying colours. targets use the ids from woodchuck_status: \"material:<id>\" for everything in a material, a part id for a whole piece (an array's original covers its copies; \"part#2\" is one copy), or \"part.face\" with a face of left, right, bottom, top, back or front. A colour on a material or whole piece replaces colours set inside it. finish is a colour name or number from woodchuck_colours, such as \"amsterdam\", \"13\" or \"3044\", or \"raw\" for bare timber. It works while Woodchuck's Claude is mid-build too, as its own undo step. The window shows it at once, and Woodchuck's Claude is told after its current step, or on its next turn. Use woodchuck_ask instead for anything beyond colours.",
      inputSchema: {
        targets: z.array(z.string()).min(1),
        finish: z.string().min(1),
      },
    },
    async ({ targets, finish }) => {
      warmUp();
      try {
        return text((await ask("/api/mcp/finish", { targets, finish })).text);
      } catch (e) {
        return unreachable(e);
      }
    },
  );

  server.registerTool(
    "woodchuck_set_param",
    {
      title: "Change sizes in Woodchuck",
      description: SET_PARAM_DESCRIPTION,
      inputSchema: {
        params: z
          .array(
            z.object({
              name: z.string().min(1).describe('A parameter woodchuck_design lists, such as "top_length"'),
              value_mm: z.number().min(-MAX_VALUE).max(MAX_VALUE).optional().describe("The new size in millimetres, for a parameter in mm"),
              value: z.number().min(-MAX_VALUE).max(MAX_VALUE).optional().describe("The new value of a parameter in another unit, such as a count"),
              expression: z.string().min(1).max(200).optional().describe('A formula in place of a number, using the design\'s parameters, such as "top_length / 4"'),
            }),
          )
          .min(1)
          .max(12),
        confirmed: z.boolean().optional().describe("true once the woodworker has said yes to a change of over 20%, or to 0 or below"),
      },
    },
    async ({ params, confirmed }) => {
      warmUp();
      try {
        return text((await ask("/api/mcp/params", { params, ...(confirmed === undefined ? {} : { confirmed }) })).text);
      } catch (e) {
        return unreachable(e);
      }
    },
  );

  server.registerTool(
    "woodchuck_stock",
    {
      title: "Woodchuck's cutting plan and the wood you have",
      description:
        "Read the open design's cutting plan: each board and sheet by letter, the woodworker's own first, with its parts in cutting order, the rips, offcuts, and what's left to buy. Or set what a material is cut from, then read the new plan. owned replaces the list of boards or sheets they already have, which are cut first, narrower parts ripped from wider boards. widths_mm are the widths the yard sells solid timber in, lengths_mm its lengths, and kerf_mm the saw's cut. Give only what changes; null or [] clears it. Material ids come from woodchuck_design. A setting already in place changes nothing, so sending a call twice is safe. Each change is one undo step.",
      inputSchema: {
        material: z.string().min(1).optional().describe("The material id, for owned, widths_mm and lengths_mm"),
        owned: z
          .array(z.object({ length_mm: z.number().positive(), width_mm: z.number().positive(), qty: z.number().int().min(1).max(200) }))
          .max(50)
          .nullable()
          .optional()
          .describe("Every size of board or sheet they have of this material. Length runs along the grain"),
        widths_mm: z.array(z.number().positive()).max(20).nullable().optional().describe("Solid timber only, such as [42, 66, 90]"),
        lengths_mm: z.array(z.number().positive()).max(20).nullable().optional().describe("Solid timber only, such as [2400, 3000, 3600]"),
        kerf_mm: z.number().min(0).max(20).nullable().optional().describe("The saw's cut, 3 mm by default"),
      },
    },
    async ({ material, owned, widths_mm, lengths_mm, kerf_mm }) => {
      warmUp();
      try {
        const r = await ask("/api/mcp/stock", { material, owned, widths_mm, lengths_mm, kerf_mm });
        // The app's text ends on the cutting plan, and the link to print it is this server's to give.
        return text(r.plan ? `${r.text}\nTo print: ${BASE}/api/cutting-plan.pdf?paper=A4${LOCAL ? ", on the computer Woodchuck runs on" : ""}` : r.text);
      } catch (e) {
        return unreachable(e);
      }
    },
  );

  server.registerTool(
    "woodchuck_design",
    {
      title: "Read the Woodchuck design",
      description:
        "Read the open Woodchuck design at once, in short lines: its parameters with their values and formulas, its materials, its parts with their sizes in mm and any slopes, holes or notches, its overall size, its problems, and whether Woodchuck's Claude is busy or waiting for an answer. Call it before woodchuck_set_param to find the parameter that holds a size, and when the woodworker asks about sizes. For joints, cuts and the drawings, use woodchuck_read. It never changes anything.",
      inputSchema: {},
    },
    async () => {
      warmUp();
      try {
        return text((await ask("/api/mcp/design")).text);
      } catch (e) {
        return unreachable(e);
      }
    },
  );

  server.registerTool(
    "woodchuck_read",
    {
      title: "Read any part of the Woodchuck design",
      description:
        "Read part of the open Woodchuck design as text, as the app shows it. parts gives each part's sheet from the workshop drawings: its cut size, the side of the piece each view shows, each numbered machining note with where the cut starts and ends, and which end, edge and face those are measured from. joints lists each joint with its parts and settings. cut_list, cutting_plan, drilling and hardware give those lists, checks every problem, and file the design's own JSON. Give part, as a part's id, row number or name, to read just that part. Use it to answer where a cut is or which face it's in, rather than guessing. It never changes anything, so calling again is safe.",
      inputSchema: {
        what: z.enum(READ_PARTS).describe("Which part of the design to read"),
        part: z.string().max(120).optional().describe("A part's id, cut-list row number or name, to read only that part. For parts, joints, cut_list and drilling"),
      },
    },
    async ({ what, part }) => {
      warmUp();
      try {
        return text((await ask(`/api/mcp/read?${new URLSearchParams({ what, ...(part ? { part } : {}) })}`)).text);
      } catch (e) {
        return unreachable(e);
      }
    },
  );

  server.registerTool(
    "woodchuck_colours",
    {
      title: "Woodchuck's colour cards",
      description: "List the finishes Woodchuck knows: the Linolie Satin Wood Oil colours with how each looks on Douglas fir, and the Osmo Polyx-Oils. Use the name or number with woodchuck_finish.",
      inputSchema: {},
    },
    async () => {
      warmUp();
      try {
        return text((await ask("/api/mcp/colours")).text);
      } catch (e) {
        return unreachable(e);
      }
    },
  );

  server.registerTool(
    "woodchuck_undo",
    {
      title: "Undo a change in Woodchuck",
      description:
        "Undo the latest change to the open design, named by its number from woodchuck_status, such as 14. To go back further, undo each change in turn, latest first. A change already undone is left as it is, so calling again is safe. Woodchuck's Claude mustn't be working: wait for it, or stop it first. woodchuck_redo puts a change back.",
      inputSchema: { change: z.number().int().min(1).describe("The change's number, from woodchuck_status") },
    },
    async ({ change }) => {
      warmUp();
      try {
        return await historyStep("undo", change);
      } catch (e) {
        return unreachable(e);
      }
    },
  );

  server.registerTool(
    "woodchuck_redo",
    {
      title: "Redo a change in Woodchuck",
      description:
        "Put back a change that was undone, named by its number from woodchuck_status's undone list. Changes come back in order, the one undone last first. A change already back in the design is left as it is, so calling again is safe. Woodchuck's Claude mustn't be working.",
      inputSchema: { change: z.number().int().min(1).describe("The change's number, from woodchuck_status") },
    },
    async ({ change }) => {
      warmUp();
      try {
        return await historyStep("redo", change);
      } catch (e) {
        return unreachable(e);
      }
    },
  );

  server.registerTool(
    "woodchuck_designs",
    {
      title: "Woodchuck's designs",
      description:
        "List, open, start, copy, rename, star or delete Woodchuck's designs, as its design menu does. Name a design by its id from list, which also gives a link to download the open one. new and copy need a name, and the design they made being open counts as done, so calling again is safe. star sets starred true or false. delete takes a design and its chat out of Woodchuck for good, so ask the woodworker first, then call again with confirmed true. Woodchuck's Claude mustn't be working to open, start, copy or delete one.",
      inputSchema: {
        action: z.enum(["list", "open", "new", "copy", "rename", "star", "delete"]),
        design: z.string().optional().describe("A design's id, from list. For open, star and delete; star takes the open design without one"),
        name: z.string().min(1).max(120).optional().describe("The name for new, copy and rename"),
        example: z.boolean().optional().describe("For new: start from the record console example"),
        starred: z.boolean().optional().describe("For star: true to star it, false to take the star off"),
        confirmed: z.boolean().optional().describe("For delete: true once the woodworker has said yes"),
      },
    },
    async (a) => {
      warmUp();
      try {
        return await designAction(a);
      } catch (e) {
        return unreachable(e);
      }
    },
  );

  server.registerTool(
    "woodchuck_status",
    {
      title: "Woodchuck design status",
      description:
        "Read the open Woodchuck design's name, problems, timber, finishes and joint ids, its latest changes by number for woodchuck_undo and woodchuck_redo, and whether Woodchuck's Claude is busy or waiting for an answer.",
      inputSchema: {},
    },
    async () => {
      warmUp();
      try {
        return text((await ask("/api/mcp/status")).text);
      } catch (e) {
        return unreachable(e);
      }
    },
  );

  server.registerTool(
    "woodchuck_drawings",
    {
      title: "Woodchuck's workshop drawings",
      description:
        "List the open design's workshop drawings by sheet: the general arrangement, a sheet for each part, then the cut list, cutting plan, drilling and hardware lists. Give sheet, by its number, to get that sheet as a picture to look at, which a chat that shows a tool's pictures shows the woodworker too. A part sheet leaves its machining notes off unless notes is true. woodchuck_read gives the part sheets in words. It also links to the drawings as a PDF to print at 100%, the cutting plan alone and the cut list as a spreadsheet file. It only reads, so calling again is safe.",
      inputSchema: {
        paper: z.enum(["A4", "A3"]).optional().describe("The paper the drawings are laid out on. A4 when left out"),
        sheet: z.number().int().min(1).optional().describe("A sheet's number, from the list, to get that sheet as a picture"),
        notes: z.boolean().optional().describe("true puts each part sheet's numbered machining notes on, as the window's With notes tick does"),
      },
    },
    async ({ paper, sheet, notes }) => {
      warmUp();
      try {
        const on = paper ?? "A4";
        if (sheet === undefined) {
          const r = await fetch(`${BASE}/api/mcp/sheets?paper=${on}${notes ? "&notes=1" : ""}`);
          if (!r.ok) throw new Error(`Woodchuck answered ${r.status}`);
          const j = (await r.json()) as { name: string; titles: string[] };
          return text(drawingsText(j.name, j.titles, on, BASE, LOCAL, notes === true));
        }
        // The app draws the sheet, the same way as the PDF.
        const r = await fetch(`${BASE}/api/mcp/sheet.png?paper=${on}&n=${sheet}${notes ? "&notes=1" : ""}`);
        if (r.status === 404) return text(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `There's no sheet ${sheet}.`);
        if (!r.ok) throw new Error(`Woodchuck answered ${r.status}`);
        const png = Buffer.from(await r.arrayBuffer()).toString("base64");
        return {
          content: [
            { type: "text" as const, text: decodeURIComponent(r.headers.get("x-sheet-said") ?? "") },
            { type: "image" as const, data: png, mimeType: "image/png" },
          ],
        };
      } catch (e) {
        return unreachable(e);
      }
    },
  );

  server.registerTool(
    "woodchuck_photo",
    {
      title: "Woodchuck's room photo",
      description:
        "Work the room photo bar in the open Woodchuck window, where the design sits in a photo of the woodworker's room. show puts the design in its photo or takes it out. lens_degrees matches the photo's lens and shadow sets how dark the floor shadow is; they stay set, so calling again is safe. blend asks OpenAI to relight the piece to match the room: it costs money each time, so ask the woodworker first and send confirmed true. remove takes the photo off the design, also only after a yes.",
      inputSchema: {
        show: z.boolean().optional().describe("true places the design in its room photo; false takes it out"),
        lens_degrees: z.number().min(20).max(80).optional().describe("The photo's lens, as degrees up and down. Most phone photos are 50 to 60"),
        shadow: z.number().min(0).max(0.8).optional().describe("How dark the shadow on the floor is, from 0 to 0.8"),
        blend: z.boolean().optional().describe("Start the AI blend, once the woodworker has said yes to its cost"),
        remove: z.boolean().optional().describe("Take the photo off the design, once the woodworker has said yes"),
        confirmed: z.boolean().optional().describe("true once the woodworker has said yes to a blend or a removal"),
      },
    },
    async (a) => {
      warmUp();
      try {
        return await photoAction(a);
      } catch (e) {
        return unreachable(e);
      }
    },
  );

  server.registerTool(
    "woodchuck_history",
    {
      title: "Woodchuck's saved versions",
      description:
        "List the open design's saved versions, newest first, or restore one by its id, as the History tab does. Restoring replaces the whole design with that version, as one change the woodworker can undo, so ask them first and send confirmed true. A design already as that version is left as it is, so calling again is safe. Woodchuck's Claude mustn't be working.",
      inputSchema: {
        action: z.enum(["list", "restore"]),
        version: z.string().min(4).optional().describe("A version's id, from list. For restore"),
        confirmed: z.boolean().optional().describe("For restore: true once the woodworker has said yes"),
      },
    },
    async ({ action, version, confirmed }) => {
      warmUp();
      try {
        const s = await getState();
        if (action === "list") return text(versionList(s));
        const found = (s.versions ?? []).filter((v) => version && v.sha.startsWith(version));
        if (found.length !== 1) return text(`Nothing changed. ${found.length ? `More than one version starts ${version}, so give more of its id.` : `There's no version ${version ?? "named"}. Call list for the ids.`}`);
        const v = found[0]!;
        if (!confirmed) {
          return text(`Nothing changed yet. Restoring ${shortSha(v.sha)}, "${v.message}", replaces the whole design with it, as one change the woodworker can undo. Ask them, then call again with confirmed true.`);
        }
        const r = await fetch(`${BASE}/api/versions/restore`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sha: v.sha }) });
        const j = (await r.json().catch(() => ({}))) as { error?: string; already?: boolean };
        if (!r.ok) return refusal({ status: r.status, ...(j.error ? { error: j.error } : {}) });
        if (j.already) return text(`The design is already as version ${shortSha(v.sha)}, so nothing changed.`);
        return text(`Restored version ${shortSha(v.sha)}, "${v.message}". It's one change the woodworker can undo.`);
      } catch (e) {
        return unreachable(e);
      }
    },
  );

  server.registerTool(
    "woodchuck_screenshot",
    {
      title: "See the Woodchuck window",
      description:
        "See what the open Woodchuck window shows right now, as the woodworker sees it: the model from their own camera angle, the piece or a joint pulled apart, the parts they've picked, or the 2D plan view they're on. A joint's section drawing, with its sizes, comes as a second picture when it's open. Use it whenever they say look at it, can you see this, or does this look right. It only reads, so calling again is safe. The room photo stays out unless with_photo is true.",
      inputSchema: {
        with_photo: z.boolean().optional().describe("true includes the woodworker's room photo when the design is placed in it; it's left out otherwise"),
      },
    },
    async ({ with_photo }) => {
      warmUp();
      try {
        const r = await fetch(`${BASE}/api/screenshot`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ with_photo: !!with_photo }) });
        const j = (await r.json().catch(() => ({}))) as { windows?: number; images?: { media_type: string; data: string }[]; shows?: string; error?: string };
        if (!r.ok) return text(`Couldn't see the window: ${j.error ?? r.status}.`);
        if (!j.windows) return text(`No Woodchuck window is open, so there's nothing to see. Open ${BASE} in a browser on this computer, or use woodchuck_picture for a picture of the design.`);
        const images = j.images ?? [];
        if (!images.length) return text(`${j.shows ?? ""} The window couldn't make a picture of it just now. Try again in a moment.`.trim());
        return {
          content: [{ type: "text" as const, text: j.shows ?? "" }, ...images.map((i) => ({ type: "image" as const, data: i.data, mimeType: i.media_type }))],
        };
      } catch (e) {
        return unreachable(e);
      }
    },
  );

  server.registerTool(
    "woodchuck_picture",
    {
      title: "Picture of the Woodchuck design",
      description:
        "Draw the open design as a picture, in the Finished look with its real timber and finishes by default, from a fixed camera. The picture comes back with the result, for you to look at, and a chat that shows a tool's pictures shows it to the woodworker too. With preview true, it draws the preview Woodchuck's Claude is showing as if applied, without applying it. For what their window shows right now, use woodchuck_screenshot.",
      inputSchema: {
        preview: z.boolean().optional().describe("Draw the waiting preview's change instead of the design as it is"),
        look: z.enum(["finished", "plain"]).optional(),
        lighting: z.enum(["daylight", "evening", "workshop"]).optional(),
        view: z.enum(["iso", "front", "top", "left", "right", "back"]).optional(),
      },
    },
    async ({ preview, look, lighting, view }) => {
      warmUp();
      try {
        const q = new URLSearchParams({ look: look ?? "finished", lighting: lighting ?? "daylight", view: view ?? "iso" });
        if (preview) {
          const waiting = [...(await getState()).chat].reverse().find((c) => c.kind === "preview" && c.status === "proposed");
          if (!waiting) return text("There's no preview waiting to draw.");
          q.set("preview", waiting.id);
        }
        const r = await fetch(`${BASE}/api/picture?${q}`);
        const j = (await r.json()) as { url?: string; error?: string };
        if (!r.ok || !j.url) return text(`Woodchuck couldn't draw it: ${j.error ?? r.status}`);
        const url = `${BASE}${j.url}`;
        const png = Buffer.from(await (await fetch(url)).arrayBuffer()).toString("base64");
        const s = await getState();
        return {
          content: [
            {
              type: "text" as const,
              text: pictureText(s.project.name, Boolean(preview), url, LOCAL),
            },
            { type: "image" as const, data: png, mimeType: "image/png" },
          ],
        };
      } catch (e) {
        return unreachable(e);
      }
    },
  );

  return server;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await buildServer().connect(new StdioServerTransport());
}
