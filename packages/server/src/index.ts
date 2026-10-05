// The local server. It holds the open project, runs Claude's turns, and
// keeps every open browser tab in step over a WebSocket. It listens on
// loopback only and refuses requests from other sites. Tailscale serve can
// pass it requests from your own tailnet, behind the owner lock.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import {
  cutList,
  cutListCsv,
  derive,
  describeView,
  diffDesigns,
  emptyDesign,
  OpError,
  paperFromParams,
  readViewCommand,
  recordConsoleOps,
  renderView,
  runChecks,
  sheetSvg,
  toPlain,
  VIEW_NAMES,
  workshopDrawings,
  type Op,
  type ViewCommand,
  type ViewName,
} from "@woodchuck/core";
import { defaultClient, followUp, hasCredentials, isModel, MODEL, MODELS, Turn, userLine, type AttachmentType, type ImageType, type MessagesClient, type TurnInput } from "./agent.js";
import { ghCli, GITHUB_OFF, parseRepo, repoFromEnv, type GitHub } from "./github.js";
import { PartsLibrary, searchParts } from "./library.js";
import { ghIssueLookup, syncToolRequests, type IssueLookup } from "./toolstatus.js";
import { chromePicture, findChrome, type TakePicture } from "./picture.js";
import { BLEND_SIZES, BlendError, openAiBlend, type Blend, type BlendSize } from "./blend.js";
import { renderPng } from "./render.js";
import { drawingsPdf, paperOf } from "./pdf.js";
import { progress, type Item } from "./progress.js";
import { scriptFromFile } from "./scripted.js";
import {
  bindHost,
  browserOrigin,
  crossSite,
  DEFAULT_FUNNEL_CHECK_S,
  DEFAULT_TAILSCALE_PORT,
  findTailscale,
  flag,
  fromThisComputer,
  funnelExposes,
  funnelPage,
  funnelText,
  makeFence,
  parseTrustedHosts,
  screen,
  seconds,
  tailscaleServeStatus,
  type Fence,
  type ServeStatus,
} from "./fence.js";
import { OwnerLock, sessionFrom, sidHash } from "./lock.js";
import { LOGIN_SURFACE, lockRoutes } from "./lockRoutes.js";
import { isToolRequestStatus, NEW_DESIGN, Store, TOOL_REQUEST_STATUSES, type ChatItem, type Pin } from "./store.js";
import { countryOverride, DEFAULT_WORKSHOP, WorkshopError } from "./workshop.js";
import type { Design } from "@woodchuck/core";

process.umask(0o077);

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../../..");
const PORT = Number(process.env.WOODCHUCK_PORT || 8905);
const DATA = path.resolve(ROOT, process.env.WOODCHUCK_DATA_DIR || "data");
const WEB_DIST = path.join(ROOT, "packages/web/dist");

/**
 * Which build of the web app this server is serving. A page that sees it
 * change knows it's running old code and can reload itself.
 */
function webBuild(): string {
  try {
    return createHash("sha1").update(readFileSync(path.join(WEB_DIST, "index.html"))).digest("hex").slice(0, 12);
  } catch {
    return "dev";
  }
}
const LIBRARY_DIR = path.resolve(ROOT, process.env.WOODCHUCK_LIBRARY_DIR || "library/parts");
/**
 * Where missing-tool specs are filed and approved parts are shared. There's
 * no default: with WOODCHUCK_REPO unset, GitHub stays off. Checked each time
 * it's used.
 */
const REPO = repoFromEnv();

