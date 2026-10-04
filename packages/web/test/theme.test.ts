// The theme choice, its pre-paint script, and the colours behind it.

import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import {
  THEMES,
  THEME_KEY,
  createThemeStore,
  fullHex,
  isChoice,
  readPaper,
  readScene,
  resolveTheme,
  type MediaLike,
  type ThemeChoice,
} from "../src/theme.js";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

// Stand-ins for the browser's storage, its dark setting and the page's <html>.
function fakeStorage(initial: Record<string, string> = {}) {
  const data = { ...initial };
  return { data, getItem: (k: string) => data[k] ?? null, setItem: (k: string, v: string) => void (data[k] = v) };
}
function fakeMedia(dark: boolean) {
  const listeners = new Set<() => void>();
  const media = {
    matches: dark,
    listeners,
    addEventListener: (_: "change", fn: () => void) => void listeners.add(fn),
    removeEventListener: (_: "change", fn: () => void) => void listeners.delete(fn),
    /** The device changes its setting, and the browser says so. */
    turn(next: boolean) {
      media.matches = next;
      for (const fn of [...listeners]) fn();
    },
  };
  return media satisfies MediaLike & { turn(next: boolean): void; listeners: Set<() => void> };
}
const fakeRoot = () => ({ dataset: {} as Record<string, string | undefined> });

describe("the theme choice", () => {
  it("offers System and the five themes, in that order", () => {
    expect(THEMES.map((t) => t.label)).toEqual(["System", "Zinc", "Midnight", "Espresso", "OLED", "Light"]);
    expect(isChoice("midnight")).toBe(true);
    expect(isChoice("neon")).toBe(false);
  });

  it("wears the stored choice and remembers a new one", () => {
    const storage = fakeStorage({ [THEME_KEY]: "espresso" });
    const root = fakeRoot();
    const store = createThemeStore({ storage, media: fakeMedia(false), root });
    expect(root.dataset.theme).toBe("espresso");
    expect(store.getState()).toEqual({ choice: "espresso", theme: "espresso" });

    store.set("oled");
    expect(root.dataset.theme).toBe("oled");
    expect(storage.data[THEME_KEY]).toBe("oled");

    // A fresh page over the same storage, such as after a reload, wears it too.
    const again = fakeRoot();
    expect(createThemeStore({ storage, media: fakeMedia(false), root: again }).getState().choice).toBe("oled");
    expect(again.dataset.theme).toBe("oled");
  });

  it("keeps the choice under wc-theme", () => {
    expect(THEME_KEY).toBe("wc-theme");
  });

  it("is System when nothing, or something unknown, is stored", () => {
    for (const stored of [undefined, "", "neon", "SYSTEM"]) {
      const root = fakeRoot();
      const store = createThemeStore({ storage: fakeStorage(stored === undefined ? {} : { [THEME_KEY]: stored }), media: fakeMedia(true), root });
      expect(store.getState()).toEqual({ choice: "system", theme: "zinc" });
      expect(root.dataset.theme).toBe("zinc");
    }
  });

  it("still works when the browser refuses storage", () => {
    const refusing = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    const root = fakeRoot();
    const store = createThemeStore({ storage: refusing, media: fakeMedia(false), root });
    expect(root.dataset.theme).toBe("light");
    store.set("midnight");
    expect(root.dataset.theme).toBe("midnight");
  });

  it("tells whoever is watching when the theme changes, and not when it doesn't", () => {
    const store = createThemeStore({ storage: fakeStorage(), media: fakeMedia(false), root: fakeRoot() });
    let calls = 0;
    const stop = store.subscribe(() => calls++);
    store.set("zinc");
    store.set("zinc");
    expect(calls).toBe(1);
    stop();
    store.set("light");
    expect(calls).toBe(1);
  });

  it("leaves the page's attribute alone when it already holds the theme", () => {
    let writes = 0;
    let held: string | undefined = "light";
    const root = {
      dataset: {
        get theme() {
          return held;
        },
        set theme(v: string | undefined) {
          writes++;
          held = v;
        },
      },
    };
    createThemeStore({ storage: fakeStorage({ [THEME_KEY]: "light" }), media: fakeMedia(true), root: root as never });
    expect(writes).toBe(0);
  });
});

