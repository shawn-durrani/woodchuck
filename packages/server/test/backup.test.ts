// Backups of the data folder (#16): a snapshot at every start, then on a
// timer by the wall clock, kept and pruned locally and in a mirror folder,
// private to your account, and never a reason for the app to stop. Every
// design here is invented, and the clock is passed in.

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyDesign, recordConsoleOps } from "@woodchuck/core";
import { BACKUP_DEFAULTS, BACKUP_TICK_MS, Backups, readBackupSettings, stamp, type BackupSettings } from "../src/backup.js";
import { createApp } from "../src/index.js";
import { scriptedClient } from "../src/scripted.js";
import { Store } from "../src/store.js";

let root: string;
let data: string;
let now: number;
let logged: string[];
let errors: string[];

const T0 = Date.UTC(2026, 9, 5, 9, 0, 0);
const HOUR = 3_600_000;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "woodchuck-backup-"));
  data = path.join(root, "data");
  now = T0;
  logged = [];
  errors = [];
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(root, { recursive: true, force: true });
});

const backupsOf = (settings: Partial<BackupSettings> = {}) =>
  new Backups(data, { ...BACKUP_DEFAULTS, ...settings }, { clock: () => now, log: (l) => logged.push(l), error: (l) => errors.push(l) });

/** A data folder with a design or two in it, made through the store. */
function seed() {
  const store = new Store(data);
  const p = store.create("Sam's bookshelf");
  p.change("you", "Name it", [{ op: "rename_design", name: "Sam's bookshelf" }]);
  return store;
}

/** A change to the data, so the next snapshot isn't the same as the last. */
let edits = 0;
function touch() {
  writeFileSync(path.join(data, "tool-requests.json"), JSON.stringify([{ id: `tr_${++edits}` }]), { mode: 0o600 });
}

const listing = (snapshot: string) => execFileSync("tar", ["-tzf", snapshot], { encoding: "utf8" }).split("\n").filter(Boolean);
const mode = (p: string) => statSync(p).mode & 0o777;

