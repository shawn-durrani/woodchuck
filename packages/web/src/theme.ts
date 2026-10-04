// Which theme the app wears. You choose one of the five, or System, which
// follows the device between Light and Zinc and changes when the device does.
// The choice is kept in this browser under wc-theme, and the page's own
// data-theme attribute is what the CSS reads. index.html sets that attribute
// before the first paint, with the same rules as here, so nothing flashes.

import { useMemo, useSyncExternalStore } from "react";

/** Where the choice is kept in this browser. */
export const THEME_KEY = "wc-theme";

export const THEMES = [
  { id: "system", label: "System" },
  { id: "zinc", label: "Zinc" },
  { id: "midnight", label: "Midnight" },
  { id: "espresso", label: "Espresso" },
  { id: "oled", label: "OLED" },
  { id: "light", label: "Light" },
] as const;

export type ThemeChoice = (typeof THEMES)[number]["id"];
/** A theme the page can wear. System is only ever a choice, never a look. */
export type ThemeName = Exclude<ThemeChoice, "system">;

/** The device's dark setting, as the browser asks about it. */
export const DARK_QUERY = "(prefers-color-scheme: dark)";

export function isChoice(v: unknown): v is ThemeChoice {
  return THEMES.some((t) => t.id === v);
}

/** The look a choice gives, given whether the device is set to dark. */
export function resolveTheme(choice: ThemeChoice, systemDark: boolean): ThemeName {
  if (choice !== "system") return choice;
  return systemDark ? "zinc" : "light";
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}
export interface MediaLike {
  matches: boolean;
  addEventListener(type: "change", listener: () => void): void;
  removeEventListener(type: "change", listener: () => void): void;
}
export interface RootLike {
  dataset: Record<string, string | undefined>;
}

export interface ThemeEnv {
  storage?: StorageLike | null;
  media?: MediaLike | null;
  root?: RootLike | null;
  /** A page that always wears one theme, such as the one the server photographs. */
  fixed?: ThemeName;
}

export interface ThemeState {
  choice: ThemeChoice;
  theme: ThemeName;
}

/**
 * The theme, kept in step with the page. It's built from its surroundings so
 * a test can hand it a stand-in for the browser's storage and dark setting.
 */
export function createThemeStore(env: ThemeEnv) {
  const { storage, media, root, fixed } = env;

  const read = (): ThemeChoice => {
    if (fixed) return fixed;
    try {
      const v = storage?.getItem(THEME_KEY);
      return isChoice(v) ? v : "system";
    } catch {
      // Storage can be refused, and System is a fine answer then.
      return "system";
    }
  };

  let state: ThemeState = { choice: "system", theme: "light" };
  const listeners = new Set<() => void>();

  const apply = (choice: ThemeChoice) => {
    const theme = fixed ?? resolveTheme(choice, media?.matches ?? false);
    // The page's own script has usually set it already, and writing it again would only stir the style.
    if (root && root.dataset.theme !== theme) root.dataset.theme = theme;
    if (state.choice === choice && state.theme === theme) return;
    state = { choice, theme };
    for (const l of listeners) l();
  };

  // System follows the device while it's the choice, and changes when the device does.
  const onMedia = () => apply(state.choice);
  media?.addEventListener("change", onMedia);

  apply(read());

  return {
    getState: (): ThemeState => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    /** Wears the theme, and remembers it in this browser. */
    set(choice: ThemeChoice) {
      if (fixed) return;
      try {
        storage?.setItem(THEME_KEY, choice);
      } catch {
        // Private windows can refuse storage; the choice just won't be remembered.
      }
      apply(choice);
    },
    /** Takes up the stored choice again, for when another tab has changed it. */
    refresh() {
      apply(read());
    },
    dispose() {
      media?.removeEventListener("change", onMedia);
      listeners.clear();
    },
  };
}