describe("System follows the device", () => {
  it("maps dark to Zinc and light to Light", () => {
    expect(resolveTheme("system", true)).toBe("zinc");
    expect(resolveTheme("system", false)).toBe("light");
    for (const t of ["zinc", "midnight", "espresso", "oled", "light"] as const) {
      expect(resolveTheme(t, true)).toBe(t);
      expect(resolveTheme(t, false)).toBe(t);
    }
  });

  it("follows the media query live, with no reload", () => {
    const media = fakeMedia(false);
    const root = fakeRoot();
    const store = createThemeStore({ storage: fakeStorage(), media, root });
    let calls = 0;
    store.subscribe(() => calls++);
    expect(root.dataset.theme).toBe("light");

    media.turn(true);
    expect(root.dataset.theme).toBe("zinc");
    expect(store.getState()).toEqual({ choice: "system", theme: "zinc" });

    media.turn(false);
    expect(root.dataset.theme).toBe("light");
    expect(calls).toBe(2);
  });

  it("ignores the device once a theme is chosen, and follows it again on System", () => {
    const media = fakeMedia(false);
    const root = fakeRoot();
    const storage = fakeStorage();
    const store = createThemeStore({ storage, media, root });
    store.set("midnight");
    media.turn(true);
    media.turn(false);
    expect(root.dataset.theme).toBe("midnight");

    store.set("system");
    expect(storage.data[THEME_KEY]).toBe("system");
    expect(root.dataset.theme).toBe("light");
    media.turn(true);
    expect(root.dataset.theme).toBe("zinc");
  });

  it("stops listening when it's disposed", () => {
    const media = fakeMedia(false);
    const store = createThemeStore({ storage: fakeStorage(), media, root: fakeRoot() });
    expect(media.listeners.size).toBe(1);
    store.dispose();
    expect(media.listeners.size).toBe(0);
  });

  it("takes up a choice another window made", () => {
    const storage = fakeStorage();
    const root = fakeRoot();
    const store = createThemeStore({ storage, media: fakeMedia(false), root });
    storage.data[THEME_KEY] = "oled";
    store.refresh();
    expect(root.dataset.theme).toBe("oled");
  });

  it("keeps the picture page for Claude Light, whatever the choice or the device", () => {
    const storage = fakeStorage({ [THEME_KEY]: "oled" });
    const root = fakeRoot();
    const store = createThemeStore({ storage, media: fakeMedia(true), root, fixed: "light" });
    expect(root.dataset.theme).toBe("light");
    store.set("zinc");
    expect(root.dataset.theme).toBe("light");
    expect(storage.data[THEME_KEY]).toBe("oled");
  });
});

describe("the script that sets the theme before the first paint", () => {
  const html = read("../index.html");
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)![1]!;

  function runScript(stored: string | null | "throws", macDark: boolean, search = ""): string | undefined {
    const root = { dataset: {} as Record<string, string | undefined> };
    vm.runInNewContext(script, {
      localStorage: {
        getItem: (k: string) => {
          if (stored === "throws") throw new Error("blocked");
          return k === THEME_KEY ? stored : null;
        },
      },
      matchMedia: (q: string) => ({ matches: q.includes("dark") ? macDark : false }),
      location: { search },
      document: { documentElement: root },
    });
    return root.dataset.theme;
  }

  it("comes before the page's own scripts and styles, so nothing flashes", () => {
    const at = html.indexOf("<script>");
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(html.indexOf('type="module"'));
  });

  it("gives the same answer as the app's own rules, for every stored value and device setting", () => {
    const stored: (string | null | "throws")[] = [null, "", "system", "zinc", "midnight", "espresso", "oled", "light", "neon", "throws"];
    for (const s of stored) {
      for (const mac of [true, false]) {
        const choice: ThemeChoice = s !== "throws" && s !== null && isChoice(s) ? s : "system";
        expect(runScript(s, mac), `stored ${String(s)}, dark device ${mac}`).toBe(resolveTheme(choice, mac));
      }
    }
  });

  it("keeps the picture page for Claude Light", () => {
    expect(runScript("oled", true, "?render=1&look=plain")).toBe("light");
    expect(runScript("zinc", true, "?look=plain&render=1")).toBe("light");
    expect(runScript("zinc", true, "?render=10")).toBe("zinc");
  });
});

