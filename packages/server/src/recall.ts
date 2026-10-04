// recall_chat: Claude's way back into a long chat. Once the API has
// summarised the older turns, Claude only has the summary. This searches
// everything said and done in the design's chat, as saved on disk, by words
// or by position, and returns the matching lines with when they happened.
// It only reads.

import type { ChatItem } from "./store.js";

export interface RecallInput {
  query?: string;
  from?: "start" | "end";
  limit?: number;
}

export interface ChatLine {
  /** Place in the chat, from 1. */
  n: number;
  at: string;
  who: string;
  text: string;
}

const LINE_CHARS = 600;
const TOTAL_CHARS = 12_000;
const STOP = new Set(
  "the and for are was were what when where which who why how did does that this with from have has had about into onto our you your can could would should then than them they their there just like make made want wanted remember start beginning first earlier back again".split(
    " ",
  ),
);

/** One readable line per chat item, leaving out thinking and bookkeeping. */
export function chatLines(chat: ChatItem[]): ChatLine[] {
  const out: ChatLine[] = [];
  for (const c of chat) {
    let who: string;
    let text: string;
    switch (c.kind) {
      case "user":
        who = "Woodworker";
        text = c.text + (c.selection.length ? ` (selected ${c.selection.join(", ")})` : "");
        break;
      case "assistant":
        who = "Claude";
        text = c.text;
        break;
      case "tool":
        who = "Claude's tool";
        text = c.summary;
        break;
      case "question":
        who = "Claude asked";
        text = c.question + (c.answered !== undefined ? ` Answer: ${c.answered}` : "");
        break;
      case "plan":
        who = "Plan";
        text = [c.plan.summary, c.plan.joints.length ? `Joints: ${c.plan.joints.join("; ")}` : "", c.plan.assumptions.length ? `Assumptions: ${c.plan.assumptions.join("; ")}` : ""]
          .filter(Boolean)
          .join(" ");
        break;
      case "preview":
        who = "Preview";
        text = `${c.title}: ${c.explanation} (${c.status.replace("_", " ")})`;
        break;
      case "part":
        who = "Part proposal";
        text = `${c.part.name} (${c.status.replace("_", " ")})`;
        break;
      case "change":
        who = "Change";
        text = `${c.author === "claude" ? "Claude" : c.author === "you" ? "the woodworker" : c.author} made ${c.edits} edit${c.edits === 1 ? "" : "s"}: ${c.label}`;
        break;
      case "example":
        who = "Joint example";
        text = c.joint.replace(/_/g, " ") + (c.note ? `: ${c.note}` : "");
        break;
      default:
        continue;
    }
    if (text.trim()) out.push({ n: out.length + 1, at: c.at, who, text: text.trim() });
  }
  return out;
}

const words = (s: string) => (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length >= 3 && !STOP.has(w));
const stem = (w: string) => w.replace(/(ies|es|s|ing|ed)$/, "");

function show(l: ChatLine): string {
  const text = l.text.length > LINE_CHARS ? `${l.text.slice(0, LINE_CHARS)}…` : l.text;
  return `[${l.n} · ${l.at.slice(0, 16).replace("T", " ")}] ${l.who}: ${text.replace(/\s+/g, " ")}`;
}

/** The answer recall_chat gives Claude. */
export function recallChat(chat: ChatItem[], input: RecallInput): string {
  const lines = chatLines(chat);
  if (!lines.length) return "The chat is empty.";
  const limit = Math.min(40, Math.max(1, Math.round(input.limit ?? 12)));
  const query = (input.query ?? "").trim();
  let picked: ChatLine[];
  let heading: string;
  if (query) {
    const want = [...new Set(words(query).map(stem))];
    if (!want.length) return `"${query}" has no words to search for. Give a few words, such as the part or material, or use from: start.`;
    const scored = lines
      .map((l) => {
        const have = new Set(words(l.text).map(stem));
        return { l, score: want.filter((w) => have.has(w)).length };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score || a.l.n - b.l.n)
      .slice(0, limit);
    if (!scored.length) return `Nothing in the ${lines.length} lines of chat mentions ${want.join(", ")}. Try other words, or from: start.`;
    // Claude's reply to a matching message usually holds the decision.
    const chosen = new Set(scored.map((s) => s.l.n));
    for (const s of scored) {
      if (s.l.who !== "Woodworker") continue;
      const reply = lines.find((l) => l.n > s.l.n && l.who === "Claude");
      if (reply) chosen.add(reply.n);
    }
    picked = lines.filter((l) => chosen.has(l.n));
    heading = `${picked.length} of ${lines.length} chat lines about ${want.join(", ")}, oldest first:`;
  } else {
    picked = input.from === "end" ? lines.slice(-limit) : lines.slice(0, limit);
    heading = `The ${input.from === "end" ? "last" : "first"} ${picked.length} of ${lines.length} chat lines, oldest first:`;
  }
  let out = heading;
  for (const l of picked) {
    const next = `\n${show(l)}`;
    if (out.length + next.length > TOTAL_CHARS) {
      out += "\n(More lines matched. Narrow the words to see them.)";
      break;
    }
    out += next;
  }
  return out;
}
