// Talking to Claude. Each turn's steps fold into one line, the pictures
// Claude looked at and any errors stay in view, and when Claude waits on a
// plan, a question, a suggested change or a part, the bar above the chat
// box holds the answer. A turn's line offers Show me how, and each step
// with a place on screen links to the control Claude used. The chat box
// works while Claude does, and Claude reads what you send after its
// current step.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { post, type ChatItem, type ServerState } from "../api";
import { MissingTool, ToolBuilt } from "./MissingTool";
import { ApprovedPartStatus } from "./LibraryPanel";
import { PartCard } from "./PartCard";
import type { Pin } from "./Viewport";
import type { Drawer } from "./PreviewDrawer";
import { showInChat, WaitingBar } from "./WaitingBar";
import { JOINT_LIBRARY } from "@woodchuck/core";
import { RichText } from "../richText";
import { partNamer, pinsLine, selectionLine } from "../names";
import { changeLine, isUndone } from "../signals";
import { duringNote, foldLine, foldTurns, joinYourEdits, latestStep, notYetRead, turnTime, type Folded, type Row } from "../fold";
import { boxPlaceholder, boxReply, buttonReply, keySizeLine, waitingMoments, type Answer, type Reply } from "../waiting";
import { EMPTY_CHAT, emptyChat, FIX_LP_CHECK, STARTERS, starterFill } from "../starters";
import { TIPS } from "../toolbar";
import { describe, lookupOf, placeOf as placeOfLine, type Place, type ToolLine } from "../follow";

/** How to give Claude a key, shown from the composer when there isn't one. */
function SetUpClaude() {
  return (
    <div className="card warn-card setup-steps" role="note">
      <div className="card-title">Set up Claude</div>
      <ol className="small">
        <li>
          Get an Anthropic API key from the Claude Console at <code>console.anthropic.com</code>.
        </li>
        <li>
          In the Woodchuck folder, copy <code>.env.example</code> to <code>.env</code>, and put the key after <code>ANTHROPIC_API_KEY=</code>.
        </li>
        <li>Restart Woodchuck. This window reconnects by itself, and the chat box opens.</li>
      </ol>
      <p className="small muted">Everything else works without a key: sizes, the cut list, finishes, drawings and photos.</p>
    </div>
  );
}

/** Said on a card while Claude waits on it. Its buttons are in the bar. */
function WaitingNote() {
  return <div className="waiting-note">Claude is waiting for you. Answer just above the chat box.</div>;
}

