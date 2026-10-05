// Snapshots of the data folder, taken the same way the owner's other apps
// take theirs. One at every start, before anything touches the data, then
// whenever the newest is an interval old by the wall clock. The timer wakes
// every five minutes to ask, so time asleep counts and a snapshot that fell
// due during sleep lands within minutes of waking.
//
// A snapshot is one .tar.gz of the whole data folder, in data/backups, named
// with a sortable UTC time and a fingerprint of what's inside. The folder is
// read in one synchronous pass. Every write in the server is synchronous too,
// so the pass never sees a save half done. Compressing and writing happen
// after, under a temporary name that's renamed once complete, so a
// half-written snapshot never counts.
//
// Left out: the backups folder itself, the mirror folder if it sits inside,
// the service log, which can hold the recovery secret, temporary files a
// crash left behind, and the sign-in sessions in lock.json. Restoring a
// snapshot signs every browser out, as Crossband's does, so a session
// revoked after the snapshot never comes back. The password and passkeys
// stay.
//
// A snapshot identical to the newest one is dropped and the newest stands,
// so a crash loop that restarts the app every few seconds never pushes the
// real history out. An optional mirror folder, such as one in iCloud Drive,
// gets a copy of each completed snapshot, never the live files, with its
// own keep count. Everything is private to your account: folders 0700 and
// files 0600, in the mirror too. A failure is logged and never stops the app.

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { chmod, copyFile, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { gzip } from "node:zlib";

export interface BackupSettings {
  /** Hours between snapshots, by the wall clock. 0 turns the timer off; the startup snapshot still runs. */
  intervalHours: number;
  /** Snapshots kept in data/backups. */
  keep: number;
  /** A second folder that gets a copy of each completed snapshot, or null for none. */
  mirrorDir: string | null;
  /** Snapshots kept in the mirror folder. */
  mirrorKeep: number;
}

export const BACKUP_DEFAULTS: BackupSettings = { intervalHours: 6, keep: 14, mirrorDir: null, mirrorKeep: 7 };

/** How often the timer wakes to ask whether a snapshot is due. */
export const BACKUP_TICK_MS = 5 * 60_000;

export const BACKUPS_FOLDER = "backups";

const SNAPSHOT = /^woodchuck-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-([0-9a-f]{12})\.tar\.gz$/;
const PART = /^\.woodchuck-.*\.part$/;

/** The settings' environment names, for warnings about a value that can't be read. */
const NAMES = {
  intervalHours: "WOODCHUCK_BACKUP_INTERVAL_HOURS",
  keep: "WOODCHUCK_BACKUP_KEEP",
  mirrorKeep: "WOODCHUCK_BACKUP_MIRROR_KEEP",
} as const;

/**
 * The settings from their raw environment values. A value that isn't a
 * number, or is below its floor, falls back to the default with a warning.
 * A relative mirror folder is taken from the app's folder, like the data folder.
 */
export function readBackupSettings(
  raw: { intervalHours?: string; keep?: string; mirrorDir?: string; mirrorKeep?: string },
  root: string,
  warn: (line: string) => void = console.warn,
): BackupSettings {
  const num = (key: keyof typeof NAMES, min: number, whole: boolean): number => {
    const fallback = BACKUP_DEFAULTS[key];
    const text = raw[key]?.trim();
    if (!text) return fallback;
    const n = Number(text);
    if (!Number.isFinite(n) || n < min || (whole && !Number.isInteger(n))) {
      warn(`${NAMES[key]} should be ${whole ? "a whole number" : "a number"} of at least ${min}, so it's ${fallback}.`);
      return fallback;
    }
    return n;
  };
  const mirror = raw.mirrorDir?.trim();
  return {
    intervalHours: num("intervalHours", 0, false),
    keep: num("keep", 1, true),
    mirrorDir: mirror ? path.resolve(root, mirror) : null,
    mirrorKeep: num("mirrorKeep", 1, true),
  };
}

/** One file or folder in a snapshot, by its path inside the data folder. */
export interface Entry {
  name: string;
  dir: boolean;
  data: Buffer;
  mtimeS: number;
}

const EMPTY = Buffer.alloc(0);

/** lock.json with no sign-in sessions, or null when it can't be read. */
function withoutSessions(raw: Buffer): Buffer | null {
  try {
    const lock = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
    if (typeof lock !== "object" || lock === null || Array.isArray(lock)) return null;
    return Buffer.from(JSON.stringify({ ...lock, sessions: [] }, null, 2));
  } catch {
    return null;
  }
}

/**
 * Everything a snapshot holds, read in one synchronous pass. Folders in
 * `skip` are left out with all they hold, and so are temporary files, the
 * service log and symlinks. A file that vanishes partway is left out too.
 */
export function capture(dataDir: string, skip: string[], warn: (line: string) => void = console.warn): Entry[] {
  const out: Entry[] = [];
  const skipped = new Set(skip.map((p) => path.resolve(p)));
  const walk = (abs: string, rel: string) => {
    for (const name of readdirSync(abs).sort()) {
      const full = path.join(abs, name);
      const inside = rel ? `${rel}/${name}` : name;
      if (skipped.has(full)) continue;
      // Half-written files a crash left behind: the store's and lock's .tmp, a snapshot's .part, git's .lock.
      if (/\.(tmp|part|lock)$/.test(name)) continue;
      if (!rel && name === "service.log") continue;
      let st;
      try {
        st = lstatSync(full);
      } catch {
        continue;
      }
      const mtimeS = Math.floor(st.mtimeMs / 1000);
      if (st.isDirectory()) {
        out.push({ name: `${inside}/`, dir: true, data: EMPTY, mtimeS });
        walk(full, inside);
      } else if (st.isFile()) {
        let data: Buffer;
        try {
          data = readFileSync(full);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw e;
        }
        if (inside === "lock.json") {
          const clean = withoutSessions(data);
          if (!clean) {
            warn("Couldn't read lock.json, so this backup leaves the owner lock out.");
            continue;
          }
          data = clean;
        }
        out.push({ name: inside, dir: false, data, mtimeS });
      }
    }
  };
  walk(dataDir, "");
  return out;
}

/** A fingerprint of what's in a snapshot: names and contents, never times. */
export function fingerprint(entries: Entry[]): string {
  const h = createHash("sha256");
  for (const e of entries) {
    h.update(`${e.dir ? "d" : "f"}\0${e.name}\0${e.data.length}\0`);
    h.update(e.data);
  }
  return h.digest("hex").slice(0, 12);
}

// ---- a small tar writer ----
//
// The POSIX ustar format, which every tar reads, with a pax header for a
// path too long or not plain ASCII. Owners are left blank, so an unpacked
// file belongs to whoever unpacks it. Every folder is 0700 and every file
// 0600, so a restored data folder is private whatever the snapshot came from.

function octal(n: number, width: number): string {
  return `${n.toString(8).padStart(width - 1, "0")}\0`;
}

function header(name: string, size: number, mtimeS: number, type: "0" | "5" | "x", prefix = ""): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, "utf8");
  h.write(octal(type === "5" ? 0o700 : 0o600, 8), 100, "ascii");
  h.write(octal(0, 8), 108, "ascii");
  h.write(octal(0, 8), 116, "ascii");
  h.write(octal(size, 12), 124, "ascii");
  h.write(octal(mtimeS, 12), 136, "ascii");
  h.write("        ", 148, "ascii");
  h.write(type, 156, "ascii");
  h.write("ustar\0", 257, "ascii");
  h.write("00", 263, "ascii");
  h.write(prefix, 345, 155, "utf8");
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
  return h;
}

