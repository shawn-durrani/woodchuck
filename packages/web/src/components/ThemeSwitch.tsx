// The Theme menu: System, or one of the five themes. The choice is
// kept in this browser. System follows this device between Light and Zinc.

import { THEMES, isChoice, useTheme } from "../theme";

export function ThemeSwitch() {
  const { choice, theme, set } = useTheme();
  const now = THEMES.find((t) => t.id === theme)?.label;
  return (
    <label className="theme-switch small muted" title={choice === "system" ? `System follows this device's light or dark setting, and is ${now} now` : `${now} theme`}>
      Theme
      <select value={choice} onChange={(e) => isChoice(e.target.value) && set(e.target.value)}>
        {THEMES.map((t) => (
          <option key={t.id} value={t.id}>
            {t.label}
          </option>
        ))}
      </select>
    </label>
  );
}
