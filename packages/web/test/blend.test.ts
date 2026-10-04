import { afterEach, describe, expect, it, vi } from "vitest";
import { BLEND_LABEL, BLEND_NOTICE, LABEL_FONT_SHARE, LABEL_MARGIN_SHARE, fitFor, labelFor, withLabel } from "../src/blend.js";

describe("fitting a photo to the image model's sizes", () => {
  it("pads rather than stretches, so the piece keeps its proportions", () => {
    const f = fitFor(1600, 1200);
    expect(f).toMatchObject({ size: "1536x1024", width: 1536, height: 1024, w: 1365, h: 1024, y: 0 });
    expect(f.w / f.h).toBeCloseTo(1600 / 1200, 2);
    expect(f.x).toBe(Math.round((1536 - 1365) / 2));
  });

  it("picks portrait and square sizes for those shapes", () => {
    expect(fitFor(3000, 4000).size).toBe("1024x1536");
    expect(fitFor(1000, 1000).size).toBe("1024x1024");
    expect(fitFor(1100, 1000).size).toBe("1024x1024");
  });
});

// An image model can change drawer counts and proportions, so a blend says so.
describe("labelling a saved picture as not to scale", () => {
  it("labels a blend and nothing else", () => {
    expect(labelFor("blend", 1600)).not.toBeNull();
    expect(labelFor("true-scale", 1600)).toBeNull();
  });

  it("says the same thing on screen and in the saved corner", () => {
    expect(BLEND_NOTICE).toBe("AI blend: not to scale");
    expect(labelFor("blend", 1600)!.text).toBe(BLEND_LABEL);
    expect(BLEND_LABEL).toBe("AI blend \u00b7 not to scale");
  });

  it("sizes the label and sets it in the top left corner as shares of the picture's width", () => {
    const l = labelFor("blend", 2000)!;
    expect(l.fontPx).toBe(Math.round(2000 * LABEL_FONT_SHARE));
    expect(l.x).toBe(Math.round(2000 * LABEL_MARGIN_SHARE));
    expect(l.y).toBe(l.x);
    // The same share on a bigger picture is a bigger label in the same place.
    const big = labelFor("blend", 3000)!;
    expect(big.fontPx / 3000).toBeCloseTo(l.fontPx / 2000, 2);
    expect(big.x / 3000).toBeCloseTo(l.x / 2000, 2);
  });

  it("keeps the words readable on a small picture", () => {
    expect(labelFor("blend", 300)!.fontPx).toBe(14);
  });
});

// There's no canvas in the test run, so a recording stand-in shows what gets drawn.
describe("drawing the label into a saved picture", () => {
  const drawn: { text: string; x: number; y: number }[] = [];
  const fakeBrowser = (width: number, height: number) => {
    class FakeImage {
      src = "";
      naturalWidth = width;
      naturalHeight = height;
      decode = async () => {};
    }
    vi.stubGlobal("Image", FakeImage);
    vi.stubGlobal("document", {
      createElement: () => ({
        width: 0,
        height: 0,
        toDataURL: () => "data:image/png;base64,LABELLED",
        getContext: () => ({
          drawImage() {},
          beginPath() {},
          roundRect() {},
          fill() {},
          measureText: () => ({ width: 400 }),
          fillText: (text: string, x: number, y: number) => drawn.push({ text, x, y }),
        }),
      }),
    });
  };
  afterEach(() => {
    drawn.length = 0;
    vi.unstubAllGlobals();
  });

  it("writes the words on a blend, in its corner", async () => {
    fakeBrowser(1600, 1200);
    const url = await withLabel("data:image/png;base64,BLEND", "blend");
    expect(url).toBe("data:image/png;base64,LABELLED");
    const l = labelFor("blend", 1600)!;
    expect(drawn).toEqual([{ text: BLEND_LABEL, x: l.x + l.padPx, y: l.y + (l.fontPx + l.padPx * 2) / 2 }]);
  });

  it("leaves a true-scale picture as it is", async () => {
    fakeBrowser(1600, 1200);
    expect(await withLabel("data:image/png;base64,TRUE", "true-scale")).toBe("data:image/png;base64,TRUE");
    expect(drawn).toEqual([]);
  });
});
