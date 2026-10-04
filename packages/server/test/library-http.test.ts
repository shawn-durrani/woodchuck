// Approving a part through the chat opens its pull request in the background,
// and the Library tab reads its data from the server. GitHub is a
// stand-in throughout, so nothing here can reach a real repository. With no
// repository named, GitHub stays off and the part stays on this computer.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/index.js";
import { PartsLibrary } from "../src/library.js";
import { partFileContent } from "../src/partpr.js";
import { scriptedClient, type ScriptBlock } from "../src/scripted.js";
import { Store } from "../src/store.js";
import { FakeGitHub } from "./fakeGithub.js";

const slide = {
  id: "acmeco-glide-450",
  name: "AcmeCo Glide 450 side-mount slide",
  kind: "drawer_slide",
  maker: "AcmeCo",
  sources: [{ url: "https://example.com/acmeco-glide", title: "AcmeCo Glide spec sheet" }],
  specs: { length_mm: 450, clearance_per_side_mm: 12.7, load_kg: 45 },
  shape: [{ name: "slide", min_mm: [0, 0, 0], max_mm: [450, 45, 12.7] }],
};

type Pending = { state: string; url?: string; auto_merge?: boolean; error?: string };
const REPO = "globex/woodchuck";
const SPEC = { name: "scarf_joint", purpose: "Join two short boards end to end.", example: "rail_a meets rail_b", inputs: "host, guest, slope", effect: "Cuts a slope on both ends", check: "Both slopes show" };

