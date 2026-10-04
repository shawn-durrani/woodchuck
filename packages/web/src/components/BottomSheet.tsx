// The bottom sheet's bar on a phone: a handle to drag or tap, the Chat and
// Panels switch, and an arrow to pull it up or put it down. The sheet is
// the chat column itself, so the waiting bar and the chat box under it
// never leave the screen. The model picker from the chat box sits on this
// bar too. The note after an undo, which holds Redo, rides over the model.

import type { PhoneShell } from "./PhoneShell";

export function SheetBar({ shell }: { shell: PhoneShell }) {
  const { sheet } = shell;
  const open = sheet.mode !== "peek";
  return (
    <div
      className="sheet-bar"
      onPointerDown={(e) => {
        if ((e.target as HTMLElement).closest("button, select, a, input")) return;
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          // Synthetic pointers can't be captured; the drag still works without it.
        }
        shell.drag.start(e.clientY);
      }}
      onPointerMove={(e) => shell.drag.move(e.clientY)}
      onPointerUp={() => shell.drag.end()}
      onPointerCancel={() => shell.drag.cancel()}
    >
      <span className="sheet-grab" aria-hidden="true" />
      <div className="seg sheet-switch" role="group" aria-label="What the sheet shows">
        <button type="button" className={sheet.mode === "chat" ? "on" : ""} aria-pressed={sheet.mode === "chat"} title="The chat with Claude" onClick={() => shell.switchTo("chat")}>
          Chat
        </button>
        <button type="button" className={sheet.mode === "panels" ? "on" : ""} aria-pressed={sheet.mode === "panels"} title="Edit, Finish, Make, Check and History" onClick={() => shell.switchTo("panels")}>
          Panels
        </button>
      </div>
      <button type="button" className="sheet-toggle" aria-expanded={open} aria-label={open ? "Put the sheet down" : "Pull the sheet up"} title={open ? "Put the sheet down" : "Pull the sheet up"} onClick={shell.toggle}>
        <svg width="20" height="12" viewBox="0 0 20 12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M3 9.5 10 2.5l7 7" />
        </svg>
      </button>
    </div>
  );
}

/** "Undone: what it was", with Redo, since a phone's header has room for Undo only. */
export function UndoneNote({ undone, canRedo, onRedo, onDismiss }: { undone: string; canRedo: boolean; onRedo: () => void; onDismiss: () => void }) {
  return (
    <div className="undone-note" role="status">
      <span className="undone-text" title={undone}>
        Undone: {undone}
      </span>
      <button
        type="button"
        className="link"
        disabled={!canRedo}
        onClick={() => {
          onRedo();
          onDismiss();
        }}
      >
        Redo
      </button>
      <button type="button" className="link undone-close" aria-label="Dismiss" title="Dismiss" onClick={onDismiss}>
        ×
      </button>
    </div>
  );
}
