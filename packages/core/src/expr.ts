// A small, deterministic expression language for parameters, part bounds
// and rules. It has numbers, names, arithmetic, comparisons and a few
// functions. Names are parameters (`bay_width`), part faces
// (`left_side.right`) or part sizes (`shelf.length`).
//
// gap_x, gap_y and gap_z take two parts, such as `gap_y(shelf, side_l)`,
// and measure the clear space between their shapes. Shapes are worked out
// after every size, so only a rule can use them.
//
// `overall.width`, `overall.height` and `overall.depth` read the whole
// piece, and `overall.top` and the other faces its edges (see derive.ts).
// It's worked out after every size too, so only a rule or a plan's key
// size can use it.

export type Ast =
  | { kind: "num"; value: number }
  | { kind: "ref"; name: string }
  | { kind: "unary"; op: "-" | "!"; arg: Ast }
  | { kind: "binary"; op: BinaryOp; left: Ast; right: Ast }
  | { kind: "call"; fn: string; args: Ast[] }
  | { kind: "gap"; axis: "x" | "y" | "z"; a: string; b: string };

type BinaryOp = "+" | "-" | "*" | "/" | "%" | "<" | "<=" | ">" | ">=" | "==" | "!=" | "&&" | "||";

export type Value = number | boolean;

export class ExprError extends Error {
  constructor(message: string, readonly expr?: string) {
    super(expr === undefined ? message : `${message} in "${expr}"`);
    this.name = "ExprError";
  }
}

const FUNCTIONS: Record<string, { min: number; max: number; fn: (...a: number[]) => number }> = {
  min: { min: 1, max: 99, fn: (...a) => Math.min(...a) },
  max: { min: 1, max: 99, fn: (...a) => Math.max(...a) },
  abs: { min: 1, max: 1, fn: (a) => Math.abs(a) },
  sqrt: { min: 1, max: 1, fn: (a) => Math.sqrt(a) },
  round: { min: 1, max: 2, fn: (a, step = 1) => Math.round(a / step) * step },
  floor: { min: 1, max: 2, fn: (a, step = 1) => Math.floor(a / step) * step },
  ceil: { min: 1, max: 2, fn: (a, step = 1) => Math.ceil(a / step) * step },
};
/** The functions that measure between two parts' shapes, by the axis each measures along. */
export const GAP_FUNCTIONS = { gap_x: "x", gap_y: "y", gap_z: "z" } as const;
export const FUNCTION_NAMES = [...Object.keys(FUNCTIONS), ...Object.keys(GAP_FUNCTIONS)];

type Token =
  | { t: "num"; v: number; pos: number }
  | { t: "name"; v: string; pos: number }
  | { t: "op"; v: string; pos: number }
  | { t: "end"; pos: number };

const OPS = ["<=", ">=", "==", "!=", "&&", "||", "+", "-", "*", "/", "%", "<", ">", "(", ")", ",", "!"];