describe("a snapshot", () => {
  it("is one private .tar.gz in data/backups, named by the time it was taken", async () => {
    seed();
    const name = await backupsOf().snapshot();
    expect(name).toMatch(new RegExp(`^woodchuck-${stamp(T0)}-[0-9a-f]{12}\\.tar\\.gz$`));
    expect(stamp(T0)).toBe("20261005-090000");
    const dir = path.join(data, "backups");
    expect(readdirSync(dir)).toEqual([name]);
    expect(mode(dir)).toBe(0o700);
    expect(mode(path.join(dir, name!))).toBe(0o600);
    // Inside, every folder is 0700 and every file 0600, whatever the source was.
    const long = execFileSync("tar", ["-tvzf", path.join(dir, name!)], { encoding: "utf8" }).split("\n").filter(Boolean);
    expect(long.length).toBeGreaterThan(3);
    for (const line of long) expect(line).toMatch(/^(drwx------|-rw-------) /);
    expect(logged).toEqual([`Backed up the data folder to backups/${name}`]);
  });

  it("holds what a restore needs and leaves out the backups, the log, sign-ins and half-written files", async () => {
    const slug = seed().project.slug;
    writeFileSync(path.join(data, "service.log"), "a log line\n");
    writeFileSync(path.join(data, "projects", slug, "design.json.tmp"), "{");
    writeFileSync(
      path.join(data, "lock.json"),
      JSON.stringify({ password: { alg: "scrypt", salt: "00", hash: "11" }, passkeys: [], sessions: [{ hash: "ab", expires_at: T0 + HOUR }] }),
    );
    mkdirSync(path.join(data, "backups"), { recursive: true });
    writeFileSync(path.join(data, "backups", "notes.txt"), "kept apart");
    const b = backupsOf();
    const name = (await b.snapshot())!;
    const names = listing(path.join(b.dir, name));
    expect(names).toEqual(expect.arrayContaining(["projects/", `projects/${slug}/design.json`, `projects/${slug}/chat.json`, "projects/.git/", "current.json", "lock.json"]));
    expect(names.filter((n) => n.startsWith("backups") || n === "service.log" || n.endsWith(".tmp"))).toEqual([]);
    const out = path.join(root, "out");
    mkdirSync(out);
    execFileSync("tar", ["-xzf", path.join(b.dir, name), "-C", out]);
    const lock = JSON.parse(readFileSync(path.join(out, "lock.json"), "utf8"));
    expect(lock.sessions).toEqual([]);
    expect(lock.password.hash).toBe("11");
  });

  it("keeps paths too long or too unusual for plain tar", async () => {
    mkdirSync(data, { recursive: true });
    const deep = path.join("library-pending", "a".repeat(60), "b".repeat(60));
    mkdirSync(path.join(data, deep), { recursive: true });
    writeFileSync(path.join(data, deep, `${"c".repeat(120)}.json`), "{}");
    writeFileSync(path.join(data, "Mateo's café.json"), "{}");
    const b = backupsOf();
    const name = (await b.snapshot())!;
    const out = path.join(root, "out");
    mkdirSync(out);
    execFileSync("tar", ["-xzf", path.join(b.dir, name), "-C", out]);
    expect(readFileSync(path.join(out, deep, `${"c".repeat(120)}.json`), "utf8")).toBe("{}");
    expect(readFileSync(path.join(out, "Mateo's café.json"), "utf8")).toBe("{}");
  });

  it("isn't kept twice when nothing changed, so a crash loop never pushes out the history", async () => {
    seed();
    const first = await backupsOf({ keep: 3 }).snapshot();
    for (let i = 1; i <= 10; i++) {
      now = T0 + i * 10_000;
      expect(await backupsOf({ keep: 3 }).snapshot()).toBe(first);
    }
    expect(readdirSync(path.join(data, "backups"))).toEqual([first]);
  });

  it("is skipped while the data folder is missing or empty", async () => {
    expect(await backupsOf().snapshot()).toBeNull();
    mkdirSync(data);
    expect(await backupsOf().snapshot()).toBeNull();
    expect(existsSync(path.join(data, "backups"))).toBe(false);
  });
});

