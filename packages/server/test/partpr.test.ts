// Sharing an approved part: its pull request, the checkout staying
// clean, GitHub failing and trying again, the hand-over once the file merges,
// which repository it acts in, and what the Library tab asks of the server. Every
// GitHub call goes to a stand-in.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recordConsoleOps, validateLibraryPart, type LibraryPart } from "@woodchuck/core";
import { ghCli, parseRepo, type GhRun } from "../src/github.js";
import { PartsLibrary, searchParts } from "../src/library.js";
import { openPartPullRequest, partFileContent, partPullRequestText } from "../src/partpr.js";
import { Store } from "../src/store.js";
import { FakeGitHub } from "./fakeGithub.js";

const REPO = "globex/woodchuck";

const slide = {
  id: "acmeco-glide-450",
  name: "AcmeCo Glide 450 side-mount slide",
  kind: "drawer_slide",
  maker: "AcmeCo",
  model: "Glide 450",
  sources: [{ url: "https://example.com/acmeco-glide", title: "AcmeCo Glide spec sheet", note: "length and clearance" }, { note: "Spec sheet attached by Alex" }],
  specs: { length_mm: 450, clearance_per_side_mm: 12.7, load_kg: 45 },
  shape: [{ name: "slide", min_mm: [0, 0, 0], max_mm: [450, 45, 12.7] }],
};
const hinge = {
  id: "initech-concealed-hinge",
  name: "Initech concealed hinge",
  kind: "hinge",
  maker: "Initech",
  sources: [{ url: "https://example.com/initech-hinge" }],
  specs: { opening_angle_deg: 110 },
  shape: [{ name: "cup", min_mm: [0, 0, 0], max_mm: [35, 12, 35] }],
};
const handle = {
  id: "globex-bar-handle",
  name: "Globex bar handle",
  kind: "handle",
  maker: "Globex",
  sources: [{ note: "measured by Sam" }],
  specs: { centres_mm: 128 },
  shape: [{ name: "bar", min_mm: [0, 0, 0], max_mm: [140, 12, 30] }],
};