export function createApp(opts: {
  dataDir: string;
  libraryDir?: string;
  /** The GitHub repository as owner/name, or null for GitHub off. Tests pass one; it's WOODCHUCK_REPO otherwise. */
  repo?: string | null;
  /** Opens pull requests for approved parts. Tests pass a stand-in. */
  github?: GitHub;
  client?: MessagesClient;
  /** Files an issue and returns its URL. Tests pass a stand-in. */
  fileIssue?: (title: string, body: string) => Promise<string>;
  /** Reads an issue's state. Tests pass a stand-in. */
  issueLookup?: IssueLookup;
  /** Check sent tool requests, and the pull requests of approved parts, at startup and every five minutes, once a repository is named. */
  watchTools?: boolean;
  /** Takes a picture of the open design. Tests pass a stand-in. */
  takePicture?: TakePicture;
  /** Relights a piece placed in a photo. Tests pass a stand-in. */
  blend?: Blend;
  /** Which hosts may reach the server. Loopback only, unless WOODCHUCK_TRUSTED_HOSTS names tailnet hosts. */
  fence?: Fence;
  /** WOODCHUCK_RECOVERY_SECRET. Without it, a random one is made for this start. */
  recoverySecret?: string;
  /** Where a browser opens the app, for links from other apps. */
  browserOrigin?: string;
  /** Asks Tailscale whether Funnel is on, every so many seconds, or only when asked with 0. Tests pass a stand-in. */
  funnel?: { status: ServeStatus; everyS: number };
  /** The built web app. Tests pass their own. */
  webDist?: string;
}) {
  const store = new Store(opts.dataDir);
  const webDist = opts.webDist ?? WEB_DIST;
  const fence = opts.fence ?? makeFence([]);
  const lock = new OwnerLock(opts.dataDir, opts.recoverySecret);
  const ownOrigin = opts.browserOrigin ?? browserOrigin({ trusted: fence.trusted, tailscalePort: DEFAULT_TAILSCALE_PORT, port: PORT });
  const build = webBuild();
  const library = new PartsLibrary(opts.libraryDir ?? LIBRARY_DIR, path.join(opts.dataDir, "part-proposals.json"));
  // A part that has arrived in library/parts needs no copy in the data folder.
  library.handOver();
  const github = opts.github ?? ghCli();
  const repo = opts.repo === undefined ? REPO : opts.repo;
  let client: MessagesClient | null = opts.client ?? null;
  let turn: Turn | null = null;
  /** Set once the server is shutting down, so no new turn starts. */
  let closing = false;
  const sockets = new Set<WebSocket>();
  /** The render-only pages Chrome opens for pictures, which aren't anyone's window. */
  const renderSockets = new WeakSet<WebSocket>();
  /** The session a tailnet socket opened with, as its hash. A loopback socket has none. */
  const socketSessions = new WeakMap<WebSocket, string>();
  /** A socket whose session has ended is closed, and the page locks itself. */
  const signedOut = (ws: WebSocket) => {
    const h = socketSessions.get(ws);
    if (!h || lock.hashOk(h)) return false;
    ws.close(4401, "Signed out");
    return true;
  };
  lock.onRevoke = () => {
    for (const ws of sockets) signedOut(ws);
  };
  // A session can also run out while its page sits idle.
  const sessionSweep = setInterval(() => lock.onRevoke(), 60_000);
  sessionSweep.unref();

  const send = (msg: unknown) => {
    const s = JSON.stringify(msg);
    for (const ws of sockets) if (ws.readyState === ws.OPEN && !signedOut(ws)) ws.send(s);
  };

  function snapshot() {
    const p = store.project;
    const d = derive(p.design);
    return {
      project: { slug: p.slug, name: p.design.name, ...(p.example ? { example: p.example } : {}) },
      projects: store.list(),
      design: p.design,
      derived: toPlain(d),
      report: runChecks(p.design, d),
      cutlist: cutList(p.design, d),
      history: p.history.map((e) => ({ id: e.id, author: e.author, label: e.label, at: e.at })),
      redo: p.redo.length,
      chat: p.chat.slice(-400),
      waiting: p.pending?.waiting.map((w) => w.kind) ?? [],
      busy: turn !== null,
      model: p.model && isModel(p.model) ? p.model : MODEL,
      models: MODELS,
      has_key: opts.client !== undefined || hasCredentials(),
      // Whether the AI blend can run. Only whether a key is set, never the key.
      has_openai_key: opts.blend !== undefined || !!process.env.OPENAI_API_KEY,
      backdrop: p.backdrop ?? null,
      build,
      tool_requests: store.toolRequests(),
      // The repository GitHub acts in, or null while it's off.
      repo,
      versions: store.versions.log(p.slug, 100),
      library: { ...library.list(), proposals: library.proposals().filter((x) => x.status === "proposed") },
    };
  }

  // Closing the loop: tools sent to Claude Code are marked built once their
  // issue's PR merges. Startup is right after an update, so it checks then.
  const lookup = opts.issueLookup ?? ghIssueLookup();
  let syncing = false;
  const syncTools = async () => {
    if (syncing) return [];
    syncing = true;
    try {
      const changed = await syncToolRequests(store, lookup);
      if (changed.length) broadcastState();
      return changed;
    } finally {
      syncing = false;
    }
  };

  // A part whose pull request was closed without merging stops waiting for
  // it and says so. Asked on the same schedule as the tool requests.
  let checkingParts = false;
  const syncParts = async () => {
    if (checkingParts) return [];
    checkingParts = true;
    try {
      if (!repo) return [];
      const closed = await library.syncPullRequests(github, repo);
      if (closed.length) broadcastState();
      return closed;
    } catch (e) {
      console.error(`Couldn't check the pull requests of approved parts: ${(e as Error).message}`);
      return [];
    } finally {
      checkingParts = false;
    }
  };

  const checkGitHub = () => {
    void syncTools();
    void syncParts();
  };
  // With no repository named, the app never calls GitHub at all.
  const watching = opts.watchTools !== false && repo !== null;
  const toolTimer = watching ? setInterval(checkGitHub, 5 * 60_000) : null;
  toolTimer?.unref();
  const firstCheck = watching ? setTimeout(checkGitHub, 5_000) : null;
  firstCheck?.unref();

  let pendingState: NodeJS.Timeout | null = null;
  const broadcastState = () => {
    if (pendingState) return;
    pendingState = setTimeout(() => {
      pendingState = null;
      send({ type: "state", state: snapshot() });
    }, 60);
  };

  /** Opens an approved part's pull request. The part works whatever GitHub says. */
  const share = async (id: string, to: string) => {
    const opening = library.share(id, github, to);
    broadcastState();
    try {
      return await opening;
    } finally {
      broadcastState();
    }
  };

  /** Your workshop, its defaults, and the country WOODCHUCK_SEARCH_COUNTRY sets over it, if it's set. */
  const workshopState = () => ({ workshop: store.workshop(), defaults: DEFAULT_WORKSHOP, country_override: countryOverride() });

  /**
   * Runs one of Claude's turns. A message sent while it worked that Claude
   * didn't take in starts the next turn straight away. The busy flag never
   * drops between the two, so a restart that waits on it can't land in the gap.
   */
  async function startTurn(input: TurnInput) {
    client ??= defaultClient();
    const t = new Turn(
      store,
      client,
      {
        chat: (item: ChatItem) => send({ type: "chat", item }),
        delta: (id, text) => send({ type: "delta", id, text }),
        changed: broadcastState,
      },
      (project, views, o) => renderPng(project.design, views, o),
      { list: () => library.list().parts, get: (id) => library.get(id), propose: (input) => library.propose(input) },
    );
    turn = t;
    broadcastState();
    try {
      await t.run(input);
    } finally {
      const next = closing ? null : followUp(store.project);
      turn = null;
      if (next) void startTurn(next);
      else broadcastState();
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse, url: URL) {
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const fail = (status: number, message: string) => json(status, { error: message });

    if (req.method === "POST" && !(req.headers["content-type"] ?? "").startsWith("application/json")) {
      return fail(415, "Send JSON");
    }
    const body = async (limit = 2_000_000): Promise<Record<string, unknown>> => {
      let raw = "";
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > limit) throw new TooLarge();
      }
      return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    };
    const project = store.project;
    const route = `${req.method} ${url.pathname}`;

    try {
      if (url.pathname.startsWith("/api/auth/") && (await authRoute(req, res, url.pathname, () => body(20_000)))) return;
      switch (route) {
        case "GET /api/state":
          return json(200, snapshot());
        case "GET /api/health":
          return json(200, { ok: true, busy: turn !== null, app: "woodchuck", browser_origin: ownOrigin });
        // The restart gate: a script that restarts the app waits while Claude is mid-turn.
        case "GET /api/busy":
          return json(200, { busy: turn !== null, reasons: turn ? ["claude_turn"] : [] });
        // How Claude's current or last request is going, at once, for other apps to watch.
        case "GET /api/progress": {
          const p = store.project;
          const open = p.openChange;
          return json(
            200,
            progress({
              chat: p.chat as Item[],
              job: p.job,
              busy: turn !== null,
              waiting: p.pending?.waiting.map((w) => w.kind) ?? [],
              queued: p.queued.map((q) => ({ id: q.item, text: q.input.text })),
              now: Date.now(),
              parts: p.design.parts.length,
              openEdits: open?.author === "claude" ? open.edits : 0,
              toolRequests: store.toolRequests(),
              repo,
            }),
          );
        }
        // Changes what every open Woodchuck window shows, never the design.
        // Sent from outside the window, such as a Crossband chat.
        case "POST /api/view": {
          let view: ViewCommand;
          try {
            view = readViewCommand(await body());
          } catch (e) {
            return fail(400, (e as Error).message);
          }
          const d = derive(store.project.design);
          const unknown = (view.select ?? []).filter((id) => !d.byId.has(id));
          if (unknown.length) return fail(400, `There's no part ${unknown.join(", ")}`);
          if (view.drawer === "preview") {
            const waiting = [...store.project.chat].reverse().find((c) => c.kind === "preview" && c.status === "proposed");
            if (!waiting) return fail(400, "There's no preview waiting to show");
          }
          const windows = [...sockets].filter((ws) => ws.readyState === ws.OPEN && !renderSockets.has(ws));
          const msg = JSON.stringify({ type: "view", view });
          for (const ws of windows) ws.send(msg);
          return json(200, { ok: true, windows: windows.length, shown: describeView(view) });
        }
        // A picture of the open design, saved with its renders, for places
        // that can't run the 3D view, such as Crossband.
        case "GET /api/picture": {
          const take = opts.takePicture ?? defaultPicture();
          if (!take) return fail(501, "There's no Chrome on this computer to draw pictures with. Set WOODCHUCK_CHROME to one.");
          const pick = <T extends string>(key: string, allowed: readonly T[], fallback: T): T => {
            const v = url.searchParams.get(key) as T | null;
            return v && allowed.includes(v) ? v : fallback;
          };
          const size = (key: string, fallback: number) => Math.min(Math.max(Math.round(Number(url.searchParams.get(key)) || fallback), 320), 2400);
          try {
            const png = await take({
              look: pick("look", ["finished", "plain"] as const, "finished"),
              lighting: pick("lighting", ["daylight", "evening", "workshop"] as const, "daylight"),
              view: pick("view", ["iso", "front", "top", "left", "right", "back"] as const, "iso"),
              width: size("w", 1280),
              height: size("h", 800),
              ...(url.searchParams.get("preview") ? { preview: String(url.searchParams.get("preview")) } : {}),
            });
            const name = store.project.saveRender(png);
            return json(200, { ok: true, name, url: `/api/renders/${name}` });
          } catch (e) {
            return fail(500, `Couldn't draw the picture: ${(e as Error).message}`);
          }
        }
        case "POST /api/projects": {
          if (turn) return fail(409, "Claude is working. Wait or stop it first.");
          const b = await body();
          const name = String(b.name ?? "").trim() || NEW_DESIGN;
          const example = b.example === "record_console";
          const made = store.create(name, example ? recordConsoleOps().filter((o) => o.op !== "rename_design") : []);
          // The example opens with a card that says what it is.
          if (example) {
            made.example = "record_console";
            made.save();
          }
          broadcastState();
          return json(200, { ok: true });
        }
        case "POST /api/projects/copy": {
          if (turn) return fail(409, "Claude is working. Wait or stop it first.");
          store.copy();
          broadcastState();
          return json(200, { ok: true });
        }
        case "POST /api/projects/import": {
          if (turn) return fail(409, "Claude is working. Wait or stop it first.");
          const d = (await body(5_000_000)).design;
          if (!isDesign(d)) return fail(400, "That file isn't a Woodchuck design");
          store.create(d.name, [], d, "Opened from a file");
          broadcastState();
          return json(200, { ok: true });
        }
        case "GET /api/design.json": {
          res.writeHead(200, {
            "content-type": "application/json",
            "content-disposition": `attachment; filename="${project.slug}.woodchuck.json"`,
          });
          return res.end(JSON.stringify(project.design, null, 2));
        }
        case "GET /api/versions/diff": {
          const sha = url.searchParams.get("sha") ?? "";
          const after = store.versions.show(project.slug, sha);
          if (!after) return fail(404, "There's no such version");
          const before = store.versions.show(project.slug, sha, true) ?? emptyDesign(after.name);
          return json(200, { lines: diffDesigns(before, after, { names: true }) });
        }
        case "POST /api/versions/restore": {
          if (turn) return fail(409, "Claude is working. Wait or stop it first.");
          const sha = String((await body()).sha ?? "");
          const v = store.versions.log(project.slug).find((x) => x.sha === sha);
          const d = v && store.versions.show(project.slug, sha);
          if (!v || !d) return fail(404, "There's no such version");
          const when = plainTime(v.at);
          project.replace(d, "you", `Restore the version from ${when}`);
          broadcastState();
          return json(200, { ok: true });
        }
        case "POST /api/projects/delete": {
          if (turn) return fail(409, "Claude is working. Wait or stop it first.");
          store.remove(String((await body()).slug));
          broadcastState();
          return json(200, { ok: true });
        }
        case "POST /api/projects/open": {
          if (turn) return fail(409, "Claude is working. Wait or stop it first.");
          store.open(String((await body()).slug));
          broadcastState();
          return json(200, { ok: true });
        }
        // Your edits work while Claude does too. Each is a step of its own between Claude's, and Claude hears of it after its current step.
        case "POST /api/ops": {
          const b = await body();
          const ops = b.ops as Op[];
          if (!Array.isArray(ops) || !ops.length) return fail(400, "ops must be a list");
          project.change("you", String(b.label ?? ops[0]!.op), ops);
          broadcastState();
          return json(200, { ok: true });
        }
        // An earlier preview, applied as your own change. One Claude is still
        // waiting on is answered through the chat instead.
        case "POST /api/previews/apply": {
          if (turn) return fail(409, "Claude is working. Wait or stop it first.");
          const id = String((await body()).id ?? "");
          const item = project.chat.find((c) => c.kind === "preview" && c.id === id);
          if (item?.kind !== "preview") return fail(404, "There's no such preview");
          try {
            project.change("you", `Apply Claude's preview: ${item.title}`, item.ops);
          } catch (e) {
            return fail(400, `It doesn't fit the design as it is now: ${(e as Error).message}`);
          }
          item.status = "applied";
          delete item.error;
          project.save();
          broadcastState();
          return json(200, { ok: true });
        }
        case "POST /api/undo":
        case "POST /api/redo": {
          if (turn) return fail(409, "Claude is working. Wait or stop it first.");
          const e = route === "POST /api/undo" ? project.undo() : project.redoOne();
          broadcastState();
          return json(200, { ok: true, entry: e ? { id: e.id, label: e.label } : null });
        }
        case "POST /api/chat": {
          const b = await body(30_000_000);
          let text = String(b.text ?? "").trim();
          if (!text) return fail(400, "Write a message first");
          const selection = Array.isArray(b.selection) ? b.selection.map(String) : [];
          const raw = Array.isArray(b.images) ? (b.images as { media_type?: string; data?: string }[]) : [];
          if (raw.length > MAX_IMAGES) return fail(400, `Attach up to ${MAX_IMAGES} files at a time`);
          const images: { media_type: AttachmentType; data: string; name: string }[] = [];
          for (const img of raw) {
            const ext = ATTACHMENT_TYPES[img.media_type ?? ""];
            if (!ext || typeof img.data !== "string") return fail(400, "Attach JPEG, PNG, WebP or GIF pictures, or a PDF");
            const bytes = Buffer.from(img.data, "base64");
            const limit = ext === "pdf" ? 20 : 5;
            if (bytes.length > limit * 1024 * 1024) return fail(400, `Each ${ext === "pdf" ? "PDF" : "picture"} must be under ${limit} MB`);
            images.push({ media_type: img.media_type as AttachmentType, data: img.data, name: project.saveReference(bytes, ext) });
          }
          const pins = parsePins(b.pins);
          if (pins === null) return fail(400, "Pins must each have a number, a part, a face and a point in mm");
          let view: { media_type: ImageType; data: string; name: string } | undefined;
          if (b.view) {
            const v = b.view as { media_type?: string; data?: string };
            if ((v.media_type !== "image/jpeg" && v.media_type !== "image/png") || typeof v.data !== "string") {
              return fail(400, "The view must be a JPEG or PNG picture");
            }
            const bytes = Buffer.from(v.data, "base64");
            if (bytes.length > 5 * 1024 * 1024) return fail(400, "The view picture must be under 5 MB");
            view = { media_type: v.media_type, data: v.data, name: project.saveReference(bytes, v.media_type === "image/png" ? "png" : "jpg") };
          }
          const input: TurnInput = { text, selection, images, pins, ...(view ? { view } : {}) };
          // While Claude works, a message waits for its next step. It shows in the chat at once.
          if (turn) {
            const line = userLine(input, true);
            project.addChat(line);
            project.queued.push({ item: line.id, input });
            project.save();
            send({ type: "chat", item: line });
            return json(202, { ok: true, steered: true, item: line.id });
          }
          // Approving a part keeps it for use before Claude hears about it. Its
          // pull request opens in the background, so GitHub never holds up the chat.
          if (b.part === "approve" || b.part === "changes") {
            const waiting = library.waiting();
            if (waiting) {
              if (b.part === "approve") {
                const saved = library.approve(waiting.id);
                text += `\n\n(Saved to the library as ${saved.id}.)`;
                // With GitHub off, the part stays on this computer until a repository is named.
                if (repo) share(saved.id, repo).catch((e) => console.error(`Couldn't open a pull request for ${saved.id}: ${(e as Error).message}`));
              } else {
                library.decline(waiting.id);
              }
              for (const item of project.chat) {
                if (item.kind === "part" && item.proposal === waiting.id) item.status = b.part === "approve" ? "approved" : "changes_requested";
              }
            }
          }
          // A preview waiting for an answer is applied only when you click Apply.
          // Any other reply leaves the design alone, and Claude hears which.
          const preview = [...project.chat].reverse().find((c) => c.kind === "preview" && c.status === "proposed");
          if (preview?.kind === "preview" && project.pending?.waiting.some((w) => w.kind === "preview")) {
            if (b.preview === "apply") {
              try {
                project.change("claude", preview.title, preview.ops);
                preview.status = "applied";
                text += "\n\n(Applied as one change.)";
              } catch (e) {
                preview.status = "failed";
                preview.error = (e as Error).message;
                text += `\n\n(It couldn't be applied to the design as it is now: ${preview.error})`;
              }
            } else {
              preview.status = "not_applied";
              if (b.preview !== "not_now") text += "\n\n(The preview wasn't applied.)";
            }
          }
          if ((b.plan === "approve" || b.plan === "changes") && project.design.plan) {
            project.change("you", b.plan === "approve" ? "Approve the plan" : "Ask for plan changes", [
              { op: "set_plan_status", status: b.plan === "approve" ? "approved" : "changes_requested" },
            ]);
            // The reply itself tells Claude, so this isn't worth a note.
            project.notes.pop();
          }
          void startTurn({ ...input, text });
          // The turn has put your message in the chat by now, and that line names the request.
          return json(202, { ok: true, job: project.job?.id });
        }
        // A photo of the room to place the design in.
        case "POST /api/backdrop": {
          const b = await body(30_000_000);
          const ext = ({ "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" } as Record<string, string>)[String(b.media_type)];
          if (!ext || typeof b.data !== "string") return fail(400, "Send a JPEG, PNG or WebP photo");
          const bytes = Buffer.from(b.data, "base64");
          if (bytes.length > 20 * 1024 * 1024) return fail(400, "The photo must be under 20 MB");
          project.backdrop = project.saveReference(bytes, ext);
          project.save();
          broadcastState();
          return json(200, { ok: true, name: project.backdrop });
        }
        // The AI blend: OpenAI relights the placed piece to match the room.
        case "POST /api/blend": {
          const key = process.env.OPENAI_API_KEY;
          const blend = opts.blend ?? (key ? openAiBlend(key) : null);
          if (!blend) return fail(501, "The AI blend needs an OpenAI API key. Add OPENAI_API_KEY to the .env file in the Woodchuck folder, then restart Woodchuck.");
          const b = await body(40_000_000);
          const size = String(b.size) as BlendSize;
          if (!BLEND_SIZES.includes(size) || typeof b.image !== "string" || typeof b.mask !== "string") {
            return fail(400, `Send image and mask as base64 PNGs and a size of ${BLEND_SIZES.join(", ")}`);
          }
          try {
            const png = await blend({ image: Buffer.from(b.image, "base64"), mask: Buffer.from(b.mask, "base64"), size });
            const name = project.saveRender(png);
            return json(200, { ok: true, url: `/api/renders/${name}` });
          } catch (e) {
            // OpenAI's own words can carry part of a key, so they stay in the log and the browser gets plain ones.
            if (e instanceof BlendError) return fail(502, e.message);
            console.error(`The AI blend failed: ${(e as Error).message}`);
            return fail(502, "The AI blend didn't work. The log on the computer running Woodchuck says why.");
          }
        }
        case "POST /api/backdrop/clear": {
          delete project.backdrop;
          project.save();
          broadcastState();
          return json(200, { ok: true });
        }
        case "POST /api/projects/star": {
          const b = await body();
          try {
            store.setStarred(String(b.slug ?? ""), b.starred === true);
          } catch (e) {
            return fail(404, (e as Error).message);
          }
          broadcastState();
          return json(200, { ok: true });
        }
        case "POST /api/model": {
          const m = (await body()).model;
          if (!isModel(m)) return fail(400, `Pick one of ${MODELS.map((x) => x.id).join(", ")}`);
          project.model = m;
          project.save();
          broadcastState();
          return json(200, { ok: true });
        }
        case "POST /api/chat/stop":
          turn?.stop();
          return json(200, { ok: true });
        case "GET /api/cutlist.csv": {
          const d = derive(project.design);
          res.writeHead(200, {
            "content-type": "text/csv; charset=utf-8",
            "content-disposition": `attachment; filename="${project.slug}-cut-list.csv"`,
          });
          return res.end(cutListCsv(cutList(project.design, d)));
        }
        // The Library tab: every part, merged or pending, with the designs that use it.
        case "GET /api/library": {
          const { parts, pending, broken } = library.list();
          let found;
          try {
            found = searchParts(parts, url.searchParams.get("q") ?? "", url.searchParams.get("kind") ?? "");
          } catch (e) {
            return fail(400, (e as Error).message);
          }
          const uses = store.partUses();
          return json(200, {
            total: parts.length,
            parts: found.map((part) => ({ part, ...(pending[part.id] ? { pending: pending[part.id] } : {}), used_by: uses[part.id] ?? [] })),
            broken,
          });
        }
        // Tries a part's pull request again, after GitHub couldn't be reached.
        case "POST /api/library/retry": {
          const id = String((await body()).id ?? "");
          const status = library.list().pending[id];
          if (!status) return fail(404, `There's no part "${id}" waiting for a pull request`);
          if (status.state === "open" && status.auto_merge) return json(200, { ok: true, url: status.url });
          if (!repo) return fail(409, GITHUB_OFF);
          const done = await share(id, repo);
          return done.error ? fail(502, `The pull request isn't finished: ${done.error}`) : json(200, { ok: true, url: done.url });
        }
        // Takes a part out of the library once its pull request was closed. The designs that use it keep their own copy of its specs.
        case "POST /api/library/remove": {
          const id = String((await body()).id ?? "");
          const status = library.list().pending[id];
          if (!status) return fail(404, `There's no part "${id}" waiting for a pull request`);
          try {
            library.remove(id);
          } catch (e) {
            return fail(409, (e as Error).message);
          }
          broadcastState();
          return json(200, { ok: true });
        }
        // Asks GitHub about the open pull requests now, instead of waiting for the next check.
        case "POST /api/library/sync": {
          if (!repo) return fail(409, GITHUB_OFF);
          const closed = await syncParts();
          return json(200, { ok: true, closed });
        }
        case "GET /api/drawings.pdf": {
          const sheets = workshopDrawings(project.design, derive(project.design), paperOf(url.searchParams.get("paper")));
          res.writeHead(200, {
            "content-type": "application/pdf",
            "content-disposition": `attachment; filename="${project.slug}-drawings.pdf"`,
          });
          return res.end(drawingsPdf(sheets, { title: project.design.name }));
        }
        case "POST /api/tool-requests/issue": {
          const b = await body();
          const id = String(b.id ?? "");
          const req = store.toolRequests().find((x) => x.id === id);
          if (!req) return fail(404, `There's no tool request "${id}"`);
          if (req.issue_url) return json(200, { ok: true, url: req.issue_url });
          if (!repo) return fail(409, GITHUB_OFF);
          // The issue is public. Where it came up is text from your design, so it goes in only when you tick the box for it.
          const withExample = b.include_example === true;
          try {
            const url = await (opts.fileIssue ?? ((t, text) => fileIssue(repo, t, text)))(`Build the ${req.name} tool Claude asked for`, toolIssueBody(req, { example: withExample }));
            store.setToolRequestIssue(id, url);
            broadcastState();
            return json(200, { ok: true, url });
          } catch (e) {
            return fail(502, `Couldn't file it on GitHub: ${(e as Error).message}`);
          }
        }
        case "POST /api/tool-requests/sync": {
          if (!repo) return fail(409, GITHUB_OFF);
          const changed = await syncTools();
          return json(200, { ok: true, changed: changed.map((r) => ({ id: r.id, status: r.status })) });
        }
        case "POST /api/tool-requests/status": {
          const b = await body();
          if (!isToolRequestStatus(b.status)) return fail(400, `Pick a status of ${TOOL_REQUEST_STATUSES.join(", ")}`);
          try {
            store.setToolRequestStatus(String(b.id ?? ""), b.status);
          } catch (e) {
            return fail(404, (e as Error).message);
          }
          broadcastState();
          return json(200, { ok: true });
        }
        // Your workshop: the tools you have, your usual finishes, and the language and country Claude uses.
        case "GET /api/workshop":
          return json(200, workshopState());
        case "POST /api/workshop": {
          try {
            store.setWorkshop(await body(50_000));
          } catch (e) {
            if (e instanceof WorkshopError) return fail(400, e.message);
            throw e;
          }
          return json(200, workshopState());
        }
      }
      // The plan views as one picture, for saving: front, top, left and iso.
      if (req.method === "GET" && url.pathname === "/api/plans.png") {
        const png = renderPng(project.design, ["front", "top", "left", "iso"], { xray: url.searchParams.get("xray") === "1" });
        res.writeHead(200, { "content-type": "image/png" });
        return res.end(png);
      }
      const view = /^\/api\/views\/([a-z]+)\.svg$/.exec(url.pathname);
      if (req.method === "GET" && view) {
        const name = view[1] as ViewName;
        if (!(VIEW_NAMES as readonly string[]).includes(name)) return fail(404, "No such view");
        const r = renderView(name, derive(project.design), {
          labels: url.searchParams.get("labels") !== "0",
          width: Number(url.searchParams.get("w") || 800),
          height: Number(url.searchParams.get("h") || 600),
          highlight: url.searchParams.getAll("hl"),
          xray: url.searchParams.get("xray") === "1",
          paper: paperFromParams(url.searchParams),
        });
        res.writeHead(200, { "content-type": "image/svg+xml" });
        return res.end(r.svg);
      }
      // One sheet of the workshop drawings, to look at without a PDF reader.
      const drawing = /^\/api\/drawings\/(\d+)\.svg$/.exec(url.pathname);
      if (req.method === "GET" && drawing) {
        const sheet = workshopDrawings(project.design, derive(project.design), paperOf(url.searchParams.get("paper")))[Number(drawing[1]) - 1];
        if (!sheet) return fail(404, "No such sheet");
        res.writeHead(200, { "content-type": "image/svg+xml" });
        return res.end(sheetSvg(sheet));
      }
      const ref = /^\/api\/references\/([^/]+)$/.exec(url.pathname);
      if (req.method === "GET" && ref) {
        const file = project.referencePath(ref[1]!);
        if (!file) return fail(404, "No such picture");
        const ext = file.split(".").pop()!;
        res.writeHead(200, { "content-type": ext === "jpg" ? "image/jpeg" : ext === "pdf" ? "application/pdf" : `image/${ext}` });
        return createReadStream(file).pipe(res);
      }
      const render = /^\/api\/renders\/([^/]+)$/.exec(url.pathname);
      if (req.method === "GET" && render) {
        const file = project.renderPath(render[1]!);
        if (!file) return fail(404, "No such render");
        res.writeHead(200, { "content-type": "image/png" });
        return createReadStream(file).pipe(res);
      }
      if (req.method === "GET" && !url.pathname.startsWith("/api/") && existsSync(webDist)) {
        const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
        let file = path.resolve(webDist, rel);
        if (!file.startsWith(webDist) || !existsSync(file) || statSync(file).isDirectory()) file = path.join(webDist, "index.html");
        const type = file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : file.endsWith(".svg") ? "image/svg+xml" : "text/html";
        res.writeHead(200, { "content-type": type });
        return createReadStream(file).pipe(res);
      }
      return fail(404, "Not found");
    } catch (e) {
      if (e instanceof OpError) return fail(400, e.message);
      if (e instanceof TooLarge) return fail(413, "That's too large to send");
      return fail(500, (e as Error).message);
    }
  }

  // Pictures come from a Chrome on this computer, loading this server's own page.
  let chromeTaker: TakePicture | null | undefined;
  const defaultPicture = () => {
    if (chromeTaker === undefined) {
      const chrome = findChrome();
      chromeTaker = chrome ? chromePicture(() => `http://127.0.0.1:${(server.address() as AddressInfo).port}`, chrome) : null;
    }
    return chromeTaker;
  };

  // ---- the fence and the lock ----

  let funnel: string | null = null;
  /** Asks Tailscale once whether Funnel is on for this port, and serves nothing while it is. */
  const checkFunnel = async () => {
    if (!opts.funnel) return null;
    const port = (server.address() as AddressInfo | null)?.port ?? PORT;
    let exposed: string | null = null;
    try {
      exposed = funnelExposes(await opts.funnel.status(), port);
    } catch {
      exposed = null;
    }
    if (exposed && !funnel) {
      console.warn(funnelText(exposed));
      for (const ws of sockets) ws.close(1013, "Funnel is on");
    } else if (!exposed && funnel) {
      console.warn("Tailscale Funnel is off again, so Woodchuck is serving.");
    }
    funnel = exposed;
    return exposed;
  };
  const funnelTimer = opts.funnel && opts.funnel.everyS > 0 ? setInterval(() => void checkFunnel(), opts.funnel.everyS * 1000) : null;
  funnelTimer?.unref();

  const authRoute = lockRoutes({ lock, fence, browserOrigin: ownOrigin });

  type Refusal = { status: number; message: string; page?: string };
  /**
   * The checks every request and socket meets, in order: Funnel, the fence,
   * cross-site requests, then the lock. Null lets it through.
   */
  function gate(req: IncomingMessage, pathname: string): Refusal | null {
    const loopback = fromThisComputer(req);
    // Loopback health and busy still answer, so a restart script doesn't mistake the refusal for a crash.
    if (funnel && !(loopback && (pathname === "/api/health" || pathname === "/api/busy"))) {
      return { status: 503, message: funnelText(funnel), ...(pathname.startsWith("/api/") || pathname === "/ws" ? {} : { page: funnelPage(funnel) }) };
    }
    const seen = screen(fence, req);
    if (!seen.ok) return seen;
    if (crossSite(req, pathname)) return { status: 403, message: "Requests to the API from other sites are refused." };
    // On a tailnet address, every /api route outside the login surface, and the socket, need a session.
    const locked = !seen.loopback && (pathname === "/ws" || (pathname.startsWith("/api/") && !LOGIN_SURFACE.has(pathname)));
    if (locked && !lock.sessionOk(sessionFrom(req.headers.cookie))) {
      return { status: 401, message: lock.enrolled ? "Woodchuck is locked. Sign in first." : "Set an owner password first, with the recovery secret." };
    }
    return null;
  }

  const server = createServer((req, res) => {
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://localhost");
    } catch {
      res.writeHead(400);
      return res.end();
    }
    const refused = gate(req, url.pathname);
    if (refused) {
      res.writeHead(refused.status, { "content-type": refused.page ? "text/html; charset=utf-8" : "application/json", "cache-control": "no-store" });
      return res.end(refused.page ?? JSON.stringify({ error: refused.message }));
    }
    void handle(req, res, url);
  });
  if (opts.funnel && opts.funnel.everyS > 0) server.once("listening", () => void checkFunnel());
  const wss = new WebSocketServer({
    server,
    path: "/ws",
    // HTTP checks don't run on an upgrade, so the socket meets the same ones here.
    verifyClient: (info, done) => {
      const refused = gate(info.req, "/ws");
      if (refused) done(false, refused.status, refused.message);
      else done(true);
    },
  });
  wss.on("connection", (ws, req) => {
    if (!fromThisComputer(req)) socketSessions.set(ws, sidHash(sessionFrom(req.headers.cookie) ?? ""));
    sockets.add(ws);
    if (new URL(req.url ?? "/", "http://localhost").searchParams.get("role") === "render") renderSockets.add(ws);
    ws.send(JSON.stringify({ type: "state", state: snapshot() }));
    ws.on("close", () => sockets.delete(ws));
  });

  /** Stops the server, its sockets and any state broadcast still queued. */
  const close = () =>
    new Promise<void>((resolve) => {
      if (pendingState) clearTimeout(pendingState);
      pendingState = null;
      if (toolTimer) clearInterval(toolTimer);
      if (firstCheck) clearTimeout(firstCheck);
      if (funnelTimer) clearInterval(funnelTimer);
      clearInterval(sessionSweep);
      closing = true;
      turn?.stop();
      for (const ws of sockets) ws.terminate();
      wss.close();
      server.close(() => resolve());
      server.closeAllConnections();
    });

  return { server, store, snapshot, close, lock, checkFunnel };
}

