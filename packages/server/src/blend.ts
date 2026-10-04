// The AI blend: OpenAI's image edit API relights the piece placed in a
// room photo so it matches the room. The page sends the placed picture and
// a mask that leaves only the piece and its shadow open to editing, so the
// room stays as photographed. Nothing here touches the design.

export const BLEND_SIZES = ["1024x1024", "1536x1024", "1024x1536"] as const;
export type BlendSize = (typeof BLEND_SIZES)[number];

export interface BlendRequest {
  /** The photo with the model drawn in, as PNG, already at `size`. */
  image: Buffer;
  /** Same size; fully transparent where the model may change things. */
  mask: Buffer;
  size: BlendSize;
}

export type Blend = (req: BlendRequest) => Promise<Buffer>;

export const BLEND_PROMPT = [
  "This photo of a room has a piece of wooden furniture placed into it digitally.",
  "Make the furniture look as if it was photographed in this room:",
  "match the room's light direction, colour temperature, exposure and softness,",
  "give it natural contact shadows and soft shadows on the floor and wall,",
  "and match the photo's grain and sharpness.",
  "Keep the furniture exactly as it is: the same shape, size, proportions, position, parts, joints, timber grain and finish colours.",
  "Do not add, remove or move anything, and leave everything outside the furniture and its shadow unchanged.",
].join(" ");

/** A blend that failed, in words that are safe to show in the browser. */
export class BlendError extends Error {}

/** What a failed answer from OpenAI means, in plain words. */
export function blendFailure(status: number): string {
  if (status === 401 || status === 403) return "OpenAI didn't accept the API key. Check OPENAI_API_KEY in the .env file, then restart Woodchuck.";
  if (status === 429) return "OpenAI is busy, or the account is out of credit. Try again later.";
  if (status === 400) return "OpenAI couldn't use that picture. Try again, or try another photo.";
  return `OpenAI couldn't make the blend (it answered ${status}). The log on the computer running Woodchuck says why.`;
}

/** The model to use: WOODCHUCK_IMAGE_MODEL, or OpenAI's precise GPT Image. */
export function blendModel(): string {
  return process.env.WOODCHUCK_IMAGE_MODEL || "gpt-image-2.5-sunburst";
}

/** Blends with OpenAI's image edit API, using OPENAI_API_KEY. */
export function openAiBlend(apiKey: string, model = blendModel()): Blend {
  return async ({ image, mask, size }) => {
    const form = new FormData();
    form.append("model", model);
    form.append("prompt", BLEND_PROMPT);
    form.append("image", new Blob([new Uint8Array(image)], { type: "image/png" }), "placed.png");
    form.append("mask", new Blob([new Uint8Array(mask)], { type: "image/png" }), "mask.png");
    form.append("size", size);
    form.append("quality", "high");
    form.append("output_format", "png");
    form.append("n", "1");
    // The first GPT Image models need asking to hold on to the input.
    if (model.startsWith("gpt-image-1")) form.append("input_fidelity", "high");
    const r = await fetch("https://api.openai.com/v1/images/edits", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(180_000),
    });
    const j = (await r.json().catch(() => ({}))) as { data?: { b64_json?: string }[]; error?: { message?: string } };
    if (!r.ok) {
      // OpenAI's own words can quote part of the key, so they go to the log, never to the browser.
      console.error(`OpenAI's image edit answered ${r.status}: ${j.error?.message ?? "with no message"}`);
      throw new BlendError(blendFailure(r.status));
    }
    const b64 = j.data?.[0]?.b64_json;
    if (!b64) throw new BlendError("OpenAI sent no picture back. Try again.");
    return Buffer.from(b64, "base64");
  };
}
