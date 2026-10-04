// Your workshop, on the All designs and parts page: the tools you have,
// your usual finishes, the language Claude writes in and the country it
// searches for parts in. Claude reads them at the start of each message.
// They're app-wide, so changing them never changes a design.

import { useEffect, useState, type FormEvent } from "react";
import { countryNote, formOf, sameWorkshop, SAVED, workshopOf, type WorkshopForm, type WorkshopState } from "../workshop";

export function WorkshopPanel() {
  const [loaded, setLoaded] = useState<WorkshopState | null>(null);
  const [form, setForm] = useState<WorkshopForm | null>(null);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetch("/api/workshop")
      .then((r) => (r.ok ? (r.json() as Promise<WorkshopState>) : Promise.reject(new Error())))
      .then((s) => {
        if (!live) return;
        setLoaded(s);
        setForm(formOf(s.workshop));
      })
      .catch(() => live && setError("Couldn't load your workshop. Try again in a moment."));
    return () => {
      live = false;
    };
  }, []);

  if (!loaded || !form) return <div className="muted small">{error ?? "Loading…"}</div>;

  const next = workshopOf(form);
  const changed = !sameWorkshop(next, loaded.workshop);
  const atDefaults = sameWorkshop(next, loaded.defaults);
  const set = (field: keyof WorkshopForm) => (e: { target: { value: string } }) => {
    setForm({ ...form, [field]: e.target.value });
    setNote(null);
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!changed) return;
    setSaving(true);
    try {
      const r = await fetch("/api/workshop", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(next) });
      const body = (await r.json()) as WorkshopState & { error?: string };
      if (!r.ok) {
        setError(body.error ?? "Couldn't save your workshop");
        return;
      }
      setLoaded(body);
      setForm(formOf(body.workshop));
      setError(null);
      setNote(SAVED);
    } catch {
      setError("Couldn't reach Woodchuck to save. Try again in a moment.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="workshop-form" aria-label="Your workshop" onSubmit={save}>
      <p className="muted small">What Claude assumes about your workshop. It reads these at the start of each message, and your designs stay as they are.</p>
      <label>
        Tools you have
        <textarea rows={6} value={form.tools} onChange={set("tools")} />
        <small>One to a line. Claude won't plan on a tool that isn't here.</small>
      </label>
      <label>
        Your usual finishes
        <textarea rows={3} value={form.finishes} onChange={set("finishes")} />
        <small>Claude uses these unless you ask for something else.</small>
      </label>
      <label>
        The language Claude writes in
        <input value={form.language} onChange={set("language")} />
      </label>
      <label>
        The country to search for parts in
        <input
          className="country"
          maxLength={2}
          autoCapitalize="characters"
          disabled={loaded.country_override !== null}
          value={loaded.country_override ?? form.country}
          onChange={set("country")}
        />
        <small>{countryNote(loaded.country_override)}</small>
      </label>
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      <div className="row">
        <button type="submit" className="primary" disabled={saving || !changed}>
          {saving ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          disabled={atDefaults}
          title="Fills in the standard home workshop Woodchuck starts with. Nothing changes until you save."
          onClick={() => {
            setForm(formOf(loaded.defaults));
            setNote(null);
          }}
        >
          Put back the defaults
        </button>
        {note && !changed && (
          <span className="muted small" role="status">
            {note}
          </span>
        )}
      </div>
    </form>
  );
}