type State = { repo: string | null; busy: boolean; waiting: string[]; chat: { kind: string; status?: string }[]; library: { parts: { id: string }[]; pending: Record<string, Pending>; proposals: unknown[] } };

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function start(o: { github?: FakeGitHub; repo?: string | null; before?: (dirs: { data: string; library: string }) => void } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "woodchuck-libhttp-"));
  const dirs = { data: path.join(dir, "data"), library: path.join(dir, "checkout-library-parts") };
  o.before?.(dirs);
  const github = o.github ?? new FakeGitHub();
  const replies: ScriptBlock[][] = [[{ type: "tool_use", id: "p1", name: "propose_library_part", input: slide }], [{ type: "text", text: "Saved." }]];
  const app = createApp({
    dataDir: dirs.data,
    libraryDir: dirs.library,
    client: scriptedClient(replies),
    github,
    repo: o.repo === undefined ? REPO : o.repo,
    issueLookup: async () => null,
    watchTools: false,
  });
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  cleanups.push(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const post = (p: string, body: unknown) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const state = async () => (await (await fetch(`${base}/api/state`)).json()) as State;
  const until = async (ok: (s: State) => boolean) => {
    for (let i = 0; i < 300; i++) {
      const s = await state();
      if (ok(s)) return s;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("The app never got there");
  };
  /** Claude proposes the part, then you approve it. */
  const approvePart = async () => {
    expect((await post("/api/chat", { text: "Use the AcmeCo Glide 450" })).status).toBe(202);
    await until((s) => !s.busy && s.waiting.includes("part"));
    expect((await post("/api/chat", { text: "Approved. Add it to the library.", part: "approve" })).status).toBe(202);
    await until((s) => !s.busy && !!s.library.pending[slide.id]);
  };
  const listing = async (query = "") =>
    (await (await fetch(`${base}/api/library${query}`)).json()) as { total: number; parts: { part: { id: string }; pending?: Pending; used_by: { slug: string; name: string }[] }[] };
  return { base, dirs, github, post, state, until, approvePart, listing };
}

describe("approving a part in the chat", () => {
  it("keeps it for use at once, opens its pull request in the background and leaves the checkout alone", async () => {
    const t = await start();
    await t.approvePart();
    const done = await t.until((s) => s.library.pending[slide.id]?.state === "open");

    expect(done.library.pending[slide.id]).toEqual({ state: "open", url: "https://github.com/globex/woodchuck/pull/1", number: 1, auto_merge: true });
    expect(done.library.parts.map((p) => p.id)).toEqual([slide.id]);
    expect(done.chat.find((c) => c.kind === "part")!.status).toBe("approved");
    expect(t.github.pulls[0]).toMatchObject({ head: "part/acmeco-glide-450", base: "main", autoMerge: true });
    expect(t.github.fileOn("part/acmeco-glide-450")!.path).toBe("library/parts/acmeco-glide-450.json");
    expect(existsSync(t.dirs.library)).toBe(false);
    expect(readdirSync(path.join(t.dirs.data, "library-pending"))).toEqual(["acmeco-glide-450.json"]);
  });

  it("works when GitHub can't be reached, says the pull request is waiting, and retries on request", async () => {
    const github = new FakeGitHub();
    github.failing.set("mainCommit", "could not resolve host: api.github.com");
    const t = await start({ github });
    await t.approvePart();
    const waiting = await t.until((s) => !!s.library.pending[slide.id]?.error);
    expect(waiting.library.pending[slide.id]).toEqual({ state: "waiting", error: "could not resolve host: api.github.com" });
    // The part is in the library and ready to use meanwhile.
    expect(waiting.library.parts.map((p) => p.id)).toEqual([slide.id]);

    const stuck = await t.post("/api/library/retry", { id: slide.id });
    expect(stuck.status).toBe(502);
    expect(((await stuck.json()) as { error: string }).error).toBe("The pull request isn't finished: could not resolve host: api.github.com");

    github.failing.clear();
    const retried = await t.post("/api/library/retry", { id: slide.id });
    expect(retried.status).toBe(200);
    expect(await retried.json()).toEqual({ ok: true, url: "https://github.com/globex/woodchuck/pull/1" });
    expect((await t.state()).library.pending[slide.id]).toMatchObject({ state: "open", auto_merge: true });

    // Once it's open there's nothing to retry, and GitHub isn't asked again.
    const calls = github.calls.length;
    expect((await t.post("/api/library/retry", { id: slide.id })).status).toBe(200);
    expect(github.calls).toHaveLength(calls);
    expect((await t.post("/api/library/retry", { id: "nope-nope" })).status).toBe(404);
  });

  it("keeps the part on this computer, and never calls GitHub, while no repository is named", async () => {
    const t = await start({ repo: null });
    await t.approvePart();
    const s = await t.state();
    expect(s.repo).toBeNull();
    expect(s.library.pending[slide.id]).toEqual({ state: "waiting" });
    expect(s.library.parts.map((p) => p.id)).toEqual([slide.id]);
    const retry = await t.post("/api/library/retry", { id: slide.id });
    expect(retry.status).toBe(409);
    expect(((await retry.json()) as { error: string }).error).toMatch(/^GitHub is off .* Add WOODCHUCK_REPO=owner\/name to the \.env file/);
    expect((await t.post("/api/library/sync", {})).status).toBe(409);
    expect(t.github.calls).toEqual([]);
  });

  it("uses the repository it's given", async () => {
    const t = await start({ repo: "Alex-Co/parts" });
    await t.approvePart();
    await t.until((s) => s.library.pending[slide.id]?.state === "open");
    expect(new Set(t.github.calls.map((c) => c.repo))).toEqual(new Set(["Alex-Co/parts"]));
  });
});

describe("the Library tab's data", () => {
  it("lists parts with their pull request and the designs that use them, and searches them", async () => {
    const t = await start();
    await t.approvePart();
    await t.until((s) => s.library.pending[slide.id]?.state === "open");

    // A design that fits the part, and one that doesn't.
    expect((await t.post("/api/projects", { name: "Console", example: "record_console" })).status).toBe(200);
    const fit = { op: "set_hardware", id: "slides_two", kind: "drawer_slide", name: "AcmeCo Glide", connects: ["bottom"], library_part: slide.id };
    expect((await t.post("/api/ops", { ops: [fit] })).status).toBe(200);
    expect((await t.post("/api/projects", { name: "Bench" })).status).toBe(200);

    const all = await t.listing();
    expect(all.total).toBe(1);
    expect(all.parts).toHaveLength(1);
    expect(all.parts[0]!.part).toMatchObject({ id: slide.id, name: slide.name });
    expect(all.parts[0]!.pending).toMatchObject({ state: "open", auto_merge: true });
    expect(all.parts[0]!.used_by).toEqual([{ slug: "console", name: "Console" }]);

    expect((await t.listing("?q=acmeco")).parts).toHaveLength(1);
    expect((await t.listing("?q=drawer+slide&kind=drawer_slide")).parts).toHaveLength(1);
    const none = await t.listing("?q=initech");
    expect(none.parts).toEqual([]);
    expect(none.total).toBe(1);
    expect((await t.listing("?kind=hinge")).parts).toEqual([]);
    expect((await fetch(`${t.base}/api/library?kind=chair`)).status).toBe(400);
  });

  it("drops the pending copy at startup once the part has arrived in library/parts", async () => {
    const t = await start({
      before: (dirs) => {
        mkdirSync(dirs.data, { recursive: true });
        const library = new PartsLibrary(dirs.library, path.join(dirs.data, "part-proposals.json"));
        const part = library.approve(library.propose(slide).id);
        mkdirSync(dirs.library, { recursive: true });
        writeFileSync(path.join(dirs.library, "acmeco-glide-450.json"), partFileContent(part));
      },
    });
    expect(readdirSync(path.join(t.dirs.data, "library-pending"))).toEqual([]);
    const s = await t.state();
    expect(s.library.pending).toEqual({});
    expect(s.library.parts.map((p) => p.id)).toEqual([slide.id]);
    expect((await t.listing()).parts[0]!.pending).toBeUndefined();
    expect(t.github.calls).toEqual([]);
  });
});

describe("a part whose pull request was closed without merging", () => {
  type Listing = { total: number; parts: { part: { id: string }; pending?: Pending }[] };
  const closedUrl = "https://github.com/globex/woodchuck/pull/1";

  /** The part approved, its pull request open, and then closed on GitHub. */
  async function closedPart(github = new FakeGitHub()) {
    const t = await start({ github });
    await t.approvePart();
    await t.until((s) => s.library.pending[slide.id]?.state === "open");
    return { t, github };
  }
  const sync = async (t: Awaited<ReturnType<typeof start>>) => (await (await t.post("/api/library/sync", {})).json()) as { ok: boolean; closed: string[] };

  it("says the pull request is closed, lists the part as closed and still lets designs use it", async () => {
    const { t, github } = await closedPart();
    github.close(1);
    expect(await sync(t)).toEqual({ ok: true, closed: [slide.id] });

    const s = await t.state();
    expect(s.library.pending[slide.id]).toEqual({ state: "closed", url: closedUrl, number: 1 });
    expect(s.library.parts.map((p) => p.id)).toEqual([slide.id]);
    expect(s.chat.find((c) => c.kind === "part")!.status).toBe("approved");
    expect(((await (await fetch(`${t.base}/api/library`)).json()) as Listing).parts[0]!.pending).toMatchObject({ state: "closed" });
    // Checking again finds nothing new, and a retry isn't made for you.
    expect(await sync(t)).toEqual({ ok: true, closed: [] });
    expect(github.pulls).toHaveLength(1);
  });

  it("leaves an open pull request, and a merged one, as they are", async () => {
    const { t, github } = await closedPart();
    expect(await sync(t)).toEqual({ ok: true, closed: [] });
    github.merge(1);
    expect(await sync(t)).toEqual({ ok: true, closed: [] });
    expect((await t.state()).library.pending[slide.id]).toMatchObject({ state: "open", auto_merge: true });
    expect(readdirSync(path.join(t.dirs.data, "library-pending"))).toEqual(["acmeco-glide-450.json"]);
  });

  it("changes nothing when GitHub can't be reached", async () => {
    const { t, github } = await closedPart();
    github.close(1);
    github.failing.set("pullRequestState", "could not resolve host: api.github.com");
    expect(await sync(t)).toEqual({ ok: true, closed: [] });
    expect((await t.state()).library.pending[slide.id]!.state).toBe("open");
  });

  it("opens a new pull request when you ask to", async () => {
    const { t, github } = await closedPart();
    github.close(1);
    await sync(t);

    const r = await t.post("/api/library/retry", { id: slide.id });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, url: "https://github.com/globex/woodchuck/pull/2" });
    expect((await t.state()).library.pending[slide.id]).toEqual({ state: "open", url: "https://github.com/globex/woodchuck/pull/2", number: 2, auto_merge: true });
    expect(github.pulls.map((p) => [p.number, p.state, p.autoMerge])).toEqual([[1, "closed", true], [2, "open", true]]);
  });

  it("removes the part from the library, and the designs that used it keep their copy of its specs", async () => {
    const { t, github } = await closedPart();
    expect((await t.post("/api/projects", { name: "Console", example: "record_console" })).status).toBe(200);
    const fit = { op: "set_hardware", id: "slides_two", kind: "drawer_slide", name: slide.name, connects: ["bottom"], library_part: slide.id, spec: slide.specs, shape: slide.shape };
    expect((await t.post("/api/ops", { ops: [fit] })).status).toBe(200);
    github.close(1);
    await sync(t);

    const r = await t.post("/api/library/remove", { id: slide.id });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
    expect(readdirSync(path.join(t.dirs.data, "library-pending"))).toEqual([]);
    const s = (await t.state()) as unknown as { library: { parts: unknown[]; pending: object }; design: { hardware: { id: string; library_part?: string; spec: Record<string, number> }[] } };
    expect(s.library.parts).toEqual([]);
    expect(s.library.pending).toEqual({});
    expect((await t.listing()).total).toBe(0);
    expect(s.design.hardware.find((h) => h.id === "slides_two")).toMatchObject({ library_part: slide.id, spec: { length_mm: 450, load_kg: 45 } });
    // Removing it again says there's nothing there, and GitHub isn't asked to do anything more.
    expect((await t.post("/api/library/remove", { id: slide.id })).status).toBe(404);
    expect(github.pulls).toHaveLength(1);
  });

  it("won't remove a part whose pull request is still open", async () => {
    const { t } = await closedPart();
    const r = await t.post("/api/library/remove", { id: slide.id });
    expect(r.status).toBe(409);
    expect(((await r.json()) as { error: string }).error).toMatch(/can only be removed once its pull request is closed/);
    expect((await t.state()).library.parts.map((p) => p.id)).toEqual([slide.id]);
    expect(readdirSync(path.join(t.dirs.data, "library-pending"))).toEqual(["acmeco-glide-450.json"]);
    expect((await t.post("/api/library/remove", { id: "nope-nope" })).status).toBe(404);
  });

  it("checks at startup and every five minutes, like the tool requests", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "woodchuck-libwatch-"));
    const dataDir = path.join(dir, "data");
    const github = new FakeGitHub();
    mkdirSync(dataDir, { recursive: true });
    const library = new PartsLibrary(path.join(dir, "checkout-library-parts"), path.join(dataDir, "part-proposals.json"));
    await library.share(library.approve(library.propose(slide).id).id, github, REPO);
    github.calls = [];

    vi.useFakeTimers();
    const app = createApp({ dataDir, libraryDir: path.join(dir, "checkout-library-parts"), client: scriptedClient([]), github, repo: REPO, issueLookup: async () => null });
    try {
      const asked = () => github.calls.filter((c) => c.method === "pullRequestState").length;
      const state = () => app.snapshot().library.pending[slide.id]!.state;
      await vi.advanceTimersByTimeAsync(4_999);
      expect(asked()).toBe(0);
      // The first look is just after startup. The pull request is still open.
      await vi.advanceTimersByTimeAsync(1);
      expect(asked()).toBe(1);
      expect(state()).toBe("open");

      // Closed on GitHub, and noticed at the next five-minute check, not before.
      github.close(1);
      await vi.advanceTimersByTimeAsync(5 * 60_000 - 5_001);
      expect(asked()).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(asked()).toBe(2);
      expect(state()).toBe("closed");
    } finally {
      vi.useRealTimers();
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never checks while no repository is named", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "woodchuck-liboff-"));
    const dataDir = path.join(dir, "data");
    const github = new FakeGitHub();
    mkdirSync(dataDir, { recursive: true });
    const library = new PartsLibrary(path.join(dir, "checkout-library-parts"), path.join(dataDir, "part-proposals.json"));
    await library.share(library.approve(library.propose(slide).id).id, github, REPO);
    github.calls = [];
    // A tool request filed before, whose issue would be looked up if GitHub were on.
    const store = new Store(dataDir);
    store.setToolRequestIssue(store.addToolRequest(SPEC).id, "https://github.com/globex/woodchuck/issues/4");
    let looked = 0;

    vi.useFakeTimers();
    const app = createApp({
      dataDir,
      libraryDir: path.join(dir, "checkout-library-parts"),
      client: scriptedClient([]),
      github,
      repo: null,
      issueLookup: async () => {
        looked++;
        return null;
      },
    });
    try {
      await vi.advanceTimersByTimeAsync(11 * 60_000);
      expect(github.calls).toEqual([]);
      expect(looked).toBe(0);
    } finally {
      vi.useRealTimers();
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
