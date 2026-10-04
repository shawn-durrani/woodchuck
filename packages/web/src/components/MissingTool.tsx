// A tool Claude needs that the app doesn't have yet. The spec goes to
// Claude Code to build: filed as a GitHub issue, or copied to paste in.
// Filing acts on GitHub, so the button says so. Where it came up quotes your
// design, so it goes into the issue only when you tick the box for it. With
// no repository named, filing is off and the card says how to turn it on.

import { useState } from "react";
import { post, type ToolRequest } from "../api";
import { exampleConsent, TOOL_KEPT } from "../github";

/** The spec as a prompt you can paste into Claude Code. */
export function specForClaudeCode(r: ToolRequest): string {
  return [
    `In the woodchuck repo, build the missing tool "${r.name}" that Claude asked for in the app (tool request ${r.id}).`,
    "",
    `Why: ${r.purpose}`,
    `Where it came up: ${r.example}`,
    `Inputs: ${r.inputs}`,
    `What it changes: ${r.effect}`,
    `How to check it: ${r.check}`,
    ...(r.stopgap ? [`Meanwhile: ${r.stopgap}`] : []),
  ].join("\n");
}

export function MissingTool({ r, repo, compact = false }: { r: ToolRequest; repo: string | null; compact?: boolean }) {
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [filing, setFiling] = useState(false);
  const [withExample, setWithExample] = useState(false);
  const done = r.status === "built";
  return (
    <div className={`card missing-tool ${done ? "built" : ""}`}>
      <div className="card-title">
        {done ? "Tool built" : "Missing tool"}: {r.name} {r.count > 1 && <span className="muted small">asked {r.count}×</span>}
      </div>
      {!done && (
        <p className="small">
          Claude needs a tool the app doesn't have yet, so it stopped instead of guessing.{" "}
          {repo ? "File this spec as a GitHub issue for Claude Code to build, then ask Claude to carry on." : "Claude Code can build it from the spec."}
        </p>
      )}
      {done && (
        <p className="small">
          It's built and merged
          {r.pr_url && (
            <>
              {" "}
              (
              <a href={r.pr_url} target="_blank" rel="noreferrer noopener">
                PR #{r.pr_url.split("/").pop()}
              </a>
              )
            </>
          )}
          . Woodchuck has it once it's updated.
        </p>
      )}
      <p>{r.purpose}</p>
      {!compact && (
        <div className="small spec">
          <div>
            <strong>Where it came up:</strong> {r.example}
          </div>
          <div>
            <strong>Inputs:</strong> {r.inputs}
          </div>
          <div>
            <strong>What it changes:</strong> {r.effect}
          </div>
          <div>
            <strong>How to check it:</strong> {r.check}
          </div>
          {r.stopgap && (
            <div>
              <strong>Meanwhile:</strong> {r.stopgap}
            </div>
          )}
        </div>
      )}
      {!done && !r.issue_url && !repo && <p className="small muted github-off">{TOOL_KEPT}</p>}
      {!done && !r.issue_url && repo && (
        <label className="small consent">
          <input type="checkbox" checked={withExample} onChange={(e) => setWithExample(e.target.checked)} />
          {exampleConsent(repo)}
        </label>
      )}
      {!done && (
        <div className="row">
          {r.issue_url ? (
            <a href={r.issue_url} target="_blank" rel="noreferrer noopener">
              Filed on GitHub for Claude Code as {r.issue_url.split("/").slice(-2).join(" #").replace("issues #", "issue #")}
            </a>
          ) : (
            repo && (
              <button
                className="primary"
                disabled={filing}
                title={`Opens an issue on ${repo} with this spec, for Claude Code to build`}
                onClick={async () => {
                  setFiling(true);
                  const res = await post("/api/tool-requests/issue", { id: r.id, include_example: withExample });
                  setFiling(false);
                  setError(res.ok ? null : (res.error ?? "Couldn't file it on GitHub"));
                }}
              >
                {filing ? "Filing on GitHub…" : "File as a GitHub issue for Claude Code"}
              </button>
            )
          )}
          <button
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(specForClaudeCode(r));
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              } catch {
                setError("Couldn't copy; select the spec above instead");
              }
            }}
          >
            {copied ? "Copied" : "Copy the spec"}
          </button>
        </div>
      )}
      {error && <div className="form-error">{error}</div>}
    </div>
  );
}

/** Shown in the chat once a tool this design asked for is built and merged. */
export function ToolBuilt({ r, prUrl, busy, onCarryOn }: { r: ToolRequest; prUrl?: string; busy: boolean; onCarryOn: () => void }) {
  return (
    <div className="card missing-tool built">
      <div className="card-title">Tool built: {r.name}</div>
      <p className="small">
        The tool Claude asked for is built and merged
        {prUrl && (
          <>
            {" "}
            (
            <a href={prUrl} target="_blank" rel="noreferrer noopener">
              PR #{prUrl.split("/").pop()}
            </a>
            )
          </>
        )}
        . Once Woodchuck is updated, Claude can use it, and it hears about it with your next message.
      </p>
      <button className="primary" disabled={busy} onClick={onCarryOn}>
        Ask Claude to carry on
      </button>
    </div>
  );
}
