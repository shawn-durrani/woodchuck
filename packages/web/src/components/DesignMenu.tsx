// The design's name in the top bar, which opens the design menu. Rename
// edits the name where it sits. Open… shows the other designs, starred
// first. Delete design… comes last and asks first.

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ServerState } from "../api";
import type { Section } from "../tabs";
import { DESIGN_MENU, DOWNLOAD_URL, WAITS_FOR_CLAUDE, deleteQuestion, designActions, designItem, needsYou, openDesignFile } from "../designMenu";
import { savedNote } from "../signals";
import { WAIT_FOR_CLAUDE } from "../toolbar";
import { ordered } from "./DesignsPanel";
import { Menu, MenuDivider, MenuItem } from "./Menu";

type Result = { ok: boolean; error?: string };

export function DesignMenu({
  state,
  open,
  onOpen,
  onResult,
  onSwitched,
  onShowAll,
  onSaved,
  extra = null,
}: {
  state: ServerState;
  open: boolean;
  onOpen: (open: boolean) => void;
  /** How an action went, so a failure shows under the menu. */
  onResult: (r: Result) => void;
  /** Another design is open now, so what was picked in the last one goes. */
  onSwitched: () => void;
  /** Opens the All designs and parts page over the side panel, at a section if one is given. */
  onShowAll: (section?: Section) => void;
  onSaved: (text: string) => void;
  /** More at the foot of the menu, such as the Theme menu on a phone, whose top bar has no room for it. */
  extra?: ReactNode;
}) {
  const [renaming, setRenaming] = useState(false);
  const [list, setList] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const name = state.design.name;
  const slug = state.project.slug;
  const starred = state.projects.find((p) => p.slug === slug)?.starred ?? false;
  const waiting = needsYou(state);
  // The menu opens on its main list every time.
  useEffect(() => {
    if (!open) setList(false);
  }, [open]);

  const run = async (call: () => Promise<Result>, switches = true) => {
    onOpen(false);
    const r = await call();
    if (r.ok && switches) onSwitched();
    onResult(r);
  };
  const act: Record<(typeof DESIGN_MENU)[number] & string, () => void> = {
    rename: () => {
      onOpen(false);
      setRenaming(true);
    },
    open: () => setList(true),
    new: () => void run(designActions.startFresh),
    duplicate: () => void run(designActions.duplicate),
    download: () => {
      onOpen(false);
      const a = document.createElement("a");
      a.href = DOWNLOAD_URL;
      a.click();
      onSaved(savedNote("this design", `${slug}.woodchuck.json`));
    },
    import: () => {
      onOpen(false);
      file.current?.click();
    },
    star: () => void run(() => designActions.star(slug, !starred), false),
    all: () => {
      onOpen(false);
      onShowAll();
    },
    workshop: () => {
      onOpen(false);
      onShowAll("workshop");
    },
    example: () => void run(designActions.example),
    delete: () => {
      onOpen(false);
      if (confirm(deleteQuestion(state.project.name))) void run(() => designActions.remove(slug));
    },
    "-": () => {},
  };

  if (renaming) return <RenameBox name={name} onDone={(r) => (setRenaming(false), r && onResult(r))} />;

  return (
    <>
      <Menu
        id="design-menu"
        open={open}
        onOpen={onOpen}
        title="The design menu: rename, open, start fresh, duplicate, download, star or delete"
        triggerClass="design-trigger"
        control="design"
        label={
          <>
            <span className="design-title">{name}</span>
            {waiting > 0 && <span className="needs-dot" title={`${waiting} part${waiting === 1 ? "" : "s"} or tool${waiting === 1 ? "" : "s"} need${waiting === 1 ? "s" : ""} you`} />}
          </>
        }
      >
        {list ? (
          <>
            <MenuItem onSelect={() => setList(false)} title="Back to the design menu">
              ‹ Back
            </MenuItem>
            <MenuDivider />
            <div className="menu-scroll">
              {ordered(state.projects).map((p) => (
                <MenuItem
                  key={p.slug}
                  disabled={p.slug === slug || state.busy}
                  checked={p.slug === slug}
                  title={p.slug === slug ? "This design is open" : state.busy ? WAIT_FOR_CLAUDE : `Open ${p.name}`}
                  onSelect={() => void run(() => designActions.open(p.slug))}
                  {...(p.starred ? { aside: "★" } : {})}
                >
                  {p.name}
                </MenuItem>
              ))}
            </div>
          </>
        ) : (
          DESIGN_MENU.map((id, i) => {
            if (id === "-") return <MenuDivider key={`-${i}`} />;
            const { label, tip } = designItem(id, starred);
            const held = state.busy && WAITS_FOR_CLAUDE.has(id);
            return (
              <MenuItem
                key={id}
                control={`design.${id}`}
                danger={id === "delete"}
                disabled={held}
                title={held ? WAIT_FOR_CLAUDE : tip}
                onSelect={act[id]}
                {...(id === "all" && waiting ? { badge: `${waiting} need${waiting === 1 ? "s" : ""} you` } : {})}
              >
                {label}
              </MenuItem>
            );
          })
        )}
        {!list && extra && (
          <>
            <MenuDivider />
            <div className="menu-extra">{extra}</div>
          </>
        )}
      </Menu>
      <input
        ref={file}
        type="file"
        accept=".json,application/json"
        hidden
        onChange={async (e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (!f) return;
          const r = await openDesignFile(await f.text());
          if (r.ok) onSwitched();
          onResult(r);
        }}
      />
    </>
  );
}

/** The name as a text box, where it sat. Enter or leaving it saves, and Esc puts the name back. */
function RenameBox({ name, onDone }: { name: string; onDone: (r: Result | null) => void }) {
  const [value, setValue] = useState(name);
  const done = useRef(false);
  const finish = async (save: boolean) => {
    if (done.current) return;
    done.current = true;
    const next = value.trim();
    onDone(save && next && next !== name ? await designActions.rename(next) : null);
  };
  return (
    <input
      className="design-rename"
      aria-label="The design's name"
      autoFocus
      value={value}
      onFocus={(e) => e.target.select()}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => void finish(true)}
      onKeyDown={(e) => {
        if (e.key === "Enter") void finish(true);
        if (e.key === "Escape") void finish(false);
      }}
    />
  );
}
