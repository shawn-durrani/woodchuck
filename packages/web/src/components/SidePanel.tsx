// The side panel: five tabs for the open design, and one page for
// everything outside it. Edit holds the part you picked over the sizes,
// Make the drawings, the cut list and the cut layout, Check the problems
// with ways to fix each one, and History every change and version in one
// list. Designs, the parts library, missing tools and your workshop share
// the All designs and parts page, opened from the design menu.

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Issue, JointType, Rule, Severity } from "@woodchuck/core";
import { applyOps, post, type ServerState } from "../api";
import { fixesFor, problemWords } from "../checkFixes";
import type { PreviewResult } from "../ghost";
import { historyRows, type HistoryRow } from "../historyList";
import { partNamer } from "../names";
import { savedNote } from "../signals";
import { ALL_SECTIONS, checkCount, MAKE_VIEWS, TABS, waitingIn, type MakeView, type Section, type Tab } from "../tabs";
import { WAIT_FOR_CLAUDE, type Paper } from "../toolbar";
import { CutLayoutPanel } from "./CutLayout";
import { DesignsPanel } from "./DesignsPanel";
import { Inspector } from "./Inspector";
import { LibraryPanel } from "./LibraryPanel";
import { CutListPanel, DrawingsLink, ParamsPanel, RequestsPanel } from "./Panels";
import { WorkshopPanel } from "./WorkshopPanel";

/** The five tabs along the top of the side panel. Check carries its count of problems. */
export function TabBar({ tab, onTab, report }: { tab: Tab; onTab: (t: Tab) => void; report: ServerState["report"] }) {
  const count = checkCount(report);
  return (
    <nav className="tabs five-tabs" role="tablist" aria-label="The open design">
      {TABS.map((t) => (
        <button key={t.id} role="tab" data-tab={t.id} aria-selected={tab === t.id} className={tab === t.id ? "on" : ""} title={t.tip} onClick={() => onTab(t.id)}>
          {t.label}
          {t.id === "check" && count && (
            <span className={`tab-count ${count.tone}`} aria-label={`, ${count.n} problem${count.n === 1 ? "" : "s"}`}>
              {count.n}
            </span>
          )}
        </button>
      ))}
    </nav>
  );
}

/** Edit: the part you picked, over the design's sizes. With nothing picked, the sizes alone. */
export function EditTab({
  state,
  selection,
  onSelect,
  onShowJoint,
  onDraft,
}: {
  state: ServerState;
  selection: string[];
  onSelect: (ids: string[]) => void;
  onShowJoint: (type: JointType) => void;
  /** Hears a change to a cut while you type it, so the model can draw it as a ghost. */
  onDraft?: (r: PreviewResult | null) => void;
}) {
  const picked = selection.length > 0;
  return (
    <div className="panel-body edit-tab">
      {picked && (
        <Inspector
          design={state.design}
          parts={state.derived.parts}
          joints={state.derived.joints}
          selection={selection}
          onShowJoint={onShowJoint}
          onSelect={onSelect}
          now={state}
          onDraft={onDraft}
        />
      )}
      <div className={`section-head${picked ? " under-part" : ""}`}>
        <h3>Sizes</h3>
        {!picked && <span className="muted small">Click a part in the model or the cut list to edit it here.</span>}
      </div>
      <ParamsPanel state={state} />
    </div>
  );
}