class TooLarge extends Error {}

/** A time in plain numbers, such as 2026-10-05 14:30, the same whatever the computer's language. */
export function plainTime(iso: string): string {
  const d = new Date(iso);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

/**
 * The spec, written as an issue for Claude Code to
 * build from. Where it came up is text from your design, so it's left out
 * unless you ask for it.
 */
export function toolIssueBody(
  r: { id: string; name: string; purpose: string; example: string; inputs: string; effect: string; check: string; stopgap?: string; count: number },
  opts: { example?: boolean } = {},
): string {
  return [
    `Claude in Woodchuck needed a tool the app doesn't have yet, so it stopped rather than fake it. ${r.purpose}`,
    "",
    ...(opts.example ? [`Where it came up: ${r.example}`, ""] : []),
    "Risk of acting: small. It's a new deterministic tool with its own tests. Risk of leaving it: designs that need it stay flagged and can't be marked ready to cut.",
    "",
    `What prompted it: tool request ${r.id} in the Woodchuck app, asked for ${r.count === 1 ? "once" : `${r.count} times`}.`,
    "",
    "## Spec",
    "",
    `- **Inputs:** ${r.inputs}`,
    `- **What it changes:** ${r.effect}`,
    `- **How to check it:** ${r.check}`,
    ...(r.stopgap ? [`- **Meanwhile:** ${r.stopgap}`] : []),
    "",
    "Filed from the Woodchuck app.",
  ].join("\n");
}

function fileIssue(repo: string, title: string, body: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let target: string;
    try {
      target = parseRepo(repo).full;
    } catch (e) {
      return reject(e);
    }
    execFile("gh", ["issue", "create", "-R", target, "--title", title, "--body", body], { timeout: 30_000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message).trim()));
      const url = stdout.trim().split("\n").pop() ?? "";
      if (!/^https:\/\/github\.com\//.test(url)) return reject(new Error("GitHub didn't return an issue link"));
      resolve(url);
    });
  });
}