// The colours: every theme's tokens are in themes.css, and styles.css only refers to them.
const themesCss = read("../src/themes.css").replace(/\/\*[\s\S]*?\*\//g, "");
const stylesCss = read("../src/styles.css").replace(/\/\*[\s\S]*?\*\//g, "");

type Tokens = Record<string, string>;
function themeBlocks(): { themes: Record<string, Tokens>; shared: Tokens } {
  const themes: Record<string, Tokens> = {};
  const shared: Tokens = {};
  for (const [, selector, body] of themesCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const tokens: Tokens = {};
    for (const [, name, value] of body!.matchAll(/([\w-]+)\s*:\s*([^;]+);/g)) tokens[name!] = value!.trim();
    const names = [...selector!.matchAll(/\[data-theme="(\w+)"\]/g)].map((m) => m[1]!);
    if (names.length) themes[names[0]!] = tokens;
    else Object.assign(shared, tokens);
  }
  return { themes, shared };
}
const { themes, shared } = themeBlocks();

/** A token's value, following any var() to the token it names. */
function resolve(theme: string, name: string): string {
  let v = themes[theme]![name] ?? shared[name] ?? "";
  for (let i = 0; i < 5; i++) {
    const m = /^var\((--[\w-]+)\)$/.exec(v);
    if (!m) break;
    v = themes[theme]![m[1]!] ?? shared[m[1]!] ?? "";
  }
  return v;
}

function rgb(v: string): [number, number, number] {
  const h = fullHex(v);
  if (!/^#[0-9a-f]{6}$/i.test(h)) throw new Error(`not a hex colour: ${v}`);
  return [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}
function luminance([r, g, b]: [number, number, number]): number {
  const f = (c: number) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function contrast(a: string, b: string): number {
  const [x, y] = [luminance(rgb(a)), luminance(rgb(b))];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
const mix = (a: string, b: string, share: number): string => {
  const [x, y] = [rgb(a), rgb(b)];
  return `#${x.map((c, i) => Math.round(c * share + y[i]! * (1 - share)).toString(16).padStart(2, "0")).join("")}`;
};

const NAMES = ["zinc", "midnight", "espresso", "oled", "light"];

describe("the themes' colours", () => {
  it("has the five themes Crossband and Membro use", () => {
    expect(Object.keys(themes).sort()).toEqual([...NAMES].sort());
  });

  it("gives every theme every token", () => {
    const all = new Set(Object.values(themes).flatMap((t) => Object.keys(t)));
    expect(all.size).toBeGreaterThan(30);
    for (const name of NAMES) {
      const missing = [...all].filter((k) => !(k in themes[name]!));
      expect(missing, `${name} is missing`).toEqual([]);
    }
  });

  it("keeps the siblings' dark palettes, with their names", () => {
    // From Crossband's index.css and Membro's index.html.
    const siblings: Record<string, Record<string, string>> = {
      zinc: { "--t-app": "#09090b", "--t-panel": "#18181b", "--t-panel2": "#27272a", "--t-ink": "#f4f4f5", "--t-ink-mid": "#a1a1aa", "--t-err": "#f87171" },
      midnight: { "--t-app": "#0a0f1e", "--t-panel": "#121a2b", "--t-panel2": "#1c2740", "--t-ink": "#e8ecf6", "--t-ink-mid": "#9aa7c2", "--t-err": "#fb7185" },
      espresso: { "--t-app": "#131110", "--t-panel": "#1b1815", "--t-panel2": "#282218", "--t-ink": "#f1ece4", "--t-ink-mid": "#b3a895", "--t-err": "#f28b82" },
      oled: { "--t-app": "#000000", "--t-panel": "#0d0d0f", "--t-panel2": "#1a1a1d", "--t-ink": "#f5f5f7", "--t-ink-mid": "#a0a0a8", "--t-err": "#f87171" },
    };
    for (const [name, tokens] of Object.entries(siblings)) expect(themes[name], name).toMatchObject(tokens);
  });

  it("keeps Woodchuck's timber accent, and its warm paper look in Light", () => {
    expect(themes.light).toMatchObject({ "--t-app": "#f4f1ec", "--t-panel": "#fffdf9", "--t-ink": "#2b241d", "--t-accent": "#8a5a2b", "--t-btn": "#8a5a2b" });
    // Espresso keeps its siblings' accent, which is already timber.
    expect(themes.espresso).toMatchObject({ "--t-accent": "#f0b37e" });
    for (const name of NAMES) {
      const [r, g, b] = rgb(themes[name]!["--t-accent"]!);
      expect(r, `${name}'s accent is warm`).toBeGreaterThan(b + 40);
      expect(r).toBeGreaterThanOrEqual(g);
    }
  });

  it("is Zinc when the page names no theme", () => {
    expect(themesCss).toMatch(/:root,\s*\[data-theme="zinc"\]/);
  });

  it("sets the browser's own controls and scrollbars to match", () => {
    for (const name of NAMES) expect(themes[name]!["color-scheme"] ?? "", name).toBe(name === "light" ? "light" : "dark");
  });

  it("reads on every surface: text, links, states and the primary button", () => {
    for (const name of NAMES) {
      const t = (k: string) => resolve(name, k);
      for (const surface of ["--t-app", "--t-panel", "--wc-field", "--wc-card"]) {
        for (const ink of ["--t-ink", "--t-ink-mid", "--t-link", "--t-accent", "--t-ok", "--t-warn", "--t-err", "--t-info"]) {
          expect(contrast(t(ink), t(surface)), `${name}: ${ink} on ${surface}`).toBeGreaterThanOrEqual(4.5);
        }
      }
      expect(contrast(t("--t-btn-ink"), t("--t-btn")), `${name}: primary button`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t("--t-btn-ink"), t("--t-btn-hover")), `${name}: primary button hovered`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t("--t-btn"), t("--t-panel")), `${name}: the button against its panel`).toBeGreaterThanOrEqual(3);
    }
  });

  it("reads on the tinted notes, chips and chosen buttons, which are mixed from the theme", () => {
    for (const name of NAMES) {
      const t = (k: string) => resolve(name, k);
      const panel = t("--t-panel");
      // The share of the colour in each tint, as styles.css mixes it.
      const share = (name: string) => Number(new RegExp(`${name}:\\s*color-mix\\(in srgb,\\s*var\\([^)]*\\)\\s*(\\d+)%`).exec(stylesCss)![1]) / 100;
      const tint = (colour: string, token: string) => mix(t(colour), panel, share(token));
      const cases: [string, string, string][] = [
        ["ready, ok", "--t-ok", tint("--t-ok", "--tint-ok")],
        ["ready, waiting", "--t-warn", tint("--t-warn", "--tint-warn")],
        ["a problem or a pin", "--t-err", tint("--t-err", "--tint-bad")],
        ["a chip", "--t-info", tint("--t-info", "--tint-pick")],
        ["a chosen button", "--t-ink", tint("--t-accent", "--on")],
        ["muted text on a chosen button", "--t-ink-mid", tint("--t-accent", "--on")],
      ];
      for (const [what, ink, bg] of cases) expect(contrast(t(ink), bg), `${name}: ${what}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("keeps the focus ring and a disabled button readable", () => {
    for (const name of NAMES) {
      const t = (k: string) => resolve(name, k);
      for (const surface of ["--t-app", "--t-panel"]) expect(contrast(t("--t-focus"), t(surface)), `${name}: focus ring on ${surface}`).toBeGreaterThanOrEqual(3);
      // A disabled button is its text at half strength over the panel.
      expect(contrast(mix(t("--t-ink"), t("--t-panel"), 0.5), t("--t-panel")), `${name}: a disabled button`).toBeGreaterThanOrEqual(3);
    }
  });

  it("gives the Finish tab's layout drawings a part colour its labels read on", () => {
    for (const name of NAMES) {
      const t = (k: string) => resolve(name, k);
      expect(contrast(t("--t-ink"), t("--wc-part")), `${name}: label on a part`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t("--t-ink"), t("--wc-part-hover")), `${name}: label on a hovered part`).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("the 3D view's colours", () => {
  const SCENE = ["bg", "cell", "section", "edge", "edge-see", "pick", "pick-edge", "glow", "cut", "cut-edge", "tongue", "fastener", "hardware", "hardware-edge", "pin", "pin-ring"];

  it("gives every theme a six-digit colour for each part of the view", () => {
    for (const name of NAMES) {
      for (const s of SCENE) expect(resolve(name, `--wc-scene-${s}`), `${name} ${s}`).toMatch(/^#[0-9a-f]{3}([0-9a-f]{3})?$/i);
    }
  });

  it("follows the theme: the background, ground grid and fixing rods change with it", () => {
    for (const name of NAMES) {
      expect(resolve(name, "--wc-scene-bg"), name).toBe(resolve(name, "--t-app"));
    }
    expect(resolve("light", "--wc-scene-bg")).not.toBe(resolve("zinc", "--wc-scene-bg"));
    expect(new Set(NAMES.map((n) => resolve(n, "--wc-scene-cell"))).size).toBe(NAMES.length);
  });

  it("keeps the grid quiet but present, and the selection, glow and rods clear of it", () => {
    for (const name of NAMES) {
      const t = (k: string) => resolve(name, k);
      const bg = t("--wc-scene-bg");
      expect(contrast(t("--wc-scene-cell"), bg), `${name}: cell lines`).toBeGreaterThan(1.1);
      expect(contrast(t("--wc-scene-section"), bg), `${name}: section lines`).toBeGreaterThan(1.4);
      expect(contrast(t("--wc-scene-section"), bg), `${name}: section lines stay quiet`).toBeLessThan(2.5);
      for (const marker of ["pick-edge", "glow", "edge-see", "fastener"]) {
        expect(contrast(t(`--wc-scene-${marker}`), bg), `${name}: ${marker}`).toBeGreaterThanOrEqual(3.5);
      }
    }
  });

  it("keeps the plain look's timber colours clear of the dark backgrounds", () => {
    const src = read("../src/components/Viewport.tsx");
    const wood = [...(/const WOOD = \[([^\]]+)\]/.exec(src)![1]!.matchAll(/#[0-9a-f]{6}/gi))].map((m) => m[0]);
    expect(wood.length).toBeGreaterThan(4);
    for (const name of NAMES.filter((n) => n !== "light")) {
      for (const colour of wood) expect(contrast(colour, resolve(name, "--wc-scene-bg")), `${name}: ${colour}`).toBeGreaterThanOrEqual(5);
    }
  });

  it("reads the view's colours and the 2D sheet's from the page's style", () => {
    const style = (values: Record<string, string>) => ({ getPropertyValue: (n: string) => values[n] ?? "" });
    const dark = readScene(style({ "--wc-scene-bg": " #000 ", "--wc-scene-cell": "#1f1f23" }));
    expect(dark.bg).toBe("#000000");
    expect(dark.cell).toBe("#1f1f23");
    expect(dark.glow).toBe("");
    expect(readPaper(style({ "--t-panel": "#18181b", "--t-edge": "#27272a", "--t-ink": "#f4f4f5", "--t-ink-mid": "#a1a1aa" }))).toEqual({
      background: "#18181b",
      rule: "#27272a",
      ink: "#f4f4f5",
      mid: "#a1a1aa",
      edge: "#a1a1aa",
      label: "#f4f4f5",
    });
    expect(fullHex("#fff")).toBe("#ffffff");
    expect(fullHex("#abcdef")).toBe("#abcdef");
  });
});

describe("no colour is left outside the themes", () => {
  const COLOUR_PROPS = /^(color|background(-color|-image)?|border(-top|-right|-bottom|-left)?(-color)?|outline(-color)?|fill|stroke|box-shadow|text-shadow|caret-color|accent-color|text-decoration-color|column-rule-color|stop-color|flood-color)$/;
  // The CSS colour names, which would slip past a search for # and rgb().
  const NAMED = new Set(
    (
      "aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan " +
      "darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey " +
      "darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink " +
      "indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen " +
      "lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue " +
      "mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise " +
      "palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray " +
      "slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen"
    ).split(" "),
  );

  /** Every declaration in a stylesheet, with its selector's block. */
  function declarations(css: string): { prop: string; value: string }[] {
    const out: { prop: string; value: string }[] = [];
    for (const [, body] of css.matchAll(/\{([^{}]*)\}/g)) {
      for (const [, prop, value] of body!.matchAll(/([\w-]+)\s*:\s*([^;]+)(?:;|$)/g)) out.push({ prop: prop!, value: value!.trim() });
    }
    return out;
  }

  it("writes no hex, rgb, hsl or other colour of its own in styles.css", () => {
    const found = declarations(stylesCss.replace(/@import[^;]*;/g, ""))
      .filter((d) => /#[0-9a-f]{3,8}\b/i.test(d.value) || /\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/i.test(d.value))
      .map((d) => `${d.prop}: ${d.value}`);
    expect(found).toEqual([]);
  });

  it("uses no colour name either", () => {
    const found = declarations(stylesCss)
      .filter((d) => COLOUR_PROPS.test(d.prop) || d.prop.startsWith("--"))
      // A variable's name or a color-mix's space can contain a colour word.
      .filter((d) => d.value.replace(/var\([^)]*\)/g, "").split(/[^a-z]+/i).some((w) => NAMED.has(w.toLowerCase())))
      .map((d) => `${d.prop}: ${d.value}`);
    expect(found).toEqual([]);
  });

  it("only refers to variables that a theme or the stylesheet defines", () => {
    const defined = new Set([...stylesCss.matchAll(/(--[\w-]+)\s*:/g), ...themesCss.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
    const used = new Set([...stylesCss.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]!));
    expect([...used].filter((u) => !defined.has(u))).toEqual([]);
    expect(used.size).toBeGreaterThan(10);
  });

  it("holds no hard-coded colour in the components' own styling", () => {
    // The 3D view, the 2D sheets and the pin marker take theirs from the theme.
    for (const file of ["../src/components/Viewport.tsx", "../src/components/ChatPanel.tsx", "../src/components/PartCard.tsx", "../src/components/Panels.tsx", "../src/components/ThemeSwitch.tsx"]) {
      const src = read(file)
        .split("\n")
        // The plain look's own timber colours, which stay as they are, and the flat white a photo's JPEG is flattened onto.
        .filter((line) => !/const WOOD =|"#f0a24a"|"#bdbdbd"|"#d2ab7c"|ctx\.fillStyle = "#fff"|emissive=\{highlighted \? scene\.glow : "#000000"\}/.test(line))
        .join("\n");
      expect(src.match(/["'`]#[0-9a-f]{3,8}["'`]/gi) ?? [], file).toEqual([]);
    }
  });
});
