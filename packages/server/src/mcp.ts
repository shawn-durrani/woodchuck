// Woodchuck as an MCP server, so a chat elsewhere (Crossband) can work on
// the open design. It speaks MCP over stdio and talks to the running app
// over HTTP, so every change shows live in the Woodchuck window too.
//
// Nothing here edits a design itself. Messages go to Woodchuck's own
// Claude, which changes the design only through its woodworking tools,
// and previews are answered the same way as in the app.
//
// Run it with: tsx packages/server/src/mcp.ts (WOODCHUCK_URL defaults to
// http://127.0.0.1:8905).

import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { finishLabel, JOINT_TYPES, normaliseFinish, PALETTES, speciesOf, type Design, type JointType } from "@woodchuck/core";
import { background, describe, itemsAfter, progressText, type Item, type Progress } from "./progress.js";

const BASE = (process.env.WOODCHUCK_URL ?? "http://127.0.0.1:8905").replace(/\/$/, "");
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

export interface AppState {
  busy: boolean;
  waiting: string[];
  design: Design;
  project: { slug: string; name: string };
  report: { errors: number; warnings: number; ready_to_cut: boolean };
  chat: Item[];
}

/** A short account of the open design: its name, problems, timber and finishes. */
export function summarise(s: AppState): string {
  const d = s.design;
  const lines = [
    `Design: ${s.project.name}`,
    s.report.ready_to_cut ? "Ready to cut." : `${s.report.errors} errors and ${s.report.warnings} warnings.`,
    "Materials:",
    ...d.materials.map((m) => {
      const own = d.finishes?.[`material:${m.id}`];
      return `- ${m.name} (${m.id}): ${speciesOf(m).name}, ${own ? finishLabel(own) : "no finish of its own"}`;
    }),
  ];
  const others = Object.entries(d.finishes ?? {}).filter(([t]) => !t.startsWith("material:"));
  if (others.length) {
    const byColour = new Map<string, string[]>();
    for (const [t, f] of others) byColour.set(f, [...(byColour.get(f) ?? []), t]);
    lines.push("Finishes on pieces and faces:");
    for (const [f, ts] of byColour) lines.push(`- ${finishLabel(f)}: ${ts.length > 6 ? `${ts.slice(0, 5).join(", ")} and ${ts.length - 5} more` : ts.join(", ")}`);
  }
  if (s.busy) lines.push("Woodchuck's Claude is working right now.");
  if (s.waiting.length) lines.push(`Woodchuck's Claude is waiting for an answer to a ${s.waiting.join(" and ")}.`);
  return lines.join("\n");
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
  if (p.state === "done" || p.state === "waiting") return p.reply;
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

/** The colour cards, in lines another model can choose from. */
export function colourCards(): string {
  return PALETTES.map(
    (p) =>
      `${p.maker} ${p.name} (${p.source.toLowerCase()}):\n` +
      p.colours.map((c) => `- ${c.number ? `${c.number} ` : ""}${c.name}${p.photographed_on && c.swatch ? ` ${c.swatch}` : ""}${c.note ? `: ${c.note}` : ""}`).join("\n"),
  ).join("\n\n");
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
      try {
        const p = await getProgress();
        const said = p.state === "done" || p.state === "waiting" ? `\n\n${p.reply}` : "";
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
      description:
        "Change what the open Woodchuck window shows, so the woodworker can look at the design there. It can switch between the 3D view and the 2D plan views; set the Finished look with real timber and colours, or the Plain look; set the lighting; pick a camera view, turn the camera by degrees or zoom in and out; bring the whole model into view; switch see-through on to show the joints; place the design in its room photo; fill the window; highlight parts; show the waiting preview on the model, or open a worked joint example beside it. With render it then saves a picture of what the window shows to the woodworker's downloads. It never changes the design. Use it whenever the woodworker wants to see something in Woodchuck, for example \"turn it a bit to the left\", \"show me the plans\" or \"render that\".",
      inputSchema: {
        plan_views: z.boolean().optional().describe("true shows the 2D plan views (front, top, side and iso drawings); false goes back to the 3D view"),
        look: z.enum(["finished", "plain"]).optional(),
        lighting: z.enum(["daylight", "evening", "workshop"]).optional(),
        view: z.enum(["iso", "front", "top", "left", "right", "back"]).optional(),
        fit: z.boolean().optional().describe("Bring the whole model back into view"),
        turn_degrees: z.number().min(-360).max(360).optional().describe("Turn the camera around the model; positive turns it to the right. A bit is about 20"),
        zoom: z.number().min(0.2).max(5).optional().describe("Above 1 moves closer, below 1 further away; 1.5 is a step in"),
        see_through: z.boolean().optional().describe("Show the parts see-through so the joints show"),
        photo: z.boolean().optional().describe("Place the design in its room photo, or put the photo away"),
        render: z.boolean().optional().describe("After the other changes, save a picture of what the window shows to the woodworker's downloads"),
        fill_window: z.boolean().optional().describe("true fills the window with the 3D view; false brings the panels back"),
        highlight: z.array(z.string()).optional().describe("Part ids to pick so they're highlighted; an empty list clears it"),
        show_preview: z.boolean().optional().describe("Open the preview Woodchuck's Claude is waiting on"),
        show_joint: z.enum(JOINT_TYPES as unknown as [JointType, ...JointType[]]).optional().describe("Open a worked example of this joint"),
        close_drawer: z.boolean().optional(),
      },
    },
    async (a) => {
      try {
        const view: Record<string, unknown> = { from: CALLER };
        if (a.plan_views !== undefined) view.mode = a.plan_views ? "plan" : "3d";
        if (a.turn_degrees) view.turn = a.turn_degrees;
        if (a.zoom) view.zoom = a.zoom;
        if (a.see_through !== undefined) view.seeThrough = a.see_through;
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
        const r = await fetch(`${BASE}/api/view`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(view) });
        const j = (await r.json()) as { windows?: number; shown?: string; error?: string };
        if (!r.ok) return text(`Woodchuck refused that: ${j.error ?? r.status}`);
        if (!j.windows) return text(`No Woodchuck window is open, so nothing changed. Open ${BASE} in a browser on this computer, then try again.`);
        return text(`The Woodchuck window now shows ${j.shown}.`);
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
      try {
        const id = normaliseFinish(finish);
        if (!id) return text(`"${finish}" isn't a colour Woodchuck knows. Call woodchuck_colours for the list.`);
        const what = targets.length > 3 ? `${targets.slice(0, 2).join(", ")} and ${targets.length - 2} more` : targets.join(", ");
        const label = `${CALLER_AT_START}: finish ${what} with ${finishLabel(id)}`;
        const r = await postJson("/api/ops", { ops: [{ op: "set_finish", targets, finish: id }], label });
        if (r.status >= 300) return text(`Woodchuck refused that: ${r.error ?? r.status}`);
        // Show it: colours only appear in the Finished look. The note names
        // materials as the woodworker knows them.
        const design = (await getState()).design;
        const names = targets.map((t) => (t.startsWith("material:") ? `all of ${design.materials.find((m) => m.id === t.slice(9))?.name ?? t.slice(9)}` : t));
        const shown = names.length > 3 ? `${names.slice(0, 2).join(", ")} and ${names.length - 2} more` : names.join(", ");
        const v = await fetch(`${BASE}/api/view`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ look: "finished", from: CALLER, note: `${id === "raw" ? "took the finish off" : "finished"} ${shown}${id === "raw" ? "" : ` with ${finishLabel(id)}`}.` }),
        });
        const windows = ((await v.json().catch(() => ({}))) as { windows?: number }).windows ?? 0;
        return text(
          `Done: ${what} now ${id === "raw" ? "bare timber" : `finished with ${finishLabel(id)}`}. It's one change the woodworker can undo, and Woodchuck's Claude will be told.` +
            (windows ? " The Woodchuck window shows it now." : " No Woodchuck window is open to show it; woodchuck_picture can draw it."),
        );
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
    async () => text(colourCards()),
  );

  server.registerTool(
    "woodchuck_status",
    {
      title: "Woodchuck design status",
      description: "Read the open Woodchuck design's name, problems, timber and finishes, and whether Woodchuck's Claude is busy or waiting for an answer.",
      inputSchema: {},
    },
    async () => {
      try {
        return text(summarise(await getState()));
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
        "Draw the open design as a picture, in the Finished look with its real timber and finishes by default, and get a link to it. With preview true, it draws the preview Woodchuck's Claude is showing as if applied, without applying it. To show the picture, put the markdown image line it gives you in your reply.",
      inputSchema: {
        preview: z.boolean().optional().describe("Draw the waiting preview's change instead of the design as it is"),
        look: z.enum(["finished", "plain"]).optional(),
        lighting: z.enum(["daylight", "evening", "workshop"]).optional(),
        view: z.enum(["iso", "front", "top", "left", "right", "back"]).optional(),
      },
    },
    async ({ preview, look, lighting, view }) => {
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
              text: `Here's ${s.project.name}${preview ? " with the preview's change, not yet applied" : ""}. Put this line in your reply, on its own, to show it:\n\n![${s.project.name}](${url})`,
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