/** Make: the drawings, the paper and the CSV at the top, then the cut list or the cut layout. */
export function MakeTab({
  state,
  view,
  onView,
  paper,
  onPaper,
  onSaved,
  onSelect,
}: {
  state: ServerState;
  view: MakeView;
  onView: (v: MakeView) => void;
  paper: Paper;
  onPaper: (p: Paper) => void;
  onSaved: (text: string) => void;
  onSelect: (ids: string[]) => void;
}) {
  const empty = state.cutlist.rows.length === 0;
  return (
    <div className="make-tab">
      <div className="make-head">
        <div className="make-downloads">
          <DrawingsLink slug={state.project.slug} paper={paper} onPaper={onPaper} onSaved={onSaved} big empty={empty} />
          {empty ? (
            <button disabled title="Nothing to cut yet. Ask Claude to build something first.">
              Download CSV
            </button>
          ) : (
            <a className="button" href="/api/cutlist.csv" title="The cut list as a spreadsheet" onClick={() => onSaved(savedNote("the cut list", `${state.project.slug}-cut-list.csv`))}>
              Download CSV
            </a>
          )}
        </div>
        <div className="seg" role="radiogroup" aria-label="The cut list or the cut layout">
          {MAKE_VIEWS.map((v) => (
            <button key={v.id} role="radio" aria-checked={view === v.id} className={view === v.id ? "on" : ""} data-place={`make:${v.id}`} onClick={() => onView(v.id)}>
              {v.label}
            </button>
          ))}
        </div>
      </div>
      {view === "list" ? <CutListPanel state={state} onSelect={onSelect} /> : <CutLayoutPanel state={state} onSelect={onSelect} />}
    </div>
  );
}

/** Check: whether the design is ready to cut, and each problem with ways to fix it. */
export function CheckTab({ state, onShowMe, onAsk }: { state: ServerState; onShowMe: (ids: string[]) => void; onAsk: (text: string) => void }) {
  const { issues, ready_to_cut } = state.report;
  const name = useMemo(() => partNamer(state.derived.parts), [state.derived.parts]);
  return (
    <div className="panel-body check-tab">
      <div className={`ready ${ready_to_cut ? "ok" : "no"}`}>{ready_to_cut ? "Ready to cut: every check passes." : "Not ready to cut yet."}</div>
      {issues.length === 0 && <div className="empty">No problems found.</div>}
      {issues.map((i) => (
        <Problem key={i.key} issue={i} state={state} name={name} onShowMe={onShowMe} onAsk={onAsk} />
      ))}
    </div>
  );
}

function Problem({
  issue,
  state,
  name,
  onShowMe,
  onAsk,
}: {
  issue: Issue;
  state: ServerState;
  name: (id: string) => string;
  onShowMe: (ids: string[]) => void;
  onAsk: (text: string) => void;
}) {
  const fixes = useMemo(() => fixesFor(issue, state.design, state.derived.parts, name), [issue, state.design, state.derived.parts, name]);
  const [editing, setEditing] = useState(false);
  const { text, rule } = problemWords(issue.message);
  const canShow = fixes.show.length > 0;
  const show = () => canShow && onShowMe(fixes.show);
  return (
    <div className={`issue ${issue.severity}${canShow ? "" : " nothing-to-show"}`} data-place={fixes.rule ? `rule:${fixes.rule.id}` : undefined} onClick={show}>
      <div>
        {text}
        {rule && <span className="muted small"> rule {rule}</span>}
      </div>
      {issue.trace && (
        <details className="issue-working" onClick={(e) => e.stopPropagation()}>
          <summary className="small">Show the working</summary>
          <div className="trace">{issue.trace}</div>
        </details>
      )}
      <div className="issue-fixes" onClick={(e) => e.stopPropagation()}>
        <button
          className="primary"
          disabled={!state.has_key}
          title={state.has_key ? "Puts a request to fix this in the chat box, ready to change before you send it" : "Set up Claude first, from the chat box"}
          onClick={() => onAsk(fixes.ask)}
        >
          Ask Claude to fix
        </button>
        <button
          disabled={!canShow}
          title={canShow ? `Picks and frames ${fixes.show.length === 1 ? name(fixes.show[0]!) : `the ${fixes.show.length} parts`}${fixes.rule ? " the rule reads" : ""}` : "This problem doesn't name any parts"}
          onClick={show}
        >
          Show me
        </button>
        {fixes.rule && (
          <button aria-expanded={editing} title={`Change what the rule ${fixes.rule.id} checks`} onClick={() => setEditing(!editing)}>
            Edit the rule
          </button>
        )}
      </div>
      {editing && fixes.rule && <RuleEditor rule={fixes.rule} onDone={() => setEditing(false)} />}
    </div>
  );
}

