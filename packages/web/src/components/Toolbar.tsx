// The toolbar over the model, drawn from the model in toolbar.ts: Tools,
// View and Share, in one row. Its menus are the phone layout's menus too.
// Narrower than 1000 px it folds into four buttons: Select, Fit, Look and
// Share, with the tools, the camera views, See-through and Explode in the
// menus.

import type { CameraView, Look, PointMode } from "./Viewport";
import type { Lighting } from "../lighting";
import { cameraMenu, compactToolbar, lookMenu, shareMenu, toolbar, type Control, type Mode, type ToolbarState } from "../toolbar";
import { Menu, MenuChoice, MenuDivider, MenuItem, MenuSection } from "./Menu";

export type ToolbarMenu = "tools" | "camera" | "look" | "share" | null;

export interface ToolbarActions {
  onTool: (t: PointMode) => void;
  onCamera: (v: CameraView) => void;
  onFit: () => void;
  onSeeThrough: () => void;
  onExplode: () => void;
  onLook: (l: Look) => void;
  onLighting: (l: Lighting) => void;
  onMode: (m: Mode) => void;
  onRender: () => void;
  onPhoto: () => void;
  onFull: () => void;
  onDrawings: () => void;
}

const after = (id: string) => id.slice(id.indexOf(".") + 1);

/** A plain toolbar button. Disabled, it keeps its place and its tooltip says why. */
function Button({ c, onClick, toggle = false }: { c: Control; onClick: () => void; toggle?: boolean }) {
  return (
    <button
      type="button"
      className={c.on ? "on" : ""}
      aria-pressed={toggle ? !!c.on : undefined}
      aria-disabled={c.disabled || undefined}
      aria-keyshortcuts={c.key && c.key.length === 1 ? c.key : undefined}
      data-control={c.id}
      title={c.tip}
      onClick={() => !c.disabled && onClick()}
    >
      {c.label}
    </button>
  );
}

export function Toolbar({
  state,
  menu,
  onMenu,
  compact = false,
  ...a
}: { state: ToolbarState; menu: ToolbarMenu; onMenu: (m: ToolbarMenu) => void; compact?: boolean } & ToolbarActions) {
  if (compact) return <CompactToolbar state={state} menu={menu} onMenu={onMenu} {...a} />;
  const groups = toolbar(state);
  const [tools, view, share] = groups as [(typeof groups)[0], (typeof groups)[0], (typeof groups)[0]];
  const byId = new Map(view.controls.map((c) => [c.id, c]));
  const camera = byId.get("camera")!;
  const fit = byId.get("fit")!;
  const seeThrough = byId.get("see-through")!;
  const explode = byId.get("explode")!;
  const look = byId.get("look")!;
  const shareButton = share.controls[0]!;
  const opener = (m: Exclude<ToolbarMenu, null>) => (open: boolean) => onMenu(open ? m : null);
  const pick = (fn: () => void) => () => {
    onMenu(null);
    fn();
  };
  return (
    <div className="toolbar" role="toolbar" aria-label="Tools, view and share">
      <div className="tb-group tb-tools" role="group" aria-label={tools.label}>
        <div className="seg">
          {tools.controls.map((c) => (
            <Button key={c.id} c={c} toggle onClick={() => a.onTool(after(c.id) as PointMode)} />
          ))}
        </div>
      </div>
      <div className="tb-group tb-view" role="group" aria-label={view.label}>
        <Menu id="camera-menu" label={camera.label} title={camera.tip} disabled={camera.disabled} open={menu === "camera"} onOpen={opener("camera")} control="camera" triggerClass="tb-camera">
          {cameraMenu(state).map((c) => (
            <MenuItem key={c.id} kind="radio" checked={!!c.on} hint={c.key!} title={c.tip} control={c.id} disabled={c.disabled} onSelect={pick(() => a.onCamera(after(c.id) as CameraView))}>
              {c.label}
            </MenuItem>
          ))}
        </Menu>
        <Button c={fit} onClick={a.onFit} />
        <Button c={seeThrough} toggle onClick={a.onSeeThrough} />
        <Button c={explode} toggle onClick={a.onExplode} />
        <Menu id="look-menu" label={look.label} title={look.tip} open={menu === "look"} onOpen={opener("look")} control="look" className="look-menu" align="right">
          {lookMenu(state).map((s) => (
            <MenuSection key={s.id} label={s.label} {...(s.note ? { note: s.note } : {})}>
              {s.items.map((c) => (
                <MenuChoice
                  key={c.id}
                  checked={!!c.on}
                  disabled={c.disabled}
                  title={c.tip}
                  control={c.id}
                  onSelect={() => {
                    const v = after(c.id);
                    if (s.id === "look") a.onLook(v as Look);
                    else if (s.id === "lighting") a.onLighting(v as Lighting);
                    // Switching between 3D and the drawings is a bigger step, so the menu gets out of the way.
                    else pick(() => a.onMode(v as Mode))();
                  }}
                >
                  {c.label}
                </MenuChoice>
              ))}
            </MenuSection>
          ))}
        </Menu>
      </div>
      <div className="tb-group tb-share" role="group" aria-label={share.label}>
        <Menu id="share-menu" label={shareButton.label} title={shareButton.tip} open={menu === "share"} onOpen={opener("share")} control="share" align="right">
          <ShareItems state={state} pick={pick} a={a} />
        </Menu>
      </div>
    </div>
  );
}

