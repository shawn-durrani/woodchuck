// A field that saves when you leave it, for the inspector's sizes and cuts.

import { useEffect, useState } from "react";

/**
 * A field that saves when you leave it or press Enter. Escape puts back the
 * value in force, and so does a value the design refuses. onDraft hears
 * each keystroke while you type, and null once the typing is over, so a
 * change can be drawn on the model before it's made.
 */
export function Field({
  value,
  onSave,
  onDraft,
  placeholder,
  disabled,
  invalid,
}: {
  value: string;
  onSave: (v: string) => Promise<boolean>;
  onDraft?: (v: string | null) => void;
  placeholder?: string;
  disabled?: boolean;
  invalid?: boolean;
}) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <input
      className="expr"
      value={v}
      disabled={disabled}
      placeholder={placeholder}
      aria-invalid={invalid || undefined}
      onChange={(e) => {
        setV(e.target.value);
        onDraft?.(e.target.value);
      }}
      onBlur={async () => {
        if (v !== value && !(await onSave(v))) setV(value);
        onDraft?.(null);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") {
          setV(value);
          onDraft?.(null);
        }
      }}
    />
  );
}