/** Enough of a design's shape to open it; the checks report anything else. */
function isDesign(d: unknown): d is Design {
  if (typeof d !== "object" || d === null) return false;
  const o = d as Record<string, unknown>;
  const lists = ["params", "materials", "parts", "unverified", "joints", "arrays", "hardware", "rules"];
  if (o.schema !== 1 || typeof o.name !== "string" || !lists.every((k) => Array.isArray(o[k]))) return false;
  try {
    derive(d as Design);
    return true;
  } catch {
    return false;
  }
}

const FACE_NAMES = ["left", "right", "bottom", "top", "back", "front"];

/** Checks pins from the app. Returns null when any is malformed. */
function parsePins(raw: unknown): Pin[] | null {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > 20) return null;
  const out: Pin[] = [];
  for (const p of raw as Record<string, unknown>[]) {
    const pt = p?.point_mm;
    if (
      !Number.isInteger(p?.n) ||
      typeof p?.part !== "string" ||
      !FACE_NAMES.includes(String(p?.face)) ||
      !Array.isArray(pt) ||
      pt.length !== 3 ||
      pt.some((v) => typeof v !== "number" || !Number.isFinite(v))
    ) {
      return null;
    }
    out.push({ n: p.n as number, part: p.part, face: String(p.face), point_mm: [pt[0], pt[1], pt[2]] });
  }
  return out;
}

