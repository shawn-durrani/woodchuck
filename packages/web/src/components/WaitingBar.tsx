// The bar above the chat box while Claude waits for you. It says what
// Claude asks on one line and holds the live buttons, so there's one place
// to answer however far the chat is scrolled. For a suggested change it
// also lists what the change does, while the model shows it as a ghost.

import type { ReactNode } from "react";
import { SHOW_IN_CHAT } from "../phone";
import type { Answer, Moment } from "../waiting";

/** Brings a card in the chat into view and flashes it. A phone hears first, so it can open the chat sheet. */
export function showInChat(id: string) {
  window.dispatchEvent(new CustomEvent(SHOW_IN_CHAT, { detail: id }));
  const el = document.getElementById(`chat-${id}`);
  el?.scrollIntoView({ block: "center", behavior: "smooth" });
  el?.classList.add("flash");
  setTimeout(() => el?.classList.remove("flash"), 1600);
}

export function WaitingBar({
  moments,
  disabled,
  onAnswer,
  seeing = null,
  detail = null,
}: {
  moments: Moment[];
  disabled: boolean;
  onAnswer: (a: Answer) => void;
  /** The suggested change the model shows "With the change", so See it shows pressed. */
  seeing?: string | null;
  /** What the waiting suggested change does, under its summary. */
  detail?: ReactNode;
}) {
  if (!moments.length) return null;
  return (
    <section className="waiting-bar" aria-label="Claude is waiting for you" aria-live="polite">
      {moments.map((m) => (
        <div key={m.id} className={`waiting-moment wait-${m.kind}`}>
          <div className="waiting-head">
            <span className="waiting-label">Claude is waiting · {m.label}</span>
            <button type="button" className="link small" title="Show the full card in the chat" onClick={() => showInChat(m.id)}>
              show in chat
            </button>
          </div>
          <div className="waiting-summary" title={m.summary}>
            {m.summary}
          </div>
          {m.kind === "preview" && detail}
          {m.actions.length > 0 && (
            <div className="waiting-actions">
              {m.actions.map((a, i) => {
                const pressed = "see" in a.answer ? seeing === a.answer.see : undefined;
                return (
                  <button
                    key={`${i}:${a.label}`}
                    type="button"
                    className={a.primary ? "primary" : pressed ? "on" : ""}
                    title={a.title}
                    aria-pressed={pressed}
                    disabled={disabled && !("see" in a.answer)}
                    onClick={() => onAnswer(a.answer)}
                  >
                    {a.label}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      ))}
    </section>
  );
}