/** The Share menu's items, the same in both toolbars. */
function ShareItems({ state, pick, a }: { state: ToolbarState; pick: (fn: () => void) => () => void; a: ToolbarActions }) {
  return (
    <>
      {shareMenu(state).map((c) => (
        <MenuItem
          key={c.id}
          kind={c.on === undefined ? "action" : "check"}
          checked={!!c.on}
          disabled={c.disabled}
          title={c.tip}
          control={c.id}
          {...(c.id === "share.drawings" ? { aside: state.paper } : {})}
          onSelect={pick({ "share.render": a.onRender, "share.photo": a.onPhoto, "share.full": a.onFull, "share.drawings": a.onDrawings }[c.id]!)}
        >
          {c.label}
        </MenuItem>
      ))}
    </>
  );
}

/**
 * The four-button toolbar for a phone or a narrow window: Select, Fit, Look
 * and Share. Select's menu holds the four tools and shows the one that's
 * on. Look's menu adds the camera views, See-through and Explode to its
 * own.
 */
function CompactToolbar({ state, menu, onMenu, ...a }: { state: ToolbarState; menu: ToolbarMenu; onMenu: (m: ToolbarMenu) => void } & ToolbarActions) {
  const [tools, fit, look, share] = compactToolbar(state) as [Control, Control, Control, Control];
  const all = toolbar(state);
  const seeThrough = all[1]!.controls.find((c) => c.id === "see-through")!;
  const explode = all[1]!.controls.find((c) => c.id === "explode")!;
  const opener = (m: Exclude<ToolbarMenu, null>) => (open: boolean) => onMenu(open ? m : null);
  const pick = (fn: () => void) => () => {
    onMenu(null);
    fn();
  };
  const [lookSection, lighting, views] = lookMenu(state);
  const choices = (s: NonNullable<typeof lookSection>, on: (v: string) => void) => (
    <MenuSection key={s.id} label={s.label} {...(s.note ? { note: s.note } : {})}>
      {s.items.map((c) => (
        <MenuChoice key={c.id} checked={!!c.on} disabled={c.disabled} title={c.tip} control={c.id} onSelect={() => on(after(c.id))}>
          {c.label}
        </MenuChoice>
      ))}
    </MenuSection>
  );
  return (
    <div className="toolbar compact-toolbar" role="toolbar" aria-label="Tools, view and share">
      <Menu id="tool-menu" label={tools.label} title={tools.tip} disabled={tools.disabled} open={menu === "tools"} onOpen={opener("tools")} control={tools.id} className="tool-menu">
        {all[0]!.controls.map((c) => (
          <MenuItem key={c.id} kind="radio" checked={!!c.on} hint={c.key!} title={c.tip} control={c.id} disabled={c.disabled} onSelect={pick(() => a.onTool(after(c.id) as PointMode))}>
            {c.label}
          </MenuItem>
        ))}
      </Menu>
      <Button c={fit} onClick={a.onFit} />
      <Menu id="look-menu" label={look.label} title={look.tip} open={menu === "look"} onOpen={opener("look")} control={look.id} className="look-menu" align="right">
        {choices(lookSection!, (v) => a.onLook(v as Look))}
        {choices(lighting!, (v) => a.onLighting(v as Lighting))}
        <MenuSection label="Camera" wide>
          {cameraMenu(state).map((c) => (
            <MenuChoice key={c.id} checked={!!c.on} disabled={c.disabled} title={c.tip} control={c.id} onSelect={pick(() => a.onCamera(after(c.id) as CameraView))}>
              {c.label}
            </MenuChoice>
          ))}
        </MenuSection>
        <MenuDivider />
        <MenuItem kind="check" checked={!!seeThrough.on} disabled={seeThrough.disabled} title={seeThrough.tip} control={seeThrough.id} onSelect={pick(a.onSeeThrough)}>
          {seeThrough.label}
        </MenuItem>
        <MenuItem kind="check" checked={!!explode.on} disabled={explode.disabled} title={explode.tip} control={explode.id} onSelect={pick(a.onExplode)}>
          {explode.label}
        </MenuItem>
        {choices(views!, (v) => pick(() => a.onMode(v as Mode))())}
      </Menu>
      <Menu id="share-menu" label={share.label} title={share.tip} open={menu === "share"} onOpen={opener("share")} control={share.id} align="right">
        <ShareItems state={state} pick={pick} a={a} />
      </Menu>
    </div>
  );
}