let dir: string;
let libraryDir: string;
let library: PartsLibrary;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "woodchuck-partpr-"));
  libraryDir = path.join(dir, "checkout-library-parts");
  mkdirSync(path.join(dir, "data"), { recursive: true });
  library = new PartsLibrary(libraryDir, path.join(dir, "data", "part-proposals.json"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const approve = (input: unknown = slide) => library.approve(library.propose(input).id);
const pendingFile = (id = "acmeco-glide-450") => path.join(dir, "data", "library-pending", `${id}.json`);

describe("which repository the app may act in", () => {
  it("takes owner/name and refuses anything else", () => {
    expect(parseRepo("globex/woodchuck").full).toBe(REPO);
    expect(parseRepo(" Acme-Co/parts.lib ").full).toBe("Acme-Co/parts.lib");
    for (const bad of ["woodchuck", "a/b/c", "https://github.com/a/b", "-a/b", "a-/b", "a/", "/b", "a b/c", "a/b c", "a/..", ""]) {
      expect(() => parseRepo(bad), bad).toThrow(/owner\/name/);
    }
  });

  it("opens no pull request for a repository it can't use, and never calls GitHub", async () => {
    approve();
    const github = new FakeGitHub();
    const status = await library.share("acmeco-glide-450", github, "not a repo");
    expect(status.state).toBe("waiting");
    expect(status.error).toMatch(/must be written owner\/name/);
    expect(github.calls).toEqual([]);
    // The part still works.
    expect(library.get("acmeco-glide-450")).toBeTruthy();
  });

  it("is checked again inside the gh wrapper, so no caller can get round it", async () => {
    const run: GhRun = async () => {
      throw new Error("gh must not run");
    };
    const gh = ghCli(run);
    await expect(gh.mainCommit("globex")).rejects.toThrow(/owner\/name/);
    await expect(gh.createBlob("globex/woodchuck/extra", "x")).rejects.toThrow(/owner\/name/);
    await expect(gh.findPullRequest("-globex/woodchuck", "part/x")).rejects.toThrow(/owner\/name/);
    await expect(gh.createPullRequest("globex/..", { base: "main", head: "part/x", title: "t", body: "b" })).rejects.toThrow(/owner\/name/);
    await expect(gh.enableAutoMerge("https://github.com/globex/woodchuck", 1)).rejects.toThrow(/owner\/name/);
    await expect(gh.pullRequestState("globex /woodchuck", 1)).rejects.toThrow(/owner\/name/);
  });
});

describe("the pull request for an approved part", () => {
  it("puts the one file on part/<id>, opens the pull request into main and turns on auto-merge", async () => {
    const part = approve();
    const github = new FakeGitHub();
    const status = await library.share(part.id, github, REPO);

    expect(github.names()).toEqual(["findPullRequest", "mainCommit", "createBlob", "createTree", "createCommit", "setBranch", "createPullRequest", "enableAutoMerge"]);
    expect(new Set(github.calls.map((c) => c.repo))).toEqual(new Set([REPO]));

    // The branch holds one file, added to main's own tree and parented on main's commit.
    const file = github.fileOn("part/acmeco-glide-450")!;
    expect(file.path).toBe("library/parts/acmeco-glide-450.json");
    expect(file.baseTree).toBe("main-tree");
    expect(file.parent).toBe("main-sha");
    expect(file.content).toBe(`${JSON.stringify(part, null, 2)}\n`);
    expect(file.content).toBe(partFileContent(part));
    // It's the file the repo's own test accepts: valid, and named for its id.
    expect(validateLibraryPart(JSON.parse(file.content!))).toEqual(part);
    expect(file.message).toBe("Add AcmeCo Glide 450 side-mount slide to the parts library");

    const pr = github.pulls[0]!;
    expect(pr).toMatchObject({ base: "main", head: "part/acmeco-glide-450", title: "Add AcmeCo Glide 450 side-mount slide to the parts library", autoMerge: true });
    expect(status).toEqual({ state: "open", url: `https://github.com/${REPO}/pull/1`, number: 1, auto_merge: true });
    expect(github.calls.at(-1)).toMatchObject({ method: "enableAutoMerge", args: [1] });

    // The status stays on the pending part.
    expect(library.list().pending["acmeco-glide-450"]).toEqual(status);
    expect(JSON.parse(readFileSync(pendingFile(), "utf8")).pull_request).toEqual(status);
  });

  it("writes nothing into the checkout's library folder", async () => {
    // The repo's folder as it is checked out: empty but for its placeholder.
    mkdirSync(libraryDir, { recursive: true });
    writeFileSync(path.join(libraryDir, ".gitkeep"), "");
    approve();
    await library.share("acmeco-glide-450", new FakeGitHub(), REPO);
    await library.share("acmeco-glide-450", new FakeGitHub(), REPO);
    expect(readdirSync(libraryDir)).toEqual([".gitkeep"]);
    expect(readdirSync(path.join(dir, "data", "library-pending"))).toEqual(["acmeco-glide-450.json"]);
  });

  it("keeps the pending part private to you", async () => {
    approve();
    await library.share("acmeco-glide-450", new FakeGitHub(), REPO);
    expect(statSync(pendingFile()).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(pendingFile())).mode & 0o777).toBe(0o700);
  });

  it("is written in the house shape for a pull request", () => {
    const { title, body } = partPullRequestText({ ...validateLibraryPart(slide), approved_at: "2026-10-03T00:00:00.000Z" });
    expect(title).toBe("Add AcmeCo Glide 450 side-mount slide to the parts library");
    const [context, risks, prompted, heading, detail, ...rest] = body.split("\n\n");
    // Two to five plain sentences of context come first.
    expect(context!.split(/(?<=\.) /)).toHaveLength(3);
    expect(context).toContain("library/parts/acmeco-glide-450.json");
    expect(risks).toMatch(/^Risk of acting: small\. .*\. Risk of leaving it: .*\.$/s);
    expect(prompted).toBe("What prompted it: you approved the part in the Woodchuck chat.");
    expect(heading).toBe("## Detail");
    expect(detail).toBe(
      [
        "- **Part:** `AcmeCo Glide 450 side-mount slide` (`acmeco-glide-450`), a drawer slide, made by `AcmeCo`, model `Glide 450`",
        "- **Key specs:**",
        "  - `length_mm`: 450",
        "  - `clearance_per_side_mm`: 12.7",
        "  - `load_kg`: 45",
        "- **Sources:**",
        "  - `AcmeCo Glide spec sheet`, <https://example.com/acmeco-glide>, `length and clearance`",
        "  - `Spec sheet attached by Alex`",
      ].join("\n"),
    );
    expect(rest).toEqual(["Opened from the Woodchuck app."]);
  });

  it("keeps text from a web page inert in the body and the title", () => {
    const part = validateLibraryPart({
      ...slide,
      name: "Slide @alex `x`\n#12",
      mounting: "Screw it @sam",
      sources: [{ url: "https://example.com/a b", title: "[click](https://evil.example)" }],
    });
    const { title, body } = partPullRequestText(part);
    expect(title).toBe("Add Slide @alex `x` #12 to the parts library");
    expect(body).toContain("`Slide @alex 'x' #12`");
    expect(body).toContain("**Mounting:** `Screw it @sam`");
    expect(body).toContain("`[click](https://evil.example)`, `https://example.com/a b`");
    expect(body).not.toMatch(/^[^`]*@alex/m);
  });

  it("goes in a pull request of its own, never into a second one", async () => {
    approve();
    approve(hinge);
    const github = new FakeGitHub();
    await library.share("acmeco-glide-450", github, REPO);
    await library.share("initech-concealed-hinge", github, REPO);
    expect(github.pulls.map((p) => [p.head, p.autoMerge])).toEqual([
      ["part/acmeco-glide-450", true],
      ["part/initech-concealed-hinge", true],
    ]);
    expect(github.fileOn("part/initech-concealed-hinge")!.path).toBe("library/parts/initech-concealed-hinge.json");
  });
});

describe("when GitHub can't be reached", () => {
  it("leaves a working pending part marked as waiting, and a retry opens the pull request", async () => {
    const part = approve();
    const github = new FakeGitHub();
    github.failing.set("mainCommit", "dial tcp: lookup api.github.com: no such host");

    const first = await library.share(part.id, github, REPO);
    expect(first).toEqual({ state: "waiting", error: "dial tcp: lookup api.github.com: no such host" });
    expect(library.list().pending[part.id]).toEqual(first);
    // The part is still in the library and fits a design.
    expect(library.get(part.id)).toMatchObject({ id: part.id });
    expect(github.pulls).toEqual([]);

    github.failing.clear();
    const second = await library.share(part.id, github, REPO);
    expect(second).toEqual({ state: "open", url: `https://github.com/${REPO}/pull/1`, number: 1, auto_merge: true });
    expect(github.pulls).toHaveLength(1);
    expect(library.list().pending[part.id]).toEqual(second);
  });

  it("opens the pull request once when the branch was made but the pull request wasn't", async () => {
    const part = approve();
    const github = new FakeGitHub();
    github.failing.set("createPullRequest", "timed out");
    expect((await library.share(part.id, github, REPO)).state).toBe("waiting");
    expect(github.branches.has("part/acmeco-glide-450")).toBe(true);

    github.failing.clear();
    expect((await library.share(part.id, github, REPO)).auto_merge).toBe(true);
    expect(github.pulls).toHaveLength(1);
    expect(github.fileOn("part/acmeco-glide-450")!.content).toBe(partFileContent(part));
  });

  it("keeps an open pull request when only auto-merge failed, and a retry finishes it without a second one", async () => {
    const part = approve();
    const github = new FakeGitHub();
    github.failing.set("enableAutoMerge", "Auto merge is not allowed for this repository");

    const first = await library.share(part.id, github, REPO);
    expect(first).toEqual({
      state: "open",
      url: `https://github.com/${REPO}/pull/1`,
      number: 1,
      auto_merge: false,
      error: "The pull request is open, but auto-merge isn't on: Auto merge is not allowed for this repository",
    });

    github.failing.clear();
    github.calls = [];
    const second = await library.share(part.id, github, REPO);
    expect(second).toEqual({ state: "open", url: `https://github.com/${REPO}/pull/1`, number: 1, auto_merge: true });
    expect(github.names()).toEqual(["findPullRequest", "enableAutoMerge"]);
    expect(github.pulls).toHaveLength(1);
  });

  it("keeps the link to an open pull request when a retry can't reach GitHub", async () => {
    const part = approve();
    const github = new FakeGitHub();
    github.failing.set("enableAutoMerge", "nope");
    await library.share(part.id, github, REPO);
    github.failing.set("findPullRequest", "offline");
    const again = await library.share(part.id, github, REPO);
    expect(again).toMatchObject({ state: "open", url: `https://github.com/${REPO}/pull/1`, error: "offline" });
  });

  it("shows a part as opening while its pull request is being made, and runs it once", async () => {
    const part = approve();
    const github = new FakeGitHub();
    let release!: () => void;
    github.gate = new Promise<void>((r) => (release = r));
    const a = library.share(part.id, github, REPO);
    const b = library.share(part.id, github, REPO);
    expect(library.list().pending[part.id]).toEqual({ state: "opening" });
    release();
    expect(await a).toEqual(await b);
    expect(github.pulls).toHaveLength(1);
    expect(library.list().pending[part.id]!.state).toBe("open");
  });

  it("says so when there's no such pending part", async () => {
    await expect(library.share("nope-nope", new FakeGitHub(), REPO)).rejects.toThrow(/no part nope-nope waiting/);
  });
});

describe("the hand-over once the file merges and deploys", () => {
  const arrive = (part: LibraryPart) => {
    mkdirSync(libraryDir, { recursive: true });
    writeFileSync(path.join(libraryDir, `${part.id}.json`), partFileContent(part));
  };

  it("drops the pending copy when listing", async () => {
    const part = approve();
    await library.share(part.id, new FakeGitHub(), REPO);
    expect(Object.keys(library.list().pending)).toEqual([part.id]);

    arrive(part);
    const listed = library.list();
    expect(listed.pending).toEqual({});
    expect(listed.parts).toEqual([part]);
    expect(existsSync(pendingFile())).toBe(false);
    expect(library.get(part.id)).toEqual(part);
  });

  it("drops it on startup too, before anything lists", async () => {
    const part = approve();
    approve(hinge);
    arrive(part);
    const restarted = new PartsLibrary(libraryDir, path.join(dir, "data", "part-proposals.json"));
    expect(restarted.handOver()).toEqual([part.id]);
    expect(readdirSync(path.join(dir, "data", "library-pending"))).toEqual(["initech-concealed-hinge.json"]);
    expect(restarted.handOver()).toEqual([]);
  });

  it("lists a part once, from the merged file, whichever copy is newer", () => {
    const part = approve();
    arrive({ ...part, notes: "from the merged file" });
    expect(library.list().parts).toEqual([{ ...part, notes: "from the merged file" }]);
  });

  it("keeps the pending part while the merged file is broken, and says so", () => {
    approve();
    mkdirSync(libraryDir, { recursive: true });
    writeFileSync(path.join(libraryDir, "acmeco-glide-450.json"), "{}");
    const listed = library.list();
    expect(Object.keys(listed.pending)).toEqual(["acmeco-glide-450"]);
    expect(listed.broken).toEqual([{ file: "acmeco-glide-450.json", error: expect.stringMatching(/id is required/) }]);
  });

  it("reports an unreadable pending part instead of hiding it", () => {
    mkdirSync(path.join(dir, "data", "library-pending"), { recursive: true });
    writeFileSync(path.join(dir, "data", "library-pending", "oops.json"), "{not json");
    expect(library.list().broken).toEqual([{ file: "oops.json", error: expect.any(String), pending: true }]);
  });
});

describe("a pull request closed without merging", () => {
  const arrive = (part: LibraryPart) => {
    mkdirSync(libraryDir, { recursive: true });
    writeFileSync(path.join(libraryDir, `${part.id}.json`), partFileContent(part));
  };
  /** An approved part with its pull request open on GitHub. */
  const shared = async (input: unknown = slide) => {
    const part = approve(input);
    const github = new FakeGitHub();
    await library.share(part.id, github, REPO);
    github.calls = [];
    return { part, github };
  };

  it("marks the part closed and keeps it working, once GitHub says its pull request was closed", async () => {
    const { part, github } = await shared();
    github.close(1);

    expect(await library.syncPullRequests(github, REPO)).toEqual([part.id]);
    expect(github.calls).toEqual([{ method: "pullRequestState", repo: REPO, args: [1] }]);
    expect(library.list().pending[part.id]).toEqual({ state: "closed", url: `https://github.com/${REPO}/pull/1`, number: 1 });
    // Still in the library, and still a file in the data folder.
    expect(library.get(part.id)).toMatchObject({ id: part.id });
    expect(existsSync(pendingFile())).toBe(true);
    // It stays marked across a restart, and isn't asked about again.
    const restarted = new PartsLibrary(libraryDir, path.join(dir, "data", "part-proposals.json"));
    expect(restarted.list().pending[part.id]!.state).toBe("closed");
    expect(await restarted.syncPullRequests(github, REPO)).toEqual([]);
    expect(github.calls).toHaveLength(1);
  });

  it("leaves a merged pull request for the hand-over, which drops the copy once the file arrives", async () => {
    const { part, github } = await shared();
    github.merge(1);

    expect(await library.syncPullRequests(github, REPO)).toEqual([]);
    expect(library.list().pending[part.id]).toEqual({ state: "open", url: `https://github.com/${REPO}/pull/1`, number: 1, auto_merge: true });

    arrive(part);
    expect(library.handOver()).toEqual([part.id]);
    expect(existsSync(pendingFile())).toBe(false);
    expect(library.list().parts).toEqual([part]);
  });

  it("leaves an open pull request unchanged", async () => {
    const { part, github } = await shared();
    const before = library.list().pending[part.id];
    expect(await library.syncPullRequests(github, REPO)).toEqual([]);
    expect(library.list().pending[part.id]).toEqual(before);
    expect(github.names()).toEqual(["pullRequestState"]);
  });

  it("changes nothing when GitHub can't be reached, and asks about the part again next time", async () => {
    const { part, github } = await shared();
    github.close(1);
    github.failing.set("pullRequestState", "dial tcp: lookup api.github.com: no such host");
    expect(await library.syncPullRequests(github, REPO)).toEqual([]);
    expect(library.list().pending[part.id]!.state).toBe("open");

    github.failing.clear();
    expect(await library.syncPullRequests(github, REPO)).toEqual([part.id]);
  });

  it("doesn't ask about a part with no pull request yet, or one that's being opened", async () => {
    const waiting = approve(hinge);
    const { part, github } = await shared();
    github.close(1);
    let release!: () => void;
    github.gate = new Promise<void>((r) => (release = r));
    const opening = library.share(waiting.id, github, REPO);
    // The part being opened is skipped, so its closed neighbour is the only one asked about.
    const sync = library.syncPullRequests(github, REPO);
    release();
    await opening;
    expect(await sync).toEqual([part.id]);
    expect(github.calls.filter((c) => c.method === "pullRequestState").map((c) => c.args)).toEqual([[1]]);
    expect(library.list().pending[waiting.id]!.state).toBe("open");
  });

  it("never asks about a repository other than the one it's given", async () => {
    const { part, github } = await shared();
    github.close(1);
    // A pull request that lives in another repository is never looked up by its number.
    expect(await library.syncPullRequests(github, "Alex-Co/parts")).toEqual([]);
    expect(await library.syncPullRequests(github, "not a repo")).toEqual([]);
    expect(github.calls).toEqual([]);
    expect(library.list().pending[part.id]!.state).toBe("open");
    // The same repository in different capitals is the same repository.
    expect(await library.syncPullRequests(github, "Globex/WoodChuck")).toEqual([part.id]);
    expect(github.calls.map((c) => c.repo)).toEqual(["Globex/WoodChuck"]);
  });

  it("opens a new pull request when you retry a closed one", async () => {
    const { part, github } = await shared();
    github.close(1);
    await library.syncPullRequests(github, REPO);
    github.calls = [];

    const again = await library.share(part.id, github, REPO);
    expect(again).toEqual({ state: "open", url: `https://github.com/${REPO}/pull/2`, number: 2, auto_merge: true });
    expect(github.names()).toEqual(["findPullRequest", "mainCommit", "createBlob", "createTree", "createCommit", "setBranch", "createPullRequest", "enableAutoMerge"]);
    expect(github.pulls.map((p) => [p.number, p.head, p.state, p.autoMerge])).toEqual([
      [1, "part/acmeco-glide-450", "closed", true],
      [2, "part/acmeco-glide-450", "open", true],
    ]);
    expect(github.fileOn("part/acmeco-glide-450")!.content).toBe(partFileContent(part));
    expect(library.list().pending[part.id]).toEqual(again);
    // The new one is the one asked about now.
    github.calls = [];
    expect(await library.syncPullRequests(github, REPO)).toEqual([]);
    expect(github.calls[0]!.args).toEqual([2]);
  });

  it("reuses a pull request that was reopened on GitHub, and only turns on auto-merge", async () => {
    const { part, github } = await shared();
    github.close(1);
    await library.syncPullRequests(github, REPO);
    github.pulls[0]!.state = "open";
    github.calls = [];

    expect((await library.share(part.id, github, REPO)).number).toBe(1);
    expect(github.names()).toEqual(["findPullRequest", "enableAutoMerge"]);
    expect(github.pulls).toHaveLength(1);
  });

  it("keeps the part closed, with what GitHub said, when a retry can't reach GitHub", async () => {
    const { part, github } = await shared();
    github.close(1);
    await library.syncPullRequests(github, REPO);
    github.failing.set("mainCommit", "offline");

    const again = await library.share(part.id, github, REPO);
    expect(again).toEqual({ state: "closed", url: `https://github.com/${REPO}/pull/1`, number: 1, error: "offline" });
    expect(library.list().pending[part.id]).toEqual(again);
    expect(library.get(part.id)).toBeTruthy();
  });

  it("removes a closed part by deleting its pending file, and nothing else", async () => {
    const { part, github } = await shared();
    const other = approve(hinge);
    github.close(1);
    await library.syncPullRequests(github, REPO);
    expect(existsSync(pendingFile())).toBe(true);

    library.remove(part.id);
    expect(existsSync(pendingFile())).toBe(false);
    expect(library.get(part.id)).toBeUndefined();
    expect(library.list().pending).toEqual({ [other.id]: { state: "waiting" } });
    expect(readdirSync(path.join(dir, "data", "library-pending"))).toEqual(["initech-concealed-hinge.json"]);
    // The id is free again, so the part can be proposed afresh.
    expect(library.propose(slide).part.id).toBe(part.id);
  });

  it("keeps the specs a design copied from the part, once the part is removed", async () => {
    const { part, github } = await shared();
    const store = new Store(path.join(dir, "data"));
    const project = store.create("Console", recordConsoleOps().filter((o) => o.op !== "rename_design"));
    project.change("you", "Fit the slides", [
      { op: "set_hardware", id: "slides", kind: "drawer_slide", name: part.name, connects: ["bottom"], library_part: part.id, spec: part.specs, shape: part.shape },
    ] as never);
    github.close(1);
    await library.syncPullRequests(github, REPO);
    library.remove(part.id);

    expect(store.partUses()[part.id]).toEqual([{ slug: project.slug, name: "Console" }]);
    const h = store.project.design.hardware.find((x) => x.id === "slides")!;
    expect(h).toMatchObject({ library_part: part.id, spec: { length_mm: 450, load_kg: 45 } });
    expect(h.shape).toEqual(part.shape);
  });

  it("only removes a part whose pull request is closed", async () => {
    const { part } = await shared();
    const waiting = approve(hinge);
    expect(() => library.remove(part.id)).toThrow(/can only be removed once its pull request is closed/);
    expect(() => library.remove(waiting.id)).toThrow(/can only be removed once its pull request is closed/);
    expect(() => library.remove("nope-nope")).toThrow(/no part nope-nope waiting/);
    // A file that arrived in library/parts is never touched.
    arrive(part);
    expect(() => library.remove(part.id)).toThrow(/no part acmeco-glide-450 waiting/);
    expect(existsSync(path.join(libraryDir, "acmeco-glide-450.json"))).toBe(true);
  });
});

describe("the gh commands the app runs", () => {
  /** A gh that answers from a script and records what it was asked. */
  const scripted = (answers: (string | Error)[]) => {
    const runs: { args: string[]; stdin?: string }[] = [];
    const run: GhRun = async (args, stdin) => {
      runs.push({ args, ...(stdin !== undefined ? { stdin } : {}) });
      const answer = answers.shift();
      if (answer instanceof Error) throw answer;
      return answer ?? "";
    };
    return { runs, run };
  };

  it("reads main, makes a blob, tree, commit and branch through the API, then opens the pull request and turns on auto-merge", async () => {
    const part = approve();
    const { runs, run } = scripted([
      "[]",
      JSON.stringify({ object: { sha: "c0ffee" } }),
      JSON.stringify({ tree: { sha: "7ree" } }),
      JSON.stringify({ sha: "b10b" }),
      JSON.stringify({ sha: "7r33" }),
      JSON.stringify({ sha: "c0mm17" }),
      "{}",
      `https://github.com/${REPO}/pull/12\n`,
      "",
    ]);
    const status = await openPartPullRequest(ghCli(run), REPO, part);
    expect(status).toEqual({ state: "open", url: `https://github.com/${REPO}/pull/12`, number: 12, auto_merge: true });

    const { title, body } = partPullRequestText(part);
    expect(runs.map((r) => r.args)).toEqual([
      ["pr", "list", "-R", REPO, "--head", "part/acmeco-glide-450", "--base", "main", "--state", "open", "--json", "number,url", "--limit", "1"],
      ["api", `repos/${REPO}/git/ref/heads/main`],
      ["api", `repos/${REPO}/git/commits/c0ffee`],
      ["api", `repos/${REPO}/git/blobs`, "--method", "POST", "--input", "-"],
      ["api", `repos/${REPO}/git/trees`, "--method", "POST", "--input", "-"],
      ["api", `repos/${REPO}/git/commits`, "--method", "POST", "--input", "-"],
      ["api", `repos/${REPO}/git/refs`, "--method", "POST", "--input", "-"],
      ["pr", "create", "-R", REPO, "--base", "main", "--head", "part/acmeco-glide-450", "--title", title, "--body", body],
      ["pr", "merge", "12", "-R", REPO, "--auto", "--squash"],
    ]);
    const sent = (i: number) => JSON.parse(runs[i]!.stdin!);
    expect(sent(3)).toEqual({ content: partFileContent(part), encoding: "utf-8" });
    expect(sent(4)).toEqual({ base_tree: "7ree", tree: [{ path: "library/parts/acmeco-glide-450.json", mode: "100644", type: "blob", sha: "b10b" }] });
    expect(sent(5)).toEqual({ message: title, tree: "7r33", parents: ["c0ffee"] });
    expect(sent(6)).toEqual({ ref: "refs/heads/part/acmeco-glide-450", sha: "c0mm17" });
  });

  it("moves the app's own part/ branch when an earlier try left it behind", async () => {
    const { runs, run } = scripted([new Error("Reference already exists"), "{}"]);
    await ghCli(run).setBranch(REPO, "part/acmeco-glide-450", "abc");
    expect(runs.map((r) => r.args)).toEqual([
      ["api", `repos/${REPO}/git/refs`, "--method", "POST", "--input", "-"],
      ["api", `repos/${REPO}/git/refs/heads/part/acmeco-glide-450`, "--method", "PATCH", "--input", "-"],
    ]);
    expect(JSON.parse(runs[1]!.stdin!)).toEqual({ sha: "abc", force: true });
  });

  it("doesn't move a branch for any other failure", async () => {
    const { runs, run } = scripted([new Error("Resource not accessible")]);
    await expect(ghCli(run).setBranch(REPO, "part/x", "abc")).rejects.toThrow(/not accessible/);
    expect(runs).toHaveLength(1);
  });

  it("reuses the open pull request for a part and only turns on auto-merge", async () => {
    const part = approve();
    const { runs, run } = scripted([JSON.stringify([{ number: 7, url: `https://github.com/${REPO}/pull/7` }]), ""]);
    expect(await openPartPullRequest(ghCli(run), REPO, part)).toEqual({ state: "open", url: `https://github.com/${REPO}/pull/7`, number: 7, auto_merge: true });
    expect(runs.map((r) => r.args[1])).toEqual(["list", "merge"]);
  });

  it("doesn't trust a pull request link that isn't on the repo", async () => {
    const part = approve();
    const { run } = scripted(["[]", JSON.stringify({ object: { sha: "a" } }), JSON.stringify({ tree: { sha: "b" } }), JSON.stringify({ sha: "c" }), JSON.stringify({ sha: "d" }), JSON.stringify({ sha: "e" }), "{}", "https://example.com/pull/1\n"]);
    const status = await openPartPullRequest(ghCli(run), REPO, part);
    expect(status).toEqual({ state: "waiting", error: "GitHub didn't return a pull request link" });
  });

  it("reads a pull request's state with gh pr view, and tells closed from merged", async () => {
    const read = async (answer: string | Error) => {
      const { runs, run } = scripted([answer]);
      const state = await ghCli(run).pullRequestState(REPO, 7);
      expect(runs.map((r) => r.args)).toEqual([["pr", "view", "7", "-R", REPO, "--json", "state,mergedAt"]]);
      return state;
    };
    expect(await read(JSON.stringify({ state: "OPEN", mergedAt: null }))).toBe("open");
    expect(await read(JSON.stringify({ state: "CLOSED", mergedAt: null }))).toBe("closed");
    expect(await read(JSON.stringify({ state: "MERGED", mergedAt: "2026-10-04T01:02:03Z" }))).toBe("merged");
    // A merge date settles it, whatever else the state says.
    expect(await read(JSON.stringify({ state: "CLOSED", mergedAt: "2026-10-04T01:02:03Z" }))).toBe("merged");
    await expect(read(JSON.stringify({ mergedAt: null }))).rejects.toThrow(/no state/);
    await expect(read("not json")).rejects.toThrow(/no state/);
    await expect(read(new Error("Could not resolve to a PullRequest"))).rejects.toThrow(/Could not resolve/);
  });

  it("only sends gh a plain pull request number", async () => {
    const { runs, run } = scripted([]);
    for (const bad of [0, -1, 1.5, Number.NaN, "--web" as unknown as number]) {
      await expect(ghCli(run).pullRequestState(REPO, bad)).rejects.toThrow(/isn't a pull request number/);
    }
    expect(runs).toEqual([]);
  });
});

describe("what the Library tab asks of the server", () => {
  const parts = ["slide", "hinge", "handle"].map((k) => validateLibraryPart({ slide, hinge, handle }[k as "slide"]));

  it("lists approved and pending parts together, and marks the pending ones", async () => {
    mkdirSync(libraryDir, { recursive: true });
    writeFileSync(path.join(libraryDir, "globex-bar-handle.json"), partFileContent({ ...parts[2]!, approved_at: "2026-10-01T00:00:00.000Z" }));
    approve(slide);
    const listed = library.list();
    expect(listed.parts.map((p) => p.id)).toEqual(["acmeco-glide-450", "globex-bar-handle"]);
    expect(Object.keys(listed.pending)).toEqual(["acmeco-glide-450"]);
    // A proposal that hasn't been approved isn't in the library.
    library.propose(hinge);
    expect(library.list().parts.map((p) => p.id)).toEqual(["acmeco-glide-450", "globex-bar-handle"]);
  });

  it("searches by name, kind and maker, in any case and order", () => {
    const ids = (q: string, kind = "") => searchParts(parts, q, kind).map((p) => p.id);
    expect(ids("")).toEqual(["acmeco-glide-450", "globex-bar-handle", "initech-concealed-hinge"]);
    expect(ids("GLIDE")).toEqual(["acmeco-glide-450"]);
    expect(ids("initech")).toEqual(["initech-concealed-hinge"]);
    expect(ids("drawer slide")).toEqual(["acmeco-glide-450"]);
    expect(ids("slide acmeco")).toEqual(["acmeco-glide-450"]);
    expect(ids("handle")).toEqual(["globex-bar-handle"]);
    expect(ids("acmeco globex")).toEqual([]);
    expect(ids("zzz")).toEqual([]);
    expect(ids("", "hinge")).toEqual(["initech-concealed-hinge"]);
    expect(ids("globex", "hinge")).toEqual([]);
    expect(() => searchParts(parts, "", "chair")).toThrow(/isn't one of/);
  });

  it("finds which designs use a part, from their hardware", () => {
    const store = new Store(path.join(dir, "data"));
    const use = (name: string, hardware: unknown[]) => {
      const p = store.create(name, recordConsoleOps().filter((o) => o.op !== "rename_design"));
      if (hardware.length) p.change("you", "Fit parts", hardware as never);
      return p.slug;
    };
    const fit = (id: string, part: string) => ({ op: "set_hardware", id, kind: "drawer_slide", name: "A slide", connects: ["bottom"], library_part: part });
    const console1 = use("Console", [fit("slides", "acmeco-glide-450"), fit("slides_two", "acmeco-glide-450"), fit("pulls", "globex-bar-handle")]);
    const bench = use("Bench", [fit("slides", "acmeco-glide-450")]);
    use("Shelf", []);
    // A design whose file can't be read is skipped.
    mkdirSync(path.join(store.projectsDir, "broken"), { recursive: true });

    const uses = store.partUses();
    expect(uses["acmeco-glide-450"]).toEqual([
      { slug: bench, name: "Bench" },
      { slug: console1, name: "Console" },
    ]);
    expect(uses["globex-bar-handle"]).toEqual([{ slug: console1, name: "Console" }]);
    expect(uses["initech-concealed-hinge"]).toBeUndefined();
    expect(Object.keys(uses).sort()).toEqual(["acmeco-glide-450", "globex-bar-handle"]);
  });
});
