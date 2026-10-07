// The app's link to the local server: one WebSocket for live state and a
// few JSON calls for changes.

import { useEffect, useRef, useState } from "react";
import type { CheckReport, CutList, Derived, Design, JointType, LibraryPart, Op, Plan, ViewCommand } from "@woodchuck/core";
import { lockEvents } from "./lock";

export type Author = "you" | "claude" | "example";

export type ChatItem =
  | {
      id: string;
      kind: "user";
      text: string;
      selection: string[];
      images?: string[];
      pins?: { n: number; part: string; face: string; point_mm: [number, number, number] }[];
      view?: string;
      /** Sent while Claude was working. */
      during?: true;
      /** When Claude took it in: after a step, or by starting its next turn with it. */
      taken?: "step" | "turn";
      at: string;
    }
  | { id: string; kind: "assistant"; text: string; at: string; streaming?: boolean }
  | { id: string; kind: "thinking"; text: string; at: string }
  | { id: string; kind: "tool"; name: string; summary: string; is_error: boolean; image?: string; at: string }
  | { id: string; kind: "question"; question: string; options: string[]; answered?: string; answered_by?: string; at: string }
  | { id: string; kind: "plan"; plan: Plan; image?: string; answered?: string; answered_by?: string; at: string }
  | { id: string; kind: "part"; proposal: string; part: LibraryPart; status: "proposed" | "approved" | "changes_requested"; at: string }
  /** A change set. It's marked undone while Undo has taken it back. */
  | { id: string; kind: "change"; change: number; author: Author; label: string; edits: number; undone?: true; at: string }
  | { id: string; kind: "tool_request"; request: string; at: string }
  | { id: string; kind: "tool_built"; request: string; pr_url?: string; at: string }
  | {
      id: string;
      kind: "preview";
      title: string;
      explanation: string;
      ops: Op[];
      status: "proposed" | "applied" | "not_applied" | "failed";
      error?: string;
      at: string;
    }
  /** stopped shows the joint's housing stopping 10 mm short of an edge of its host. */
  /** A worked joint, or with of, one of the design's own joints pulled apart on the model. */
  | { id: string; kind: "example"; joint: JointType; note?: string; stopped?: true; of?: string; at: string }
  | { id: string; kind: "error"; text: string; retry?: true; at: string }
  | {
      id: string;
      kind: "usage";
      input: number;
      cached: number;
      written?: number;
      output: number;
      at: string;
      model?: string;
      route?: string;
      ms?: number;
      tool_ms?: number;
      rounds?: {
        effort?: string;
        ttft_ms: number | null;
        ms: number;
        input: number;
        cached: number;
        written: number;
        output: number;
        calls: number;
        edits?: number;
        retries?: number;
        compacted?: true;
      }[];
      /** From turns saved before each round kept its own level. */
      efforts?: string[];
    }
  | { id: string; kind: "summary"; at: string };

export interface ToolRequest {
  id: string;
  name: string;
  purpose: string;
  example: string;
  inputs: string;
  effect: string;
  check: string;
  stopgap?: string;
  count: number;
  status: "open" | "approved" | "built" | "declined";
  issue_url?: string;
  pr_url?: string;
}

export interface ServerState {
  /** The open design. A design started from the record console example says so. */
  project: { slug: string; name: string; example?: "record_console" };
  projects: { slug: string; name: string; starred: boolean; changed: string | null }[];
  design: Design;
  derived: Derived;
  report: CheckReport;
  cutlist: CutList;
  history: { id: number; author: Author; label: string; at: string }[];
  redo: number;
  chat: ChatItem[];
  waiting: ("question" | "plan" | "part" | "preview")[];
  busy: boolean;
  model: string;
  models: readonly { id: string; label: string; note: string }[];
  has_key: boolean;
  /** Whether the AI blend has an OpenAI key to use. The key itself never leaves the server. */
  has_openai_key: boolean;
  /** Which build of this page the server is serving now. */
  build: string;
  /** The room photo kept with this design, as a reference file name. */
  backdrop: string | null;
  tool_requests: ToolRequest[];
  /** The GitHub repository missing tools and approved parts go to, as owner/name, or null while GitHub is off. */
  repo: string | null;
  versions: { sha: string; author: string; at: string; message: string }[];
  library: {
    /** Merged parts and pending ones together. */
    parts: LibraryPart[];
    /** The parts among them still waiting for their pull request, by id. */
    pending: Record<string, PullRequestStatus>;
    broken: { file: string; error: string; pending?: true }[];
    proposals: { id: string; part: LibraryPart; status: string; at: string }[];
  };
}

/** Where an approved part's pull request has got to. */
export interface PullRequestStatus {
  state: "opening" | "waiting" | "open" | "closed";
  url?: string;
  number?: number;
  auto_merge?: boolean;
  error?: string;
}

export async function post(path: string, body: unknown = {}): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  return res.ok ? { ok: true } : { ok: false, error: data.error ?? `Request failed (${res.status})` };
}

export const applyOps = (ops: Op[], label?: string) => post("/api/ops", { ops, label });

/**
 * View requests from outside the window, such as a Crossband chat. The app
 * listens for "view" events; each one's detail is a ViewCommand.
 */
export const viewRequests = new EventTarget();

export function useServer(role?: "render"): { state: ServerState | null; connected: boolean } {
  const [state, setState] = useState<ServerState | null>(null);
  const [connected, setConnected] = useState(false);
  const retry = useRef(0);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      // The render-only page says what it is, so it isn't counted as a window.
      ws = new WebSocket(`${proto}://${location.host}/ws${role ? `?role=${role}` : ""}`);
      ws.onopen = () => {
        retry.current = 0;
        setConnected(true);
      };
      ws.onclose = (ev) => {
        // The server signed this browser out, so the page locks.
        if (ev.code === 4401) lockEvents.dispatchEvent(new Event("locked"));
        setConnected(false);
        if (!closed) timer = setTimeout(connect, Math.min(5000, 300 * 2 ** retry.current++));
      };
      ws.onmessage = (ev) => {
        const msg = JSON.parse(String(ev.data)) as
          | { type: "state"; state: ServerState }
          | { type: "chat"; item: ChatItem }
          | { type: "delta"; id: string; text: string }
          | { type: "view"; view: ViewCommand };
        if (msg.type === "view") {
          viewRequests.dispatchEvent(new CustomEvent("view", { detail: msg.view }));
          return;
        }
        setState((prev) => {
          if (msg.type === "state") return msg.state;
          if (!prev) return prev;
          if (msg.type === "chat") {
            const i = prev.chat.findIndex((c) => c.id === msg.item.id);
            const chat = [...prev.chat];
            if (i < 0) chat.push(msg.item);
            else chat[i] = msg.item;
            return { ...prev, chat };
          }
          const chat = prev.chat.map((c) =>
            c.id === msg.id && (c.kind === "assistant" || c.kind === "thinking") ? { ...c, text: c.text + msg.text } : c,
          );
          return { ...prev, chat };
        });
      };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(timer);
      ws?.close();
    };
  }, []);

  return { state, connected };
}