const pad = (size: number) => Buffer.alloc((512 - (size % 512)) % 512);

/** Splits a path into ustar's prefix and name, or null when it doesn't fit. */
function ustarName(name: string): { name: string; prefix: string } | null {
  if (!/^[\x20-\x7e]*$/.test(name)) return null;
  if (name.length <= 100) return { name, prefix: "" };
  const trimmed = name.endsWith("/") ? name.slice(0, -1) : name;
  for (let i = trimmed.lastIndexOf("/"); i > 0; i = trimmed.lastIndexOf("/", i - 1)) {
    const rest = name.slice(i + 1);
    if (i <= 155 && rest.length <= 100) return { prefix: name.slice(0, i), name: rest };
  }
  return null;
}

/** One pax record, whose length counts its own digits. */
function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  const n = Buffer.byteLength(body);
  let len = n + String(n).length;
  if (String(len).length !== String(n).length) len = n + String(len).length;
  return `${len}${body}`;
}

export function tar(entries: Entry[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    const fits = ustarName(e.name);
    if (!fits) {
      const pax = Buffer.from(paxRecord("path", e.name), "utf8");
      parts.push(header("PaxHeader", pax.length, e.mtimeS, "x"), pax, pad(pax.length));
    }
    // A reader without pax support falls back to a shortened plain name.
    const short = fits ?? { name: e.name.replace(/[^\x20-\x7e]/g, "_").slice(-99), prefix: "" };
    parts.push(header(short.name, e.data.length, e.mtimeS, e.dir ? "5" : "0", short.prefix));
    if (e.data.length) parts.push(e.data, pad(e.data.length));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

// ---- snapshots ----

const two = (n: number) => String(n).padStart(2, "0");

/** A time as the sortable UTC stamp in a snapshot's name, such as 20261005-031500. */
export function stamp(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${two(d.getUTCMonth() + 1)}${two(d.getUTCDate())}-${two(d.getUTCHours())}${two(d.getUTCMinutes())}${two(d.getUTCSeconds())}`;
}

/** When a snapshot was taken, from its name, or null for any other file. */
export function takenAt(name: string): number | null {
  const m = SNAPSHOT.exec(name);
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
}

/** The snapshots in a folder, oldest first. */
export function snapshotsIn(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((n) => SNAPSHOT.test(n))
      .sort();
  } catch {
    return [];
  }
}

async function prune(dir: string, keep: number) {
  const all = snapshotsIn(dir);
  for (const old of all.slice(0, Math.max(0, all.length - keep))) await rm(path.join(dir, old), { force: true });
}

/** Clears the temporary files of a snapshot that a crash cut off. */
async function clearParts(dir: string) {
  for (const n of await readdir(dir)) if (PART.test(n)) await rm(path.join(dir, n), { force: true });
}

/** Makes a folder if it's missing, and keeps it private to your account. */
async function privateDir(dir: string) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
}

const gzipAsync = promisify(gzip);

export class Backups {
  readonly dir: string;
  private inFlight: Promise<string | null> | null = null;
  /** When the timer last tried, so a snapshot dropped as unchanged isn't tried again every tick. */
  private lastTry: number | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly clock: () => number;
  private readonly log: (line: string) => void;
  private readonly error: (line: string) => void;

  constructor(
    readonly dataDir: string,
    readonly settings: BackupSettings = BACKUP_DEFAULTS,
    opts: { clock?: () => number; log?: (line: string) => void; error?: (line: string) => void } = {},
  ) {
    this.dir = path.join(dataDir, BACKUPS_FOLDER);
    this.clock = opts.clock ?? Date.now;
    this.log = opts.log ?? console.log;
    this.error = opts.error ?? console.error;
  }

  /** True while a snapshot is being written, so a restart can wait for it. */
  get busy(): boolean {
    return this.inFlight !== null;
  }

  /** The snapshots kept in data/backups, oldest first. */
  list(): string[] {
    return snapshotsIn(this.dir);
  }

  /** When the newest snapshot was taken, as an ISO time, or null with none. */
  lastAt(): string | null {
    const newest = this.list().at(-1);
    const t = newest ? takenAt(newest) : null;
    return t === null ? null : new Date(t).toISOString();
  }

  /**
   * Takes a snapshot now. The data folder is read before this returns, and
   * the snapshot is written after. Resolves to the snapshot's file name,
   * the newest one's when nothing changed, or null when there was nothing to
   * back up or it failed. It never rejects.
   */
  snapshot(): Promise<string | null> {
    if (this.inFlight) return this.inFlight;
    const now = this.clock();
    let entries: Entry[];
    try {
      if (!existsSync(this.dataDir)) return Promise.resolve(null);
      entries = capture(this.dataDir, [this.dir, ...(this.settings.mirrorDir ? [this.settings.mirrorDir] : [])], this.error);
    } catch (e) {
      this.error(`Backup failed, and Woodchuck carries on: ${(e as Error).message}`);
      return Promise.resolve(null);
    }
    if (!entries.some((e) => !e.dir)) return Promise.resolve(null);
    const job = this.write(entries, now).finally(() => {
      this.inFlight = null;
    });
    this.inFlight = job;
    return job;
  }

  private async write(entries: Entry[], now: number): Promise<string | null> {
    let name: string;
    try {
      const print = fingerprint(entries);
      await privateDir(this.dir);
      await clearParts(this.dir);
      const newest = this.list().at(-1);
      if (newest && SNAPSHOT.exec(newest)?.[7] === print) {
        name = newest;
      } else {
        name = `woodchuck-${stamp(now)}-${print}.tar.gz`;
        const part = path.join(this.dir, `.${name}.part`);
        await writeFile(part, await gzipAsync(tar(entries)), { mode: 0o600 });
        await chmod(part, 0o600);
        await rename(part, path.join(this.dir, name));
        await prune(this.dir, this.settings.keep);
        this.log(`Backed up the data folder to ${BACKUPS_FOLDER}/${name}`);
      }
    } catch (e) {
      this.error(`Backup failed, and Woodchuck carries on: ${(e as Error).message}`);
      return null;
    }
    await this.mirror(name);
    return name;
  }

  /** Copies a completed snapshot to the mirror folder, if it isn't there yet. */
  private async mirror(name: string) {
    const to = this.settings.mirrorDir;
    if (!to) return;
    try {
      await privateDir(to);
      await clearParts(to);
      const target = path.join(to, name);
      if (!existsSync(target)) {
        const part = path.join(to, `.${name}.part`);
        await copyFile(path.join(this.dir, name), part);
        await chmod(part, 0o600);
        await rename(part, target);
      }
      await prune(to, this.settings.mirrorKeep);
    } catch (e) {
      this.error(`Couldn't copy the backup to the mirror folder, and the one in ${BACKUPS_FOLDER} stands: ${(e as Error).message}`);
    }
  }

  /**
   * True when the newest snapshot, and the timer's last try, are both an
   * interval old by the wall clock. A time ahead of now means the clock was
   * set back, and it's ignored so backups never stall until it catches up.
   */
  due(now: number): boolean {
    const newest = this.list().at(-1);
    const marks = [newest ? takenAt(newest) : null, this.lastTry].filter((t): t is number => t !== null && t <= now);
    return !marks.length || now - Math.max(...marks) >= this.settings.intervalHours * 3_600_000;
  }

  /** One wake of the timer: a snapshot, if one is due. */
  async tick(): Promise<void> {
    if (this.inFlight || this.settings.intervalHours <= 0) return;
    const now = this.clock();
    if (!this.due(now)) return;
    this.lastTry = now;
    await this.snapshot();
  }

  /**
   * Starts the timer. The startup snapshot counts as the first try, so the
   * next is an interval out. An interval of 0 starts no timer.
   */
  start() {
    this.lastTry = this.clock();
    const intervalMs = this.settings.intervalHours * 3_600_000;
    if (intervalMs <= 0 || this.timer) return;
    this.timer = setInterval(() => void this.tick(), Math.min(BACKUP_TICK_MS, intervalMs));
    this.timer.unref();
  }

  /** Whether the timer is running. */
  get timerOn(): boolean {
    return this.timer !== null;
  }

  /** Stops the timer, and waits for a snapshot being written. */
  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.inFlight;
  }
}