function PlanCard({ item, live }: { item: ChatItem & { kind: "plan" }; live: boolean }) {
  const p = item.plan;
  return (
    <div className="card plan" id={`chat-${item.id}`}>
      <div className="card-title">Plan for the draft</div>
      {item.image && (
        <a className="sheet" href={`/api/renders/${item.image}`} target="_blank" rel="noreferrer">
          <img src={`/api/renders/${item.image}`} alt="Drawings of the draft" />
        </a>
      )}
      <p>{p.summary}</p>
      {p.parts.length > 0 && (
        <>
          <div className="card-sub">Parts</div>
          <ul>
            {p.parts.map((x) => (
              <li key={x.tag}>
                {x.qty} × {x.label} <span className="muted">({x.tag})</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {p.key_dims.length > 0 && (
        <>
          <div className="card-sub">Key sizes</div>
          <ul>
            {p.key_dims.map((d) => (
              <li key={d.label}>{keySizeLine(d)}</li>
            ))}
          </ul>
        </>
      )}
      {p.joints.length > 0 && (
        <>
          <div className="card-sub">Joints</div>
          <ul>
            {p.joints.map((j) => (
              <li key={j}>{j}</li>
            ))}
          </ul>
        </>
      )}
      {p.assumptions.length > 0 && (
        <>
          <div className="card-sub">Assumptions</div>
          <ul>
            {p.assumptions.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
        </>
      )}
      {item.answered_by && <div className="muted small">Your message sent while Claude worked was taken as the reply: {item.answered}</div>}
      {live && <WaitingNote />}
    </div>
  );
}

type Picture = { media_type: "image/jpeg" | "application/pdf"; data: string; preview: string; name?: string };

/** PDFs go as they are, read straight from the file. */
function readPdf(file: File): Promise<Picture> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const url = String(r.result);
      resolve({ media_type: "application/pdf", data: url.slice(url.indexOf(",") + 1), preview: "", name: file.name });
    };
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

/** Shrinks a picture in the browser so it travels light: 1568 px on the long side, as JPEG. */
async function shrink(file: File): Promise<Picture> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1568 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const url = canvas.toDataURL("image/jpeg", 0.85);
  return { media_type: "image/jpeg", data: url.slice(url.indexOf(",") + 1), preview: url };
}

/** The record console example's opening card: what it is, and why its LP check fails. */
function ExampleIntro({ disabled, onFix }: { disabled: boolean; onFix: () => void }) {
  return (
    <div className="card example-intro" role="note">
      <div className="card-title">The record console example</div>
      <p>
        This is Woodchuck's acceptance test: a record console with LP drawers on side-mount slides. Try anything on it. It's your own copy.
      </p>
      <p>
        Its LP check fails on purpose. The slides take room at each side, so the drawers come out too narrow for LP sleeves. The error shows in
        Problems.
      </p>
      <button className="primary" disabled={disabled} onClick={onFix}>
        Ask Claude to fix the LP check
      </button>
    </div>
  );
}

/** A per-browser setting, such as showing Thinking open. */
function useFlag(key: string): [boolean, (v: boolean) => void] {
  const [on, setOn] = useState(() => {
    try {
      return localStorage.getItem(key) === "on";
    } catch {
      return false;
    }
  });
  const set = useCallback(
    (v: boolean) => {
      setOn(v);
      try {
        localStorage.setItem(key, v ? "on" : "off");
      } catch {
        // Storage can be refused; the setting just won't be remembered.
      }
    },
    [key],
  );
  return [on, set];
}

export function ChatPanel({
  state,
  selection,
  onSelect,
  pins,
  onPins,
  captureView,
  onOpen,
  onSee,
  seeing = null,
  previewDetail = null,
  fill: fillFrom = null,
  onShowHow,
  onStep,
  placeOf = placeOfLine,
  compact = false,
}: {
  state: ServerState;
  selection: string[];
  onSelect: (ids: string[]) => void;
  pins: Pin[];
  onPins: (pins: Pin[]) => void;
  captureView: () => { media_type: "image/jpeg"; data: string } | null;
  /** Shows a preview, on the model while Claude waits on it and in the drawer after, or a joint example in the drawer. */
  onOpen: (d: Drawer) => void;
  /** See it in the waiting bar: flips the model between now and with the change. */
  onSee: (id: string) => void;
  /** The waiting change the model shows "With the change". */
  seeing?: string | null;
  /** What the waiting change does, for the bar. */
  previewDetail?: ReactNode;
  /** Words to put in the chat box, such as a request to fix a problem, once per n. */
  fill?: { text: string; n: number } | null;
  /** Show me how: replays a turn's steps on screen, tab by tab, without changing the design. */
  onShowHow?: (places: Place[]) => void;
  /** A step's link: opens the tab Claude used and lights the control. */
  onStep?: (place: Place) => void;
  /** Where a step shows on screen, with anything the window saw it do. */
  placeOf?: (line: ToolLine) => Place | null;
  /** On a phone the chat box is one line, so it takes short words, and Stop says who it stops. */
  compact?: boolean;
}) {
  const [sendView, setSendView] = useState(true);
  const pointing = selection.length > 0 || pins.length > 0;
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pictures, setPictures] = useState<Picture[]>([]);
  const [setup, setSetup] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  /** Which turns' steps you've opened, by their line's id. */
  const [opened, setOpened] = useState<Set<string>>(() => new Set());
  const [showThinking, setShowThinking] = useFlag("woodchuck.showThinking");
  /** The selection's or the pins' names, opened from "list". */
  const [listed, setListed] = useState<"selection" | "pins" | null>(null);
  // Parts read by name, with the id on hover.
  const name = useMemo(() => partNamer(state.derived.parts), [state.derived.parts]);
  // Steps read by the plain names on screen, such as "Set Seat height".
  const look = useMemo(() => lookupOf(state), [state.design, state.derived]);
  const noKey = !state.has_key;

  const addFiles = async (files: Iterable<File>) => {
    const images = [...files].filter((f) => f.type.startsWith("image/") || f.type === "application/pdf");
    if (!images.length) return;
    try {
      const shrunk = await Promise.all(images.map((f) => (f.type === "application/pdf" ? readPdf(f) : shrink(f))));
      setPictures((p) => [...p, ...shrunk].slice(0, 4));
    } catch {
      setError("That picture couldn't be read");
    }
  };
  const end = useRef<HTMLDivElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const lastText = state.chat.at(-1);
  // What Claude is waiting on. The bar takes room from the log when it opens.
  const moments = waitingMoments(state);
  const waitKey = moments.map((m) => m.id).join(",");

  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [state.chat.length, lastText && "text" in lastText ? lastText.text.length : 0, waitKey]);

  // A log read to the end stays at the end when the bar, a selection line or
  // a picture takes room from it, so the newest card is never cut off.
  const atEnd = useRef(true);
  useEffect(() => {
    const el = log.current;
    if (!el) return;
    const keep = new ResizeObserver(() => {
      if (atEnd.current) el.scrollTop = el.scrollHeight;
    });
    keep.observe(el);
    return () => keep.disconnect();
  }, []);

  /** Sends a reply. Only words from the chat box clear it, so a button never throws away what you were typing. */
  const send = async (reply: Reply, fromBox: boolean) => {
    setError(null);
    const images = pictures.map(({ media_type, data }) => ({ media_type, data }));
    // When you're pointing at something, Claude also sees your view of it.
    const view = pointing && sendView ? captureView() : null;
    const r = await post("/api/chat", { ...reply, selection, images, pins, ...(view ? { view } : {}) });
    if (!r.ok) setError(r.error ?? "Couldn't send");
    else {
      if (fromBox) setText("");
      setPictures([]);
      onPins([]);
    }
  };
  /** Puts words in the chat box, ready to change before you send them. */
  const fill = (words: string) => {
    setText(words);
    requestAnimationFrame(() => {
      const el = box.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(words.length, words.length);
    });
  };

  // Words from elsewhere, such as Check's "Ask Claude to fix", land in the box ready to change.
  const filled = useRef(0);
  useEffect(() => {
    if (!fillFrom || fillFrom.n === filled.current) return;
    filled.current = fillFrom.n;
    fill(fillFrom.text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fillFrom?.n]);

  // Claude's waiting moments are answered from the bar or the chat box.
  const answer = (a: Answer) => {
    if ("see" in a) return onSee(a.see);
    const reply = buttonReply(a, text);
    if (reply) void send(reply, "change" in a);
    else box.current?.focus();
  };
  // While Claude works there's nothing waiting to answer, so the words go as a message it reads after its current step.
  const sendBox = () => {
    if (text.trim() && !noKey) void send(boxReply(text.trim(), moments), true);
  };
  const waitingOn = new Set(moments.map((m) => m.id));

  const previews = state.chat.filter((c): c is ChatItem & { kind: "preview" } => c.kind === "preview");
  // A run of your own edits shows as one line, and each of Claude's turns
  // folds its steps into its change line.
  const rows = useMemo(() => joinYourEdits(state.chat, state.history), [state.chat, state.history]);
  const folded = foldTurns(rows, { busy: state.busy, showThinking });
  const step = state.busy ? latestStep(rows) : null;
  const unread = notYetRead(state.chat);
  const empty = emptyChat(state);
  const selLine = selectionLine(selection, name);
  const pinLine = pinsLine(pins, name);

  /** One of your messages. One sent while Claude worked says so, and says once Claude has taken it in. */
  const renderSaid = (c: Extract<ChatItem, { kind: "user" }>) => {
    const note = duringNote(c);
    return (
      <div key={c.id} className={`msg user${c.during && !c.taken ? " unread" : ""}`}>
        {c.images && c.images.length > 0 && (
          <div className="pictures">
            {c.images.map((name) => (
              <a key={name} href={`/api/references/${name}`} target="_blank" rel="noreferrer">
                {name.endsWith(".pdf") ? <span className="pdf-chip">PDF spec sheet</span> : <img src={`/api/references/${name}`} alt="Your reference" />}
              </a>
            ))}
          </div>
        )}
        {c.text}
        {c.selection.length > 0 && <div className="sel-note" title={c.selection.join(", ")}>about {c.selection.map(name).join(", ")}</div>}
        {c.pins && c.pins.length > 0 && (
          <div className="sel-note">
            {c.pins.map((p) => (
              <span key={p.n} className="pin-chip" title={`${p.part}.${p.face}`}>
                pin {p.n}: {name(p.part)} ({p.face} face)
              </span>
            ))}
          </div>
        )}
        {c.view && (
          <a href={`/api/references/${c.view}`} target="_blank" rel="noreferrer">
            <img className="view-shot" src={`/api/references/${c.view}`} alt="Your view, sent with this message" />
          </a>
        )}
        {note && <div className="sel-note during-note">{note}</div>}
      </div>
    );
  };

  /** A folded step: a tool line, or Thinking. A step with a place on screen links to it. */
  const renderStep = (c: Row) => {
    if (c.kind === "thinking")
      return (
        <details key={c.id} className="thinking">
          <summary>Thinking</summary>
          {c.text}
        </details>
      );
    if (c.kind !== "tool") return null;
    const place = onStep ? placeOf(c) : null;
    return (
      <div key={c.id} className="tool">
        ·{" "}
        {place ? (
          <button type="button" className="link step-link" title={`Show where: ${c.summary}`} onClick={() => onStep!(place)}>
            {describe(place, look).words}
          </button>
        ) : (
          c.summary
        )}
      </div>
    );
  };

  /** A turn's steps, folded under its change line or a line of their own. */
  const renderFold = (f: Extract<Folded, { kind: "steps" }>) => {
    const open = opened.has(f.id);
    const undone = !!f.change && isUndone(f.change, state.history);
    const line = foldLine(f, state.history, open);
    const cut = line.lastIndexOf(" · ");
    // A finished turn with steps that show on screen can play them back.
    const how = onShowHow && !f.live ? f.steps.flatMap((s) => (s.kind === "tool" ? (placeOf(s) ?? []) : [])) : [];
    return (
      <details
        key={f.id}
        className={`steps-fold${f.change ? " change-line" : ""}${undone ? " undone" : ""}`}
        open={open}
        onToggle={(e) => {
          const now = e.currentTarget.open;
          setOpened((o) => {
            if (o.has(f.id) === now) return o;
            const next = new Set(o);
            if (now) next.add(f.id);
            else next.delete(f.id);
            return next;
          });
        }}
      >
        <summary title={f.change?.label}>
          {line.slice(0, cut)} · <span className="fold-verb">{line.slice(cut + 3)}</span>
          {how.length > 0 && (
            <>
              {" · "}
              <button
                type="button"
                className="link fold-how"
                title="Plays this turn's steps on screen, slowly, tab by tab. It changes nothing in the design, and any touch stops it."
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onShowHow!(how);
                }}
              >
                show me how
              </button>
            </>
          )}
        </summary>
        <div className="steps">{f.steps.map(renderStep)}</div>
        <label className="thinking-setting small">
          <input type="checkbox" checked={showThinking} onChange={(e) => setShowThinking(e.target.checked)} /> Show Claude's Thinking open in the
          chat, in this browser
        </label>
      </details>
    );
  };

  return (
    <div className="chat">
      <div
        className="chat-log"
        ref={log}
        onScroll={(e) => {
          const el = e.currentTarget;
          atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        {previews.length > 0 && (
          <div className="preview-jump">
            <select
              value=""
              aria-label="Go back to a preview Claude showed"
              onChange={(e) => {
                const id = e.target.value;
                if (!id) return;
                showInChat(id);
                onOpen({ kind: "preview", id });
              }}
            >
              <option value="">{`Previews Claude showed (${previews.length})…`}</option>
              {[...previews].reverse().map((p) => (
                <option key={p.id} value={p.id}>
                  {`${p.title} · ${p.status === "applied" ? "applied" : p.status === "proposed" ? "waiting" : "not applied"}`}
                </option>
              ))}
            </select>
          </div>
        )}
        {!state.has_key && (
          <div className="card warn-card">
            Claude isn't set up yet. Put your Anthropic API key in <code>.env</code> as <code>ANTHROPIC_API_KEY</code>, then restart the app. Everything
            else works without it.
          </div>
        )}
        {empty === "example" && <ExampleIntro disabled={noKey} onFix={() => fill(FIX_LP_CHECK)} />}
        {empty === "starters" && (
          <div className="empty starters">
            <p>{EMPTY_CHAT}</p>
            <div className="starter-list" aria-label="Starter ideas">
              {STARTERS.map((st) => (
                <button
                  key={st.label}
                  type="button"
                  disabled={noKey}
                  title={st.attach ? "Fills the chat box and opens the file picker for your photo or sketch" : "Fills the chat box, ready to change before you send it"}
                  onClick={() => {
                    const { text: words, attach } = starterFill(st);
                    fill(words);
                    if (attach) fileInput.current?.click();
                  }}
                >
                  {st.label}
                </button>
              ))}
            </div>
          </div>
        )}
        {folded.map((f) => {
          if (f.kind === "steps") return renderFold(f);
          const c = f.row;
          switch (c.kind) {
            case "user":
              return renderSaid(c);
            case "assistant":
              return (
                <div key={c.id} className="msg assistant">
                  <RichText text={c.text} />
                  {c.streaming && <span className="cursor">▍</span>}
                </div>
              );
            case "thinking":
              return (
                <details key={c.id} className="thinking" open={showThinking}>
                  <summary>Thinking</summary>
                  {c.text}
                </details>
              );
            case "tool":
              return (
                <div key={c.id} className={`tool ${c.is_error ? "bad" : ""}`}>
                  {c.is_error ? "✗ " : "· "}
                  {c.summary}
                  {c.image && (
                    <a className="sheet" href={`/api/renders/${c.image}`} target="_blank" rel="noreferrer">
                      <img src={`/api/renders/${c.image}`} alt="What Claude looked at" />
                    </a>
                  )}
                </div>
              );
            case "question":
              return (
                <div key={c.id} id={`chat-${c.id}`} className="card question">
                  <div className="card-title">Question</div>
                  <p>{c.question}</p>
                  {c.answered === undefined && c.options.length > 0 && <div className="muted small">Options: {c.options.join(" · ")}</div>}
                  {c.answered !== undefined && (
                    <div className="muted">
                      {c.answered_by ? "Your message sent while Claude worked was taken as the answer" : "You said"}: {c.answered}
                    </div>
                  )}
                  {waitingOn.has(c.id) && <WaitingNote />}
                </div>
              );
            case "plan":
              return <PlanCard key={c.id} item={c} live={waitingOn.has(c.id)} />;
            case "part":
              return (
                <PartCard key={c.id} id={`chat-${c.id}`} part={c.part}>
                  {waitingOn.has(c.id) ? (
                    <WaitingNote />
                  ) : c.status === "approved" ? (
                    <ApprovedPartStatus library={state.library} id={c.part.id} repo={state.repo} />
                  ) : (
                    <div className="muted small">{c.status === "changes_requested" ? "You asked for changes." : ""}</div>
                  )}
                </PartCard>
              );
            case "preview":
              return (
                <div key={c.id} id={`chat-${c.id}`} className="card preview-card">
                  <div className="card-title">Suggested change: {c.title}</div>
                  <p>{c.explanation}</p>
                  {c.status !== "proposed" && (
                    <div className="muted small">
                      {c.status === "applied" ? "Applied." : c.status === "failed" ? `Couldn't be applied: ${c.error ?? ""}` : "Not applied."}
                    </div>
                  )}
                  <button onClick={() => onOpen({ kind: "preview", id: c.id })}>{c.status === "proposed" ? "See it on the model" : "See it again"}</button>
                  {waitingOn.has(c.id) && <WaitingNote />}
                </div>
              );
            case "example":
              // One of the design's own joints pulls apart on the model; any other joint is a worked example in the drawer.
              return c.of ? (
                <div key={c.id} className="card example-card">
                  <div className="card-title">
                    {JOINT_LIBRARY[c.joint].name} <code>{c.of}</code>, pulled apart
                  </div>
                  {c.note && <p>{c.note}</p>}
                  <button onClick={() => onOpen({ kind: "example", joint: c.joint, of: c.of! })}>Pull it apart again</button>
                </div>
              ) : (
                <div key={c.id} className="card example-card">
                  <div className="card-title">Worked example: {c.stopped ? `Stopped ${JOINT_LIBRARY[c.joint].name.toLowerCase()}` : JOINT_LIBRARY[c.joint].name}</div>
                  {c.note && <p>{c.note}</p>}
                  <button onClick={() => onOpen({ kind: "example", joint: c.joint, ...(c.note ? { note: c.note } : {}), ...(c.stopped ? { stopped: true as const } : {}) })}>
                    Show me
                  </button>
                </div>
              );
            case "tool_request": {
              const r = state.tool_requests.find((x) => x.id === c.request);
              return r ? <MissingTool key={c.id} r={r} repo={state.repo} /> : null;
            }
            case "tool_built": {
              const r = state.tool_requests.find((x) => x.id === c.request);
              return r ? (
                <ToolBuilt
                  key={c.id}
                  r={r}
                  {...(c.pr_url ? { prUrl: c.pr_url } : {})}
                  busy={state.busy}
                  onCarryOn={() => void send({ text: `The ${r.name} tool is built now. Please carry on with what you couldn't do before.` }, false)}
                />
              ) : null;
            }
            case "your_edits": {
              const allUndone = c.undoneEdits >= c.edits;
              return c.labels.length === 1 ? (
                <div key={c.id} className={`change-line${allUndone ? " undone" : ""}`} title={c.labels[0]!.text}>
                  {changeLine("you", c.edits, c.undoneEdits)}
                </div>
              ) : (
                <details key={c.id} className={`change-line${allUndone ? " undone" : ""}`}>
                  <summary>{changeLine("you", c.edits, c.undoneEdits)}</summary>
                  <ul className="small">
                    {c.labels
                      .slice(-50)
                      .reverse()
                      .map((l, i) => (
                        <li key={i} className={l.undone ? "undone" : ""}>
                          {l.text}
                          {l.undone && <span className="muted"> (undone)</span>}
                        </li>
                      ))}
                  </ul>
                </details>
              );
            }
            case "change": {
              const undone = isUndone(c, state.history);
              return (
                <div key={c.id} className={`change-line${undone ? " undone" : ""}`} title={c.label}>
                  {changeLine(c.author, c.edits, undone ? c.edits : 0)}
                </div>
              );
            }
            case "summary":
              return (
                <div key={c.id} className="change-line" title="Claude still has a summary, and can search the whole chat when you refer back to it.">
                  Claude summarised the chat so far, to stay quick. Ask about anything earlier and it will look it up.
                </div>
              );
            case "error":
              return (
                <div key={c.id} className="msg error">
                  {c.text}
                </div>
              );
            case "usage": {
              const time = turnTime(c);
              return (
                time && (
                  <div key={c.id} className="turn-time" title={time.title}>
                    {time.line}
                  </div>
                )
              );
            }
          }
          return null;
        })}
        {state.busy && (
          <div className="working">
            Claude is working…{step && <span className="working-step"> {step}</span>}
          </div>
        )}
        {unread.map(renderSaid)}
        <div ref={end} />
      </div>

      <WaitingBar moments={moments} disabled={noKey || state.busy} onAnswer={answer} seeing={seeing} detail={previewDetail} />
      <form
        className="composer"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          void addFiles(e.dataTransfer.files);
        }}
        onSubmit={(e) => {
          e.preventDefault();
          sendBox();
        }}
      >
        {selLine && (
          <div className="pointing-line">
            <span className="pointing-text" title={selection.join(", ")}>
              {selLine.text}
            </span>
            {" · "}
            <button type="button" className="link" onClick={() => onSelect([])}>
              clear
            </button>
            {selLine.list.length > 0 && (
              <>
                {" · "}
                <button type="button" className="link" aria-expanded={listed === "selection"} onClick={() => setListed(listed === "selection" ? null : "selection")}>
                  {listed === "selection" ? "hide list" : "list"}
                </button>
              </>
            )}
            {listed === "selection" && selLine.list.length > 0 && (
              <ul className="pointing-list">
                {selection.map((id) => (
                  <li key={id} title={id}>
                    {name(id)}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {pinLine && (
          <div className="pointing-line">
            <span className="pointing-text">{pinLine.text}</span>
            {" · "}
            <button type="button" className="link" onClick={() => onPins([])}>
              clear
            </button>
            {pinLine.list.length > 0 && (
              <>
                {" · "}
                <button type="button" className="link" aria-expanded={listed === "pins"} onClick={() => setListed(listed === "pins" ? null : "pins")}>
                  {listed === "pins" ? "hide list" : "list"}
                </button>
              </>
            )}
            {listed === "pins" && pinLine.list.length > 0 && (
              <ul className="pointing-list">
                {pins.map((p, i) => (
                  <li key={p.n} title={`${p.part}.${p.face}`}>
                    {pinLine.list[i]}{" "}
                    <button type="button" className="link" title="Remove this pin" aria-label={`Remove pin ${p.n}`} onClick={() => onPins(pins.filter((x) => x.n !== p.n))}>
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {pointing && (
          <label className="chips view-toggle">
            <input type="checkbox" checked={sendView} onChange={(e) => setSendView(e.target.checked)} /> Send Claude a picture of my view
          </label>
        )}
        {error && <div className="form-error">{error}</div>}
        {pictures.length > 0 && (
          <div className="pictures">
            {pictures.map((p, i) => (
              <span key={i} className="picture">
                {p.media_type === "application/pdf" ? <span className="pdf-chip">PDF: {p.name}</span> : <img src={p.preview} alt="Attached picture" />}
                <button type="button" title="Remove" onClick={() => setPictures(pictures.filter((_, k) => k !== i))}>
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        {noKey && setup && <SetUpClaude />}
        <textarea
          ref={box}
          disabled={noKey}
          title={TIPS.chat}
          aria-keyshortcuts="Meta+K"
          onPaste={(e) => {
            const files = [...e.clipboardData.files];
            if (files.length) {
              e.preventDefault();
              void addFiles(files);
            }
          }}
          value={text}
          placeholder={
            compact
              ? noKey
                ? "Claude isn't set up yet"
                : state.busy
                  ? "Claude reads this after its step…"
                  : (boxPlaceholder(moments, true) ?? (state.derived.parts.length ? "Ask Claude to change…" : "Ask Claude to design…"))
              : noKey
                ? "Claude isn't set up yet, so the chat is off. Set up Claude to turn it on."
                : state.busy
                  ? "Claude is working. What you send reaches it after its current step."
                  : (boxPlaceholder(moments) ?? "Ask Claude to design or change something")
          }
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              sendBox();
            }
          }}
          rows={3}
        />
        <div className="composer-row">
          <span>
            <input
              ref={fileInput}
              type="file"
              accept="image/*,application/pdf"
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files) void addFiles(e.target.files);
                e.target.value = "";
              }}
            />
            <button type="button" disabled={pictures.length >= 4 || noKey} onClick={() => fileInput.current?.click()} title="Attach a photo, sketch or PDF spec sheet">
              Attach
            </button>{" "}
            <select
              className="model-pick"
              value={state.model}
              disabled={state.busy}
              title="Which Claude model this design's chat uses"
              onChange={async (e) => {
                const r = await post("/api/model", { model: e.target.value });
                if (!r.ok) setError(r.error ?? "Couldn't change the model");
              }}
            >
              {state.models.map((m) => (
                <option key={m.id} value={m.id} title={m.note}>
                  {m.label}
                </option>
              ))}
            </select>
          </span>
          {noKey ? (
            <button type="button" className="primary" aria-expanded={setup} onClick={() => setSetup(!setup)}>
              {setup ? "Hide the steps" : "Set up Claude"}
            </button>
          ) : (
            <>
              {/* A phone has room for one button, so it's Send once there are words, and Stop Claude while the box is empty. */}
              {state.busy && !(compact && text.trim()) && (
                <button
                  type="button"
                  className="stop-claude"
                  title={unread.length ? "Stops what Claude is doing. It then starts on what you sent that it hasn't read yet." : "Stops what Claude is doing"}
                  onClick={() => post("/api/chat/stop")}
                >
                  {compact ? "Stop Claude" : "Stop"}
                </button>
              )}
              {(!state.busy || !compact || text.trim()) && (
                <button className="primary" type="submit" disabled={!text.trim()} title={state.busy ? "Claude reads it after its current step" : undefined}>
                  Send
                </button>
              )}
            </>
          )}
        </div>
      </form>
    </div>
  );
}
