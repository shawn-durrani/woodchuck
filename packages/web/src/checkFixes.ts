// The ways to fix a problem from the Check tab. "Ask Claude to fix" puts a
// plain request naming the problem in the chat box, ready to change before
// you send it. "Show me" picks the parts and frames them, and for one of the
// design's own rules, the parts it reads. "Edit the rule" opens the rule.
// Kept free of React so the tests can hold it.

import { gapPartsOf, refsOf, type Box, type DerivedPart, type Design, type Issue, type Rule } from "@woodchuck/core";

/** The design's rule a problem comes from, if it's one of them. */
export function ruleOf(issue: Pick<Issue, "code" | "message">, rules: Rule[]): Rule | null {
  if (issue.code === "rule_failed") return rules.find((r) => issue.message === `${r.message} (rule ${r.id})`) ?? null;
  if (issue.code === "rule_error") return rules.find((r) => issue.message.startsWith(`Rule ${r.id}:`) || issue.message.startsWith(`Rule ${r.id} `)) ?? null;
  return null;
}

/** A problem's words without the rule's id on the end, which reads better small. */
export function problemWords(message: string): { text: string; rule: string | null } {
  const m = /^(.*) \(rule ([a-z][a-z0-9_]*)\)$/s.exec(message);
  return m ? { text: m[1]!, rule: m[2]! } : { text: message, rule: null };
}

/** What "Ask Claude to fix" puts in the chat box. */
export function fixRequest(issue: Pick<Issue, "code" | "message" | "parts">, rule: Rule | null, name: (id: string) => string = (id) => id): string {
  const { text } = problemWords(issue.message);
  const quoted = `"${text.replace(/\.$/, "")}"`;
  if (rule) return `Please fix this problem from Check: ${quoted}. It comes from the design's rule ${rule.id}.`;
  const about = issue.parts.slice(0, 3).map(name);
  const more = issue.parts.length > 3 ? ` and ${issue.parts.length - 3} more` : "";
  return `Please fix this problem from Check: ${quoted}.${about.length ? ` It's about ${about.join(", ")}${more}.` : ""}`;
}

const refs = (expr: string): string[] => {
  try {
    return refsOf(expr);
  } catch {
    // A rule that doesn't parse reads nothing that can be shown.
    return [];
  }
};

/** The parts a rule measures between with gap_x, gap_y or gap_z. */
const measured = (expr: string): string[] => {
  try {
    return gapPartsOf(expr);
  } catch {
    return [];
  }
};

/** Every expression in a part's sizes. */
function panelExprs(p: Design["parts"][number]): string[] {
  const out: string[] = [];
  for (const a of ["x", "y", "z"] as const) {
    const spec = p[a];
    for (const b of [spec.start, spec.end]) {
      if (!b) continue;
      if ("at" in b) out.push(b.at);
      else {
        out.push(`${b.face}`);
        if (b.offset) out.push(b.offset);
      }
    }
    if (spec.size) out.push(spec.size);
  }
  return out;
}

/** The part a reference such as "rail_front_top.bottom" names, if it names one. */
const partOfRef = (ref: string): string | null => (ref.includes(".") ? ref.slice(0, ref.indexOf(".")) : null);

/**
 * The parts one of the design's rules reads: the parts it names, the parts
 * named in the sizes it uses, and the parts those sizes set directly. For
 * "rail_front_top.bottom - shelf_top >= 280" that's the front rail and the
 * parts that sit at shelf_top. Array copies come with their original.
 */
export function ruleParts(rule: Pick<Rule, "expr">, design: Pick<Design, "params" | "parts" | "arrays">): string[] {
  const params = new Map(design.params.map((p) => [p.name, p]));
  const out = new Set<string>();
  const named = refs(rule.expr).filter((r) => params.has(r));
  // The parts it reads, following each size it uses down to the parts and sizes that size reads.
  const seen = new Set<string>();
  const walk = (expr: string) => {
    for (const ref of refs(expr)) {
      const part = partOfRef(ref);
      if (part) out.add(part);
      else if (params.has(ref) && !seen.has(ref)) {
        seen.add(ref);
        walk(params.get(ref)!.expr);
      }
    }
  };
  walk(rule.expr);
  for (const part of measured(rule.expr)) out.add(part);
  // The parts the sizes it names set directly.
  const sets = (expr: string) => refs(expr).some((r) => named.includes(r));
  for (const p of design.parts) if (panelExprs(p).some(sets)) out.add(p.id);
  for (const a of design.arrays) if (sets(a.count) || sets(a.pitch)) for (const id of a.parts) out.add(id);
  return [...out];
}

/** The parts "Show me" picks for a problem: the ones it names, or for a rule, the ones it reads. */
export function showMeParts(issue: Pick<Issue, "code" | "message" | "parts">, design: Design, parts: DerivedPart[]): string[] {
  const live = parts.filter((p) => !p.broken);
  const rule = ruleOf(issue, design.rules);
  if (!rule) {
    const named = new Set(issue.parts);
    return live.filter((p) => named.has(p.id)).map((p) => p.id);
  }
  // A rule reads a part's original, which stands for all its copies. A copy it names, such as "slat#2", stands for itself.
  const read = new Set(ruleParts(rule, design));
  return live.filter((p) => read.has(p.id) || (p.copy > 1 && read.has(p.source))).map((p) => p.id);
}

/** The box round some parts, for framing them. */
export function boxOf(parts: DerivedPart[], ids: string[]): Box | null {
  const pick = new Set(ids);
  const boxes = parts.filter((p) => pick.has(p.id) && !p.broken).map((p) => p.nominal);
  if (!boxes.length) return null;
  return {
    min: [0, 1, 2].map((i) => Math.min(...boxes.map((b) => b.min[i]!))) as Box["min"],
    max: [0, 1, 2].map((i) => Math.max(...boxes.map((b) => b.max[i]!))) as Box["max"],
  };
}

/** Everything the Check tab offers for one problem. */
export interface Fixes {
  /** What Ask Claude to fix puts in the chat box. */
  ask: string;
  /** What Show me picks and frames. Empty when nothing can be worked out. */
  show: string[];
  /** The rule Edit the rule opens, for a problem from one. */
  rule: Rule | null;
}

export function fixesFor(issue: Pick<Issue, "code" | "message" | "parts">, design: Design, parts: DerivedPart[], name?: (id: string) => string): Fixes {
  const rule = ruleOf(issue, design.rules);
  return { ask: fixRequest(issue, rule, name), show: showMeParts(issue, design, parts), rule };
}