const MAX_IMAGES = 4;
const ATTACHMENT_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "application/pdf": "pdf",
};

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  let host: string;
  try {
    host = bindHost(process.env.WOODCHUCK_HOST);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
  const script = process.env.WOODCHUCK_SCRIPT;
  const trusted = parseTrustedHosts(process.env.WOODCHUCK_TRUSTED_HOSTS);
  const fence = makeFence(trusted, flag(process.env.WOODCHUCK_TAILSCALE_IDENTITY_REQUIRED, true));
  const origin = browserOrigin({
    explicit: process.env.WOODCHUCK_BROWSER_ORIGIN,
    trusted,
    tailscalePort: Number(process.env.WOODCHUCK_TAILSCALE_PORT) || DEFAULT_TAILSCALE_PORT,
    port: PORT,
  });
  // The Funnel check only reads Tailscale's serve config. With no tailscale command there's nothing to ask.
  const everyS = seconds(process.env.WOODCHUCK_FUNNEL_CHECK_S, DEFAULT_FUNNEL_CHECK_S);
  const { PATH = "" } = process.env;
  const bin = everyS > 0 ? findTailscale(PATH, process.env.WOODCHUCK_TAILSCALE_BIN) : null;
  const { server, lock } = createApp({
    dataDir: DATA,
    fence,
    browserOrigin: origin,
    ...(process.env.WOODCHUCK_RECOVERY_SECRET ? { recoverySecret: process.env.WOODCHUCK_RECOVERY_SECRET } : {}),
    ...(bin ? { funnel: { status: tailscaleServeStatus(bin), everyS } } : {}),
    ...(script ? { client: scriptFromFile(script) } : {}),
  });
  if (script) console.log(`Playing back replies from ${script} instead of calling Claude`);
  server.listen(PORT, host, () => {
    console.log(`Woodchuck server on http://127.0.0.1:${PORT} (data in ${DATA})`);
    if (trusted.length) console.log(`Tailnet names: ${trusted.join(", ")}. Open Woodchuck at ${origin}`);
    if (trusted.length && everyS > 0 && !bin) console.log("Funnel check: no tailscale command found, so it can't run. Set WOODCHUCK_TAILSCALE_BIN.");
    for (const line of lock.startupLines(trusted.length > 0)) console.log(line);
  });
}