function tokenise(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const num = /^(\d+\.?\d*|\.\d+)/.exec(src.slice(i));
    if (num) {
      out.push({ t: "num", v: Number(num[0]), pos: i });
      i += num[0].length;
      continue;
    }
    const name = /^[a-z_][a-z0-9_]*(#\d+)?(\.[a-z_][a-z0-9_]*)?/i.exec(src.slice(i));
    if (name) {
      out.push({ t: "name", v: name[0], pos: i });
      i += name[0].length;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (op) {
      out.push({ t: "op", v: op, pos: i });
      i += op.length;
      continue;
    }
    throw new ExprError(`Unexpected character "${c}" at position ${i + 1}`, src);
  }
  out.push({ t: "end", pos: src.length });
  return out;
}

const BINARY_PRECEDENCE: Record<string, number> = {
  "||": 1,
  "&&": 2,
  "==": 3,
  "!=": 3,
  "<": 4,
  "<=": 4,
  ">": 4,
  ">=": 4,
  "+": 5,
  "-": 5,
  "*": 6,
  "/": 6,
  "%": 6,
};
const UNARY_PRECEDENCE = 7;

const cache = new Map<string, Ast>();

export function parse(src: string): Ast {
  const hit = cache.get(src);
  if (hit) return hit;
  if (src.trim() === "") throw new ExprError("Empty expression");
  const tokens = tokenise(src);
  let p = 0;
  const peek = () => tokens[p]!;
  const next = () => tokens[p++]!;

  const expect = (v: string) => {
    const tok = next();
    if (tok.t !== "op" || tok.v !== v) {
      throw new ExprError(`Expected "${v}" at position ${tok.pos + 1}`, src);
    }
  };

  const primary = (): Ast => {
    const tok = next();
    if (tok.t === "num") return { kind: "num", value: tok.v };
    if (tok.t === "name") {
      if (peek().t === "op" && (peek() as { v: string }).v === "(") {
        next();
        const fn = tok.v.toLowerCase();
        if (fn in GAP_FUNCTIONS) {
          // Two part names, never numbers: gap_y(shelf, side_l).
          const part = () => {
            const t = next();
            if (t.t !== "name" || t.v.includes(".")) {
              throw new ExprError(`${fn}() takes two part names, such as ${fn}(shelf, side_l)`, src);
            }
            return t.v;
          };
          const a = part();
          expect(",");
          const b = part();
          expect(")");
          if (a === b) throw new ExprError(`${fn}() needs two different parts, not ${a} twice`, src);
          return { kind: "gap", axis: GAP_FUNCTIONS[fn as keyof typeof GAP_FUNCTIONS], a, b };
        }
        if (!(fn in FUNCTIONS)) {
          throw new ExprError(`Unknown function "${tok.v}". Allowed: ${FUNCTION_NAMES.join(", ")}`, src);
        }
        const args: Ast[] = [];
        if (!(peek().t === "op" && (peek() as { v: string }).v === ")")) {
          args.push(expr(0));
          while (peek().t === "op" && (peek() as { v: string }).v === ",") {
            next();
            args.push(expr(0));
          }
        }
        expect(")");
        const spec = FUNCTIONS[fn]!;
        if (args.length < spec.min || args.length > spec.max) {
          throw new ExprError(`${fn}() takes ${spec.min === spec.max ? spec.min : `${spec.min} to ${spec.max}`} arguments`, src);
        }
        return { kind: "call", fn, args };
      }
      return { kind: "ref", name: tok.v };
    }
    if (tok.t === "op" && tok.v === "(") {
      const inner = expr(0);
      expect(")");
      return inner;
    }
    if (tok.t === "op" && (tok.v === "-" || tok.v === "!")) {
      return { kind: "unary", op: tok.v, arg: expr(UNARY_PRECEDENCE) };
    }
    if (tok.t === "op" && tok.v === "+") return expr(UNARY_PRECEDENCE);
    throw new ExprError(tok.t === "end" ? "Expression ends too early" : `Unexpected "${(tok as { v: string }).v}" at position ${tok.pos + 1}`, src);
  };

  const expr = (minPrec: number): Ast => {
    let left = primary();
    for (;;) {
      const tok = peek();
      if (tok.t !== "op") break;
      const prec = BINARY_PRECEDENCE[tok.v];
      if (prec === undefined || prec <= minPrec) break;
      next();
      const right = expr(prec);
      left = { kind: "binary", op: tok.v as BinaryOp, left, right };
    }
    return left;
  };

  const ast = expr(0);
  if (peek().t !== "end") {
    throw new ExprError(`Unexpected "${(peek() as { v: string }).v}" at position ${peek().pos + 1}`, src);
  }
  cache.set(src, ast);
  return ast;
}

/** Every name an expression mentions, apart from the parts a gap function measures between (see gapPartsOf). */
export function refsOf(src: string): string[] {
  const out = new Set<string>();
  const walk = (a: Ast) => {
    if (a.kind === "ref") out.add(a.name);
    else if (a.kind === "unary") walk(a.arg);
    else if (a.kind === "binary") {
      walk(a.left);
      walk(a.right);
    } else if (a.kind === "call") a.args.forEach(walk);
  };
  walk(parse(src));
  return [...out];
}

/** The parts an expression measures between with gap_x, gap_y or gap_z, such as shelf and side_l. */
export function gapPartsOf(src: string): string[] {
  const out = new Set<string>();
  const walk = (a: Ast) => {
    if (a.kind === "gap") {
      out.add(a.a);
      out.add(a.b);
    } else if (a.kind === "unary") walk(a.arg);
    else if (a.kind === "binary") {
      walk(a.left);
      walk(a.right);
    } else if (a.kind === "call") a.args.forEach(walk);
  };
  walk(parse(src));
  return [...out];
}

export function fmt(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  const r = Math.round(n * 100) / 100;
  return Object.is(r, -0) ? "0" : String(r);
}

export interface Traced {
  value: Value;
  /** The expression with every name followed by its value. */
  text: string;
}

function precedenceOf(a: Ast): number {
  if (a.kind === "binary") return BINARY_PRECEDENCE[a.op]!;
  if (a.kind === "unary") return UNARY_PRECEDENCE;
  return 99;
}

/** Measures the gap between two parts along an axis, for gap_x, gap_y and gap_z. */
export type GapResolver = (axis: "x" | "y" | "z", a: string, b: string) => number;

/**
 * Evaluates an expression. `resolve` returns the value of a name or throws.
 * The returned text shows each name with its value, for derivation traces.
 * Without `gap`, a gap function is refused, since the shapes it measures
 * aren't known yet.
 */
export function evaluate(src: string, resolve: (name: string) => number, gap?: GapResolver): Traced {
  const ast = parse(src);
  const num = (v: Value, what: string): number => {
    if (typeof v !== "number") throw new ExprError(`${what} needs a number, not true/false`, src);
    return v;
  };
  const bool = (v: Value, what: string): boolean => {
    if (typeof v !== "boolean") throw new ExprError(`${what} needs true/false, not a number`, src);
    return v;
  };
  const go = (a: Ast, parentPrec: number): Traced => {
    switch (a.kind) {
      case "num":
        return { value: a.value, text: fmt(a.value) };
      case "ref": {
        const v = resolve(a.name);
        return { value: v, text: `${a.name} (${fmt(v)})` };
      }
      case "unary": {
        const r = go(a.arg, UNARY_PRECEDENCE);
        const value = a.op === "-" ? -num(r.value, "-") : !bool(r.value, "!");
        return { value, text: `${a.op}${r.text}` };
      }
      case "gap": {
        const fn = `gap_${a.axis}`;
        if (!gap) throw new ExprError(`${fn} measures the parts' shapes, which are worked out after every size, so only a rule can use it`, src);
        const v = gap(a.axis, a.a, a.b);
        return { value: v, text: `${fn}(${a.a}, ${a.b}) (${fmt(v)})` };
      }
      case "call": {
        const args = a.args.map((x) => go(x, 0));
        const value = FUNCTIONS[a.fn]!.fn(...args.map((x) => num(x.value, `${a.fn}()`)));
        return { value, text: `${a.fn}(${args.map((x) => x.text).join(", ")})` };
      }
      case "binary": {
        const prec = precedenceOf(a);
        const l = go(a.left, prec);
        const r = go(a.right, prec + 1);
        let value: Value;
        switch (a.op) {
          case "+": value = num(l.value, "+") + num(r.value, "+"); break;
          case "-": value = num(l.value, "-") - num(r.value, "-"); break;
          case "*": value = num(l.value, "*") * num(r.value, "*"); break;
          case "/": {
            const d = num(r.value, "/");
            if (d === 0) throw new ExprError("Division by zero", src);
            value = num(l.value, "/") / d;
            break;
          }
          case "%": value = num(l.value, "%") % num(r.value, "%"); break;
          case "<": value = num(l.value, "<") < num(r.value, "<"); break;
          case "<=": value = num(l.value, "<=") <= num(r.value, "<=") + 1e-9; break;
          case ">": value = num(l.value, ">") > num(r.value, ">"); break;
          case ">=": value = num(l.value, ">=") >= num(r.value, ">=") - 1e-9; break;
          case "==": value = Math.abs(num(l.value, "==") - num(r.value, "==")) < 1e-6; break;
          case "!=": value = Math.abs(num(l.value, "!=") - num(r.value, "!=")) >= 1e-6; break;
          case "&&": value = bool(l.value, "&&") && bool(r.value, "&&"); break;
          case "||": value = bool(l.value, "||") || bool(r.value, "||"); break;
        }
        const text = `${l.text} ${a.op} ${r.text}`;
        return { value, text: prec < parentPrec ? `(${text})` : text };
      }
    }
  };
  return go(ast, 0);
}

export function evaluateNumber(src: string, resolve: (name: string) => number, gap?: GapResolver): Traced & { value: number } {
  const r = evaluate(src, resolve, gap);
  if (typeof r.value !== "number") throw new ExprError("Expected a number, got true/false", src);
  if (!Number.isFinite(r.value)) throw new ExprError("The result isn't a finite number", src);
  return r as Traced & { value: number };
}

/** A plain number, so the parameter can be shown as a slider. */
export function literalValue(src: string): number | null {
  const t = src.trim();
  return /^-?(\d+\.?\d*|\.\d+)$/.test(t) ? Number(t) : null;
}
