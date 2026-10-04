// The three rooms the Finished look can show a piece in. The 3D lights for
// each live in components/Lights.tsx; the names are here so the toolbar
// can list them without loading the 3D view.

export type Lighting = "daylight" | "evening" | "workshop";

export const LIGHTINGS: { id: Lighting; label: string; tip: string }[] = [
  { id: "daylight", label: "Daylight", tip: "Soft light from a window on a bright day" },
  { id: "evening", label: "Evening", tip: "Warm lamps at night, about 2700 K" },
  { id: "workshop", label: "Workshop", tip: "Bright, even overhead light, about 4000 K" },
];