describe("keeping and pruning", () => {
  it("keeps the newest snapshots in each place, each with its own count", async () => {
    seed();
    const mirror = path.join(root, "mirror");
    const b = backupsOf({ keep: 4, mirrorDir: mirror, mirrorKeep: 2 });
    const names: string[] = [];
    for (let i = 0; i < 6; i++) {
      now = T0 + i * 6 * HOUR;
      touch();
      names.push((await b.snapshot())!);
    }
    expect(new Set(names).size).toBe(6);
    expect(readdirSync(b.dir).sort()).toEqual(names.slice(-4));
    expect(readdirSync(mirror).sort()).toEqual(names.slice(-2));
  });

  it("mirrors completed snapshots only, never a live file, and keeps the mirror private", async () => {
    seed();
    const mirror = path.join(root, "mirror");
    mkdirSync(mirror, { mode: 0o755 });
    chmodSync(mirror, 0o755);
    const b = backupsOf({ mirrorDir: mirror });
    const name = (await b.snapshot())!;
    expect(readdirSync(mirror)).toEqual([name]);
    expect(readFileSync(path.join(mirror, name))).toEqual(readFileSync(path.join(b.dir, name)));
    expect(mode(mirror)).toBe(0o700);
    expect(mode(path.join(mirror, name))).toBe(0o600);
  });

  it("carries on with local backups when the mirror fails, and catches the mirror up later", async () => {
    seed();
    const blocker = path.join(root, "not-a-folder");
    writeFileSync(blocker, "");
    const b = backupsOf({ mirrorDir: path.join(blocker, "mirror") });
    const name = await b.snapshot();
    expect(name).not.toBeNull();
    expect(b.list()).toEqual([name]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^Couldn't copy the backup to the mirror folder, and the one in backups stands: /);
    // Once the mirror works again, the newest snapshot reaches it even with nothing new to take.
    const mirror = path.join(root, "mirror");
    expect(await backupsOf({ mirrorDir: mirror }).snapshot()).toBe(name);
    expect(readdirSync(mirror)).toEqual([name]);
  });

  it("logs a failed backup plainly and never throws", async () => {
    seed();
    writeFileSync(path.join(data, "backups"), "a file where the folder goes");
    await expect(backupsOf().snapshot()).resolves.toBeNull();
    expect(errors[0]).toMatch(/^Backup failed, and Woodchuck carries on: /);
  });
});

describe("the timer", () => {
  it("goes by the wall clock, so a snapshot that fell due during sleep lands within a tick of waking", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    seed();
    const b = backupsOf();
    await b.snapshot();
    b.start();
    expect(b.timerOn).toBe(true);
    touch();
    // Five hours of ticks with the clock keeping up: nothing is due yet.
    for (let i = 0; i < 60; i++) {
      now += BACKUP_TICK_MS;
      await vi.advanceTimersByTimeAsync(BACKUP_TICK_MS);
    }
    expect(b.list()).toHaveLength(1);
    // The computer sleeps for nine hours. The wall clock moves, the timer doesn't.
    now += 9 * HOUR;
    now += BACKUP_TICK_MS;
    await vi.advanceTimersByTimeAsync(BACKUP_TICK_MS);
    await b.stop();
    expect(b.list()).toHaveLength(2);
    expect(b.list()[1]).toContain(stamp(now));
  });

  it("takes one at each interval, and doesn't try again every tick when nothing changed", async () => {
    seed();
    const b = backupsOf({ intervalHours: 6 });
    await b.snapshot();
    b.start();
    now = T0 + 6 * HOUR;
    expect(b.due(now)).toBe(true);
    await b.tick();
    expect(b.list()).toHaveLength(1);
    now += BACKUP_TICK_MS;
    expect(b.due(now)).toBe(false);
    touch();
    now = T0 + 12 * HOUR;
    await b.tick();
    expect(b.list()).toHaveLength(2);
  });

  it("ignores a newest snapshot from the future, when the clock was set back", async () => {
    seed();
    now = T0 + 48 * HOUR;
    await backupsOf().snapshot();
    now = T0;
    const b = backupsOf();
    expect(b.due(now)).toBe(true);
  });

  it("is off at an interval of 0, and the startup snapshot still runs", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    seed();
    const b = backupsOf({ intervalHours: 0 });
    await b.snapshot();
    b.start();
    expect(b.timerOn).toBe(false);
    touch();
    now += 30 * HOUR;
    await vi.advanceTimersByTimeAsync(30 * HOUR);
    await b.tick();
    expect(b.list()).toHaveLength(1);
  });
});

describe("restoring", () => {
  it("unpacks into an empty data folder and opens every design as it was", async () => {
    const store = seed();
    const p = store.create("Dave's console", recordConsoleOps().filter((o) => o.op !== "rename_design"));
    p.change("you", "Four drawers", [{ op: "set_param", name: "drawers", expr: "4", unit: "count" }]);
    p.addChat({ id: "u1", kind: "user", text: "Make it walnut", selection: [], at: new Date(T0).toISOString() });
    p.save();
    const ref = p.saveReference(Buffer.from("not really a photo"), "jpg");
    store.setWorkshop({ country: "NZ" });
    const name = (await backupsOf().snapshot())!;

    const restored = path.join(root, "restored");
    mkdirSync(restored, { mode: 0o700 });
    execFileSync("tar", ["-xzf", path.join(data, "backups", name), "-C", restored]);
    const again = new Store(restored);
    expect(again.list().map((d) => d.name)).toEqual(store.list().map((d) => d.name));
    const back = again.open(p.slug);
    expect(back.design).toEqual(p.design);
    expect(back.chat).toEqual(p.chat);
    expect(back.history.map((e) => e.label)).toEqual(p.history.map((e) => e.label));
    expect(back.referencePath(ref)).not.toBeNull();
    expect(again.workshop().country).toBe("NZ");
    expect(again.versions.log(p.slug).map((v) => v.message)).toEqual(store.versions.log(p.slug).map((v) => v.message));
    expect(mode(path.join(restored, "projects", p.slug, "design.json"))).toBe(0o600);
  });
});

