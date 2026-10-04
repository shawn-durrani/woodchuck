// The AI blend's route, with a stand-in for OpenAI so no test sends a picture anywhere.

import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/index.js";
import { BlendError, openAiBlend, type BlendRequest } from "../src/blend.js";

const sent: BlendRequest[] = [];
/** What the stand-in does next: blend, or fail the way OpenAI can. */
let next: (() => never) | null = null;
let dir: string;
let base: string;
let close: () => Promise<void>;
beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "woodchuck-blend-"));
  const app = createApp({
    dataDir: dir,
    watchTools: false,
    blend: async (req) => {
      sent.push(req);
      if (next) next();
      return Buffer.from("blended");
    },
  });
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  close = app.close;
});
afterEach(() => {
  next = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
afterAll(async () => {
  await close();
  rmSync(dir, { recursive: true, force: true });
});

const post = (body: unknown) => fetch(`${base}/api/blend`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("the AI blend route", () => {
  it("passes the picture and mask on, and keeps the result with the renders", async () => {
    const r = await post({ image: Buffer.from("img").toString("base64"), mask: Buffer.from("msk").toString("base64"), size: "1536x1024" });
    const j = (await r.json()) as { url: string };
    expect(r.status).toBe(200);
    expect(sent[0]).toMatchObject({ size: "1536x1024" });
    expect(sent[0]!.image.toString()).toBe("img");
    expect(sent[0]!.mask.toString()).toBe("msk");
    expect(await (await fetch(`${base}${j.url}`)).text()).toBe("blended");
  });

  it("refuses sizes the image model doesn't make", async () => {
    expect((await post({ image: "", mask: "", size: "1600x1200" })).status).toBe(400);
  });

  it("keeps OpenAI's own words out of the browser, since they can quote part of a key", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    next = () => {
      throw new Error("Incorrect API key provided: sk-proj-****wxyz");
    };
    const r = await post({ image: "", mask: "", size: "1024x1024" });
    expect(r.status).toBe(502);
    const { error } = (await r.json()) as { error: string };
    expect(error).toBe("The AI blend didn't work. The log on the computer running Woodchuck says why.");
    expect(error).not.toMatch(/sk-|wxyz/);
    expect(logged.mock.calls.flat().join(" ")).toContain("wxyz");

    // A failure already in plain words passes through as it is.
    next = () => {
      throw new BlendError("OpenAI is busy, or the account is out of credit. Try again later.");
    };
    const busy = await post({ image: "", mask: "", size: "1024x1024" });
    expect(((await busy.json()) as { error: string }).error).toBe("OpenAI is busy, or the account is out of credit. Try again later.");
  });
});

describe("OpenAI's image edit, failing", () => {
  const answer = (status: number, message: string) =>
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: { message } }), { status, headers: { "content-type": "application/json" } }));
  const run = () => openAiBlend("sk-test-not-a-key")({ image: Buffer.from("i"), mask: Buffer.from("m"), size: "1024x1024" });

  it("logs what OpenAI said, and throws plain words that never quote it", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    answer(401, "Incorrect API key provided: sk-proj-****wxyz. You can find your API key at https://platform.openai.com/account/api-keys.");
    const e = await run().catch((x: unknown) => x);
    expect(e).toBeInstanceOf(BlendError);
    expect((e as Error).message).toBe("OpenAI didn't accept the API key. Check OPENAI_API_KEY in the .env file, then restart Woodchuck.");
    expect((e as Error).message).not.toMatch(/sk-|wxyz/);
    expect(logged.mock.calls.flat().join(" ")).toMatch(/401: Incorrect API key provided: sk-proj-\*\*\*\*wxyz/);
  });

  it("says what a busy or refused answer means", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    answer(429, "Rate limit reached for sk-proj-****wxyz");
    expect(((await run().catch((x: unknown) => x)) as Error).message).toBe("OpenAI is busy, or the account is out of credit. Try again later.");
    answer(500, "Something broke near sk-proj-****wxyz");
    expect(((await run().catch((x: unknown) => x)) as Error).message).toBe(
      "OpenAI couldn't make the blend (it answered 500). The log on the computer running Woodchuck says why.",
    );
  });
});