/** One of the design's rules, opened to change what it checks, what it says and how serious it is. */
function RuleEditor({ rule, onDone }: { rule: Rule; onDone: () => void }) {
  const [message, setMessage] = useState(rule.message);
  const [expr, setExpr] = useState(rule.expr);
  const [severity, setSeverity] = useState<Severity>(rule.severity);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const unchanged = message.trim() === rule.message && expr.trim() === rule.expr && severity === rule.severity;
  const save = async () => {
    setSaving(true);
    const r = await applyOps([{ op: "set_rule", id: rule.id, expr: expr.trim(), severity, message: message.trim() }], `Change the rule ${rule.id}`);
    setSaving(false);
    if (r.ok) onDone();
    else setError(r.error ?? "That rule wasn't taken");
  };
  return (
    <form
      className="rule-edit"
      aria-label={`The rule ${rule.id}`}
      onClick={(e) => e.stopPropagation()}
      onSubmit={(e) => {
        e.preventDefault();
        if (!unchanged) void save();
      }}
    >
      <label>
        What it says
        <input value={message} onChange={(e) => setMessage(e.target.value)} />
      </label>
      <label>
        What it checks
        <input className="expr" value={expr} aria-invalid={!!error || undefined} onChange={(e) => setExpr(e.target.value)} />
      </label>
      <label>
        When it fails
        <select value={severity} onChange={(e) => setSeverity(e.target.value as Severity)}>
          <option value="error">An error, so it's not ready to cut</option>
          <option value="warning">A warning</option>
        </select>
      </label>
      {error && (
        <div className="form-error field-error" role="alert">
          {error}
        </div>
      )}
      <div className="row">
        <button type="submit" className="primary" disabled={saving || unchanged || !expr.trim() || !message.trim()}>
          {saving ? "Saving…" : "Save the rule"}
        </button>
        <button type="button" onClick={onDone}>
          Cancel
        </button>
      </div>
      <p className="muted small">It names sizes, such as shelf_top, and part faces, such as rail_front_top.bottom. Saving it is a change you can undo.</p>
    </form>
  );
}

/** History: Undo and Redo, then every change set and version, newest first. */
export function HistoryTab({ state }: { state: ServerState }) {
  const rows = useMemo(() => historyRows(state.history, state.versions), [state.history, state.versions]);
  return (
    <div className="panel-body history-tab">
      <div className="row">
        <button disabled={!state.history.length || state.busy} title={state.busy ? WAIT_FOR_CLAUDE : undefined} onClick={() => post("/api/undo")}>
          Undo last change
        </button>
        <button disabled={!state.redo || state.busy} title={state.busy ? WAIT_FOR_CLAUDE : undefined} onClick={() => post("/api/redo")}>
          Redo
        </button>
      </div>
      <p className="muted small">
        Every change you or Claude make is kept as a version, in a git history on the computer running Woodchuck. Restoring one is a change you can undo. Duplicate,
        Download and Open a file are in the design menu, on the design's name.
      </p>
      {rows.length === 0 ? (
        <div className="empty">No changes yet.</div>
      ) : (
        <ol className="versions">
          {rows.map((r) => (
            <HistoryItem key={r.key} row={r} busy={state.busy} />
          ))}
        </ol>
      )}
    </div>
  );
}