describe("in the app", () => {
  it("snapshots at startup before the store touches the data, and reports it on the health route", async () => {
    // A design folder made by hand, with no version history yet. The store adds one as it starts.
    const slug = path.join(data, "projects", "globex-hall-table");
    mkdirSync(slug, { recursive: true });
    writeFileSync(path.join(slug, "design.json"), JSON.stringify(emptyDesign("Globex hall table")));
    const app = createApp({ dataDir: data, repo: null, client: scriptedClient([]) });
    expect(app.backups.busy).toBe(true);
    const name = (await app.backups.snapshot())!;
    expect(existsSync(path.join(data, "projects", ".git"))).toBe(true);
    expect(listing(path.join(data, "backups", name)).some((n) => n.includes(".git"))).toBe(false);
    await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    const health = (await (await fetch(`${base}/api/health`)).json()) as { last_backup_at: string; backups_kept: number };
    expect(health.backups_kept).toBe(1);
    expect(Date.parse(health.last_backup_at)).toBeGreaterThan(Date.now() - 60_000);
    expect(await (await fetch(`${base}/api/busy`)).json()).toEqual({ busy: false, reasons: [] });
    await app.close();
  });

  it("starts and serves when the backup can't be written", async () => {
    mkdirSync(data, { recursive: true });
    writeFileSync(path.join(data, "workshop.json"), "{}");
    writeFileSync(path.join(data, "backups"), "a file where the folder goes");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const app = createApp({ dataDir: data, repo: null, client: scriptedClient([]) });
    expect(await app.backups.snapshot()).toBeNull();
    await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    expect((await fetch(`${base}/api/health`)).status).toBe(200);
    expect(spy.mock.calls.some(([line]) => String(line).startsWith("Backup failed"))).toBe(true);
    spy.mockRestore();
    await app.close();
  });
});

describe("the settings", () => {
  it("default to every six hours, fourteen kept and no mirror", () => {
    expect(readBackupSettings({}, root)).toEqual({ intervalHours: 6, keep: 14, mirrorDir: null, mirrorKeep: 7 });
  });

  it("read the environment, with a relative mirror taken from the app's folder", () => {
    expect(readBackupSettings({ intervalHours: "0", keep: "30", mirrorDir: "../copies", mirrorKeep: "3" }, path.join(root, "app"))).toEqual({
      intervalHours: 0,
      keep: 30,
      mirrorDir: path.join(root, "copies"),
      mirrorKeep: 3,
    });
  });

  it("fall back to the default, with a warning, on a value that isn't one", () => {
    const warned: string[] = [];
    const s = readBackupSettings({ intervalHours: "soon", keep: "0", mirrorKeep: "2.5" }, root, (l) => warned.push(l));
    expect(s).toEqual(BACKUP_DEFAULTS);
    expect(warned).toEqual([
      "WOODCHUCK_BACKUP_INTERVAL_HOURS should be a number of at least 0, so it's 6.",
      "WOODCHUCK_BACKUP_KEEP should be a whole number of at least 1, so it's 14.",
      "WOODCHUCK_BACKUP_MIRROR_KEEP should be a whole number of at least 1, so it's 7.",
    ]);
  });
});