function browserStore() {
  if (typeof window === "undefined") return createThemeStore({});
  let storage: Storage | null = null;
  try {
    storage = window.localStorage;
  } catch {
    // Some browsers throw on the mere mention of storage.
  }
  // The page the server photographs is for Claude, so it's always Light.
  const rendering = new URLSearchParams(window.location.search).get("render") === "1";
  const store = createThemeStore({
    storage,
    media: window.matchMedia(DARK_QUERY),
    root: document.documentElement,
    ...(rendering ? { fixed: "light" as const } : {}),
  });
  // Another window of the app changing the theme changes this one too.
  window.addEventListener("storage", (e) => {
    if (e.key === THEME_KEY || e.key === null) store.refresh();
  });
  return store;
}

export const themeStore = browserStore();

/** The choice, and the theme it comes to, re-read whenever either changes. */
export function useTheme(): ThemeState & { set: (choice: ThemeChoice) => void } {
  const state = useSyncExternalStore(themeStore.subscribe, themeStore.getState, themeStore.getState);
  return { ...state, set: themeStore.set };
}

/** The colours the 3D view draws its plain look with, as CSS colours. */
export interface SceneColours {
  bg: string;
  cell: string;
  section: string;
  edge: string;
  edgeSee: string;
  pick: string;
  pickEdge: string;
  glow: string;
  cut: string;
  cutEdge: string;
  tongue: string;
  fastener: string;
  hardware: string;
  hardwareEdge: string;
  pin: string;
  pinRing: string;
  /** A suggested change drawn over the model, and its sizes. */
  ghost: string;
}

/** The colours the 2D views are drawn on, as six-digit hex. */
export interface PaperTokens {
  background: string;
  rule: string;
  ink: string;
  mid: string;
  edge: string;
  label: string;
}

type Style = { getPropertyValue(name: string): string };

const SCENE_TOKENS: Record<keyof SceneColours, string> = {
  bg: "--wc-scene-bg",
  cell: "--wc-scene-cell",
  section: "--wc-scene-section",
  edge: "--wc-scene-edge",
  edgeSee: "--wc-scene-edge-see",
  pick: "--wc-scene-pick",
  pickEdge: "--wc-scene-pick-edge",
  glow: "--wc-scene-glow",
  cut: "--wc-scene-cut",
  cutEdge: "--wc-scene-cut-edge",
  tongue: "--wc-scene-tongue",
  fastener: "--wc-scene-fastener",
  hardware: "--wc-scene-hardware",
  hardwareEdge: "--wc-scene-hardware-edge",
  pin: "--wc-scene-pin",
  pinRing: "--wc-scene-pin-ring",
  ghost: "--wc-scene-ghost",
};

/** A short hex colour such as #fff in full, which is how a built stylesheet may write it. */
export function fullHex(v: string): string {
  const m = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(v);
  return m ? `#${m[1]}${m[1]}${m[2]}${m[2]}${m[3]}${m[3]}` : v;
}

/** Reads a set of tokens from the page's style. A token that's missing comes back empty. */
export function readTokens<K extends string>(style: Style, names: Record<K, string>): Record<K, string> {
  const out = {} as Record<K, string>;
  for (const k of Object.keys(names) as K[]) out[k] = fullHex(style.getPropertyValue(names[k]).trim());
  return out;
}

export const readScene = (style: Style): SceneColours => readTokens(style, SCENE_TOKENS);

/** The 2D views' sheet, taken from the theme's own panel, lines and ink. */
export function readPaper(style: Style): PaperTokens {
  return readTokens(style, { background: "--t-panel", rule: "--t-edge", ink: "--t-ink", mid: "--t-ink-mid", edge: "--t-ink-mid", label: "--t-ink" });
}

/** The 3D view's colours for the theme the page wears now. */
export function useScene(): SceneColours {
  const { theme } = useTheme();
  // The theme is part of the key because the page's style is read behind its back.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => readScene(getComputedStyle(document.documentElement)), [theme]);
}

/** The sheet colours for the 2D views, for the theme the page wears now. */
export function usePaper(): PaperTokens {
  const { theme } = useTheme();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => readPaper(getComputedStyle(document.documentElement)), [theme]);
}