function HistoryItem({ row, busy }: { row: HistoryRow; busy: boolean }) {
  const [lines, setLines] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // In the viewer's own language and date order.
  const when = new Date(row.at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  return (
    <li className="version">
      <div>
        <span className={`who ${row.whoClass}`}>{row.who}</span> {row.label}
        {row.latest && <span className="badge">now</span>}
      </div>
      <div className="row">
        <span className="muted small" title={row.session ? "A change from this session, which Undo can take back" : undefined}>
          {when}
        </span>
        {row.sha && (
          <span>
            <button
              className="link"
              onClick={async () => {
                if (lines) return setLines(null);
                const r = await fetch(`/api/versions/diff?sha=${row.sha}`);
                const body = (await r.json()) as { lines?: string[]; error?: string };
                if (r.ok) setLines(body.lines ?? []);
                else setError(body.error ?? "Couldn't compare");
              }}
            >
              {lines ? "Hide" : "What changed"}
            </button>
            {!row.latest && (
              <button
                className="link"
                disabled={busy}
                title={busy ? WAIT_FOR_CLAUDE : undefined}
                onClick={async () => {
                  if (!confirm(`Go back to the version from ${when}? It's a change you can undo.`)) return;
                  const r = await post("/api/versions/restore", { sha: row.sha });
                  if (!r.ok) setError(r.error ?? "Couldn't restore");
                }}
              >
                Restore
              </button>
            )}
          </span>
        )}
      </div>
      {lines && (
        <ul className="small">
          {lines.length ? lines.map((l) => <li key={l}>{l}</li>) : <li className="muted">No change to the design itself</li>}
        </ul>
      )}
      {error && <div className="form-error">{error}</div>}
    </li>
  );
}

/** The All designs and parts page, over the side panel: designs, the parts library, missing tools and your workshop. */
export function AllPage({ state, section, onClose }: { state: ServerState; section: Section | null; onClose: () => void }) {
  const waiting = waitingIn(state);
  const head = useRef<HTMLHeadingElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const jump = (s: Section, smooth = true) => document.getElementById(`all-${s}`)?.scrollIntoView({ block: "start", behavior: smooth ? "smooth" : "auto" });
  useEffect(() => {
    head.current?.focus();
    if (!section) return;
    jump(section, false);
    // The lists above it fill in as they load, which would push the section down.
    // It stays in view while they do, for a moment, or until you scroll yourself.
    const el = body.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const sizes = new ResizeObserver(() => jump(section, false));
    for (const child of Array.from(el.children)) sizes.observe(child);
    const letGo = () => sizes.disconnect();
    const timer = setTimeout(letGo, 2000);
    for (const type of ["wheel", "touchstart", "keydown", "pointerdown"]) el.addEventListener(type, letGo, { once: true, passive: true });
    return () => {
      clearTimeout(timer);
      letGo();
      for (const type of ["wheel", "touchstart", "keydown", "pointerdown"]) el.removeEventListener(type, letGo);
    };
  }, [section]);
  const needs = (n: number): ReactNode => (n ? <span className="badge warn">{`${n} need${n === 1 ? "s" : ""} you`}</span> : null);
  return (
    <section className="all-page" aria-label="All designs and parts">
      <header className="all-head">
        <h2 ref={head} tabIndex={-1}>
          All designs and parts
        </h2>
        <button className="link" title="Back to the design's tabs (Esc)" onClick={onClose}>
          Close
        </button>
      </header>
      <nav className="all-jump" aria-label="Sections">
        {ALL_SECTIONS.map((s) => (
          <button key={s.id} className="link small" onClick={() => jump(s.id)}>
            {s.label}
            {needs(waiting[s.id])}
          </button>
        ))}
      </nav>
      <div className="panel-body all-body" ref={body}>
        {ALL_SECTIONS.map((s) => (
          <section key={s.id} id={`all-${s.id}`} className="all-section" aria-label={s.label}>
            <h3>
              {s.label}
              {needs(waiting[s.id])}
            </h3>
            {s.id === "designs" ? (
              <DesignsPanel state={state} />
            ) : s.id === "library" ? (
              <LibraryPanel state={state} />
            ) : s.id === "tools" ? (
              <RequestsPanel state={state} />
            ) : (
              <WorkshopPanel />
            )}
          </section>
        ))}
      </div>
    </section>
  );
}
