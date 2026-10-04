// A button that opens a short menu under it. The parent says whether it's
// open, so only one menu is open at a time. A click outside or Esc closes
// it, and Esc does nothing else while a menu is open. The arrow keys move
// between items. An item that can't act stays in its place, greyed, with
// a tooltip that says why.

import { useEffect, useRef, type ReactNode } from "react";

export function Menu({
  id,
  label,
  open,
  onOpen,
  title,
  disabled = false,
  align = "left",
  className = "",
  triggerClass = "",
  control,
  children,
}: {
  id: string;
  /** What the button shows. */
  label: ReactNode;
  open: boolean;
  onOpen: (open: boolean) => void;
  title: string;
  disabled?: boolean;
  /** Which edge of the button the menu lines up with. */
  align?: "left" | "right";
  className?: string;
  triggerClass?: string;
  /** The id the toolbar knows this control by. */
  control?: string;
  children: ReactNode;
}) {
  const wrap = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const keyboard = useRef(false);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) onOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Esc closes the menu and nothing else.
      e.stopPropagation();
      e.preventDefault();
      onOpen(false);
      button.current?.focus();
    };
    document.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    // Opened from the keyboard, the first item takes the focus.
    if (keyboard.current) items()[0]?.focus();
    keyboard.current = false;
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open, onOpen]);

  const items = () => [...(menu.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])];

  return (
    <span className={`menu-wrap ${className}`} ref={wrap}>
      <button
        ref={button}
        type="button"
        className={`menu-button ${triggerClass}${open ? " open" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-disabled={disabled || undefined}
        data-control={control}
        title={title}
        onClick={() => !disabled && onOpen(!open)}
        onKeyDown={(e) => {
          if (disabled) return;
          if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            keyboard.current = true;
            if (open) items()[0]?.focus();
            else onOpen(true);
          }
        }}
      >
        {label}
        <span className="caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <div
          id={id}
          ref={menu}
          role="menu"
          aria-label={title}
          className={`menu menu-${align}`}
          onKeyDown={(e) => {
            const all = items();
            const at = all.indexOf(document.activeElement as HTMLElement);
            const go = (i: number) => {
              e.preventDefault();
              all[(i + all.length) % all.length]?.focus();
            };
            if (e.key === "ArrowDown") go(at + 1);
            else if (e.key === "ArrowUp") go(at - 1);
            else if (e.key === "Home") go(0);
            else if (e.key === "End") go(all.length - 1);
            else if (e.key === "Tab") onOpen(false);
          }}
        >
          {children}
        </div>
      )}
    </span>
  );
}

/** One item in a menu: an action, a choice among several, or a switch. */
export function MenuItem({
  children,
  onSelect,
  disabled = false,
  title,
  kind = "action",
  checked,
  hint,
  danger = false,
  control,
  badge,
  aside,
}: {
  children: ReactNode;
  onSelect: () => void;
  disabled?: boolean;
  title?: string;
  kind?: "action" | "radio" | "check";
  checked?: boolean;
  /** A keyboard shortcut, at the right. */
  hint?: string;
  /** A short note at the right, such as the paper size. */
  aside?: string;
  danger?: boolean;
  control?: string;
  badge?: string;
}) {
  const role = kind === "radio" ? "menuitemradio" : kind === "check" ? "menuitemcheckbox" : "menuitem";
  return (
    <button
      type="button"
      role={role}
      className={`menu-item${danger ? " danger" : ""}${checked ? " on" : ""}`}
      aria-checked={kind === "action" ? undefined : !!checked}
      aria-disabled={disabled || undefined}
      tabIndex={-1}
      title={title}
      data-control={control}
      onClick={() => !disabled && onSelect()}
    >
      <span className="tick" aria-hidden="true">
        {checked ? "✓" : ""}
      </span>
      <span className="menu-label">{children}</span>
      {badge && <span className="badge warn">{badge}</span>}
      {aside && <span className="menu-aside">{aside}</span>}
      {hint && <kbd>{hint}</kbd>}
    </button>
  );
}

/** A heading over a run of choices, with a note when they're off. */
export function MenuSection({ label, note, children, wide = false }: { label: string; note?: string; children: ReactNode; wide?: boolean }) {
  return (
    <div className="menu-section" role="group" aria-label={label}>
      <div className="menu-head">{label}</div>
      <div className={`menu-choices${wide ? " wide" : ""}`}>{children}</div>
      {note && <div className="menu-note">{note}</div>}
    </div>
  );
}

/** A choice in a row of choices, inside a section. */
export function MenuChoice({
  children,
  onSelect,
  disabled = false,
  title,
  checked,
  control,
}: {
  children: ReactNode;
  onSelect: () => void;
  disabled?: boolean;
  title?: string;
  checked: boolean;
  control?: string;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      className={checked ? "on" : ""}
      aria-checked={checked}
      aria-disabled={disabled || undefined}
      tabIndex={-1}
      title={title}
      data-control={control}
      onClick={() => !disabled && onSelect()}
    >
      {children}
    </button>
  );
}

export function MenuDivider() {
  return <hr className="menu-divider" />;
}
