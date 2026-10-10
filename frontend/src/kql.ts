import { ipInNet, IpNet, parseNet } from "./ipmatch";
import { severityLabel, TrafficEvent } from "./types";

/** A small KQL-style (Kibana Query Language) filter for live events.
 *
 *  It runs in the browser against the events the map has received -- it is
 *  NOT a query sent to Elastic, so it can't search history, and it works the
 *  same for every data source.
 *
 *  Supported:
 *    field:value            source.ip:10.0.0.5     src_ip:10.0.0.0/8
 *    field:(a or b)         severity:(critical or major)
 *    and / or / not         case-insensitive; and binds tighter than or
 *    ( ... )                grouping
 *    wildcards              signature:*scan*       (unquoted values only)
 *    field:*                the field exists
 *    > >= < <=              dst_port >= 1024       (numeric fields)
 *    "quoted phrase"        signature:"ET SCAN"    (literal, no wildcards)
 *    bare word              scan     10.0.0.0/8    (searches every field)
 *  Terms with no and/or between them are ANDed.
 *
 *  Matching: IP fields take an address or CIDR range; number fields compare
 *  numerically; severity, protocol, action and similar match the whole value;
 *  signature, category and asset names match anywhere inside the text. All
 *  of it ignores case.
 *
 *  Pure logic, no DOM. */

export class KqlError extends Error {
  constructor(message: string, public pos: number, public end: number) {
    super(message);
  }
}

export type Predicate = (e: TrafficEvent) => boolean;

export interface CompiledQuery {
  /** True if the event matches. An empty query matches everything. */
  test: Predicate;
  isEmpty: boolean;
  /** Field names that aren't built in. They're searched in the event's extra (unmapped) columns. */
  unknownFields: string[];
}

export type CompileResult =
  | { ok: true; query: CompiledQuery }
  | { ok: false; error: { message: string; pos: number; end: number } };

// ---- fields --------------------------------------------------------------------

type Kind = "ip" | "num" | "keyword" | "text";
type Value = string | number;

interface FieldDef {
  kind: Kind;
  get(e: TrafficEvent): Value[];
}

const present = <T>(xs: (T | null | undefined)[]): T[] => xs.filter((x): x is T => x !== null && x !== undefined);

const FIELDS: Record<string, FieldDef> = {
  src_ip: { kind: "ip", get: (e) => present([e.src_ip]) },
  dst_ip: { kind: "ip", get: (e) => present([e.dst_ip]) },
  ip: { kind: "ip", get: (e) => present([e.src_ip, e.dst_ip]) },
  src_port: { kind: "num", get: (e) => present([e.src_port]) },
  dst_port: { kind: "num", get: (e) => present([e.dst_port]) },
  port: { kind: "num", get: (e) => present([e.src_port, e.dst_port]) },
  count: { kind: "num", get: (e) => present([e.count]) },
  signature: { kind: "text", get: (e) => present([e.signature]) },
  signature_id: { kind: "keyword", get: (e) => present([e.signature_id]) },
  category: { kind: "text", get: (e) => present([e.category]) },
  protocol: { kind: "keyword", get: (e) => present([e.protocol]) },
  action: { kind: "keyword", get: (e) => present([e.action]) },
  severity: { kind: "keyword", get: (e) => [e.severity, severityLabel(e.severity)] },
  direction: { kind: "keyword", get: (e) => present([e.direction]) },
  source: { kind: "keyword", get: (e) => [e.source] },
  src_asset: { kind: "text", get: (e) => present([e.src_asset?.name]) },
  dst_asset: { kind: "text", get: (e) => present([e.dst_asset?.name]) },
  asset: { kind: "text", get: (e) => present([e.src_asset?.name, e.dst_asset?.name]) },
  src_criticality: { kind: "keyword", get: (e) => present([e.src_asset?.criticality]) },
  dst_criticality: { kind: "keyword", get: (e) => present([e.dst_asset?.criticality]) },
};

/** Elastic/ECS-style names people will type, mapped to the built-in field. */
const ALIASES: Record<string, string> = {
  "source.ip": "src_ip",
  "src.ip": "src_ip",
  "destination.ip": "dst_ip",
  "dest.ip": "dst_ip",
  "dst.ip": "dst_ip",
  "source.port": "src_port",
  "destination.port": "dst_port",
  "dest.port": "dst_port",
  "rule.name": "signature",
  "alert.signature": "signature",
  "suricata.eve.alert.signature": "signature",
  "rule.id": "signature_id",
  "alert.signature_id": "signature_id",
  "suricata.eve.alert.signature_id": "signature_id",
  "rule.category": "category",
  "alert.category": "category",
  "suricata.eve.alert.category": "category",
  "network.protocol": "protocol",
  "network.transport": "protocol",
  "proto": "protocol",
  "event.action": "action",
  "event.severity": "severity",
  "alert.severity": "severity",
  "network.direction": "direction",
};

/** Names shown in the help panel. */
export const BUILT_IN_FIELDS: readonly string[] = Object.keys(FIELDS);

function extraValues(e: TrafficEvent, name: string): Value[] {
  const x = e.extra;
  if (!x) return [];
  if (name in x) return [x[name]];
  const lower = name.toLowerCase();
  for (const k of Object.keys(x)) if (k.toLowerCase() === lower) return [x[k]];
  return [];
}

interface Resolved {
  def: FieldDef;
  unknown: boolean;
}

function resolveField(name: string): Resolved {
  const lower = name.toLowerCase();
  const key = FIELDS[lower] ? lower : ALIASES[lower];
  if (key) return { def: FIELDS[key], unknown: false };
  // Not a built-in: look for a matching column among the unmapped extras.
  return { def: { kind: "text", get: (e) => extraValues(e, name) }, unknown: true };
}

// ---- matching helpers ------------------------------------------------------------

const lc = (v: Value): string => String(v).toLowerCase();

function globRegex(pattern: string): RegExp {
  const body = pattern.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${body}$`, "i");
}

function hasValue(vals: Value[]): boolean {
  return vals.some((v) => String(v) !== "");
}

function makeTerm(field: string, value: string, quoted: boolean, tok: Tok, unknown: string[]): Predicate {
  const { def, unknown: isUnknown } = resolveField(field);
  if (isUnknown && !unknown.includes(field)) unknown.push(field);

  if (!quoted && value === "*") return (e) => hasValue(def.get(e));
  const wild = !quoted && value.includes("*");

  switch (def.kind) {
    case "ip": {
      if (wild) {
        const re = globRegex(value);
        return (e) => def.get(e).some((v) => re.test(String(v)));
      }
      const net = parseNet(value);
      if (!net) throw new KqlError(`"${value}" is not a valid IP address or CIDR range`, tok.pos, tok.end);
      return (e) => def.get(e).some((v) => ipInNet(String(v), net));
    }
    case "num": {
      const n = Number(value);
      if (value.trim() === "" || !Number.isFinite(n)) {
        throw new KqlError(`"${value}" is not a number (${field} is a numeric field)`, tok.pos, tok.end);
      }
      return (e) => def.get(e).some((v) => Number(v) === n);
    }
    case "keyword": {
      if (wild) {
        const re = globRegex(value);
        return (e) => def.get(e).some((v) => re.test(String(v)));
      }
      const want = value.toLowerCase();
      return (e) => def.get(e).some((v) => lc(v) === want);
    }
    default: {
      // text: anywhere inside the value; with a wildcard, the pattern must fit the whole value.
      if (wild) {
        const re = globRegex(value);
        return (e) => def.get(e).some((v) => re.test(String(v)));
      }
      const want = value.toLowerCase();
      return (e) => def.get(e).some((v) => lc(v).includes(want));
    }
  }
}

function makeCompare(field: string, op: string, operand: string, fieldTok: Tok, valueTok: Tok, unknown: string[]): Predicate {
  const { def, unknown: isUnknown } = resolveField(field);
  if (isUnknown && !unknown.includes(field)) unknown.push(field);
  if (def.kind !== "num" && !isUnknown) {
    throw new KqlError(`"${op}" needs a numeric field like dst_port, but ${field} isn't one`, fieldTok.pos, valueTok.end);
  }
  const n = Number(operand);
  if (operand.trim() === "" || !Number.isFinite(n)) {
    throw new KqlError(`"${operand}" is not a number`, valueTok.pos, valueTok.end);
  }
  const cmp: (a: number) => boolean =
    op === ">" ? (a) => a > n : op === ">=" ? (a) => a >= n : op === "<" ? (a) => a < n : (a) => a <= n;
  return (e) => def.get(e).some((v) => {
    const a = Number(v);
    return Number.isFinite(a) && cmp(a);
  });
}

const BARE_FIELDS = [
  "src_ip", "dst_ip", "src_port", "dst_port", "signature", "signature_id", "category",
  "protocol", "action", "severity", "direction", "source", "src_asset", "dst_asset",
];

function makeBare(value: string, quoted: boolean): Predicate {
  if (!quoted) {
    const net: IpNet | null = parseNet(value);
    if (net) return (e) => ipInNet(e.src_ip, net) || ipInNet(e.dst_ip, net);
  }
  const wild = !quoted && value.includes("*");
  const re = wild ? globRegex(`*${value}*`) : null;
  const want = value.toLowerCase();
  const hit = (v: Value): boolean => (re ? re.test(String(v)) : lc(v).includes(want));
  return (e) => {
    for (const f of BARE_FIELDS) if (FIELDS[f].get(e).some(hit)) return true;
    return e.extra ? Object.values(e.extra).some(hit) : false;
  };
}

// ---- tokenizer ---------------------------------------------------------------------

interface Tok {
  kind: "(" | ")" | "op" | "str" | "word";
  value: string;
  pos: number;
  end: number;
}

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === "(" || c === ")") { out.push({ kind: c, value: c, pos: i, end: i + 1 }); i++; continue; }
    if (c === '"') {
      const start = i++;
      let s = "";
      let closed = false;
      while (i < src.length) {
        if (src[i] === "\\" && i + 1 < src.length) { s += src[i + 1]; i += 2; continue; }
        if (src[i] === '"') { closed = true; i++; break; }
        s += src[i++];
      }
      if (!closed) throw new KqlError("Missing closing quote", start, src.length);
      out.push({ kind: "str", value: s, pos: start, end: i });
      continue;
    }
    if (c === "<" || c === ">") {
      const start = i++;
      if (src[i] === "=") i++;
      out.push({ kind: "op", value: src.slice(start, i), pos: start, end: i });
      continue;
    }
    const start = i;
    while (i < src.length && !/[\s()"<>]/.test(src[i])) i++;
    out.push({ kind: "word", value: src.slice(start, i), pos: start, end: i });
  }
  return out;
}

// ---- parser ------------------------------------------------------------------------

const FIELD_NAME = /^[A-Za-z_@][\w.@-]*$/;

class Parser {
  private i = 0;
  readonly unknown: string[] = [];

  constructor(private toks: Tok[], private srcLen: number) {}

  private peek(): Tok | undefined { return this.toks[this.i]; }
  private next(): Tok { return this.toks[this.i++]; }
  private isKeyword(t: Tok | undefined, word: string): boolean {
    return t?.kind === "word" && t.value.toLowerCase() === word;
  }
  private atEnd(): KqlError {
    return new KqlError("The query ends too early", this.srcLen, this.srcLen);
  }

  parse(): Predicate {
    const p = this.parseOr(null);
    const t = this.peek();
    if (t) {
      throw new KqlError(t.kind === ")" ? "Unexpected closing parenthesis" : `Unexpected "${t.value}"`, t.pos, t.end);
    }
    return p;
  }

  /** `ctx` is the field name while inside field:( ... ), where bare words are VALUES for that field. */
  private parseOr(ctx: string | null): Predicate {
    let left = this.parseAnd(ctx);
    while (this.isKeyword(this.peek(), "or")) {
      this.next();
      const l = left;
      const r = this.parseAnd(ctx);
      left = (e) => l(e) || r(e);
    }
    return left;
  }

  private parseAnd(ctx: string | null): Predicate {
    let left = this.parseNot(ctx);
    for (;;) {
      const t = this.peek();
      if (!t || t.kind === ")" || this.isKeyword(t, "or")) break;
      if (this.isKeyword(t, "and")) this.next(); // otherwise: terms side by side are ANDed
      const l = left;
      const r = this.parseNot(ctx);
      left = (e) => l(e) && r(e);
    }
    return left;
  }

  private parseNot(ctx: string | null): Predicate {
    if (this.isKeyword(this.peek(), "not")) {
      this.next();
      const inner = this.parseNot(ctx);
      return (e) => !inner(e);
    }
    return this.parsePrimary(ctx);
  }

  private parsePrimary(ctx: string | null): Predicate {
    const t = this.next();
    if (!t) throw this.atEnd();

    if (t.kind === "(") {
      const inner = this.parseOr(ctx);
      const close = this.next();
      if (!close || close.kind !== ")") throw new KqlError("Missing closing parenthesis", t.pos, this.srcLen);
      return inner;
    }
    if (t.kind === ")") throw new KqlError("Unexpected closing parenthesis", t.pos, t.end);
    if (t.kind === "op") throw new KqlError(`"${t.value}" needs a field name before it, like dst_port ${t.value} 1024`, t.pos, t.end);

    if (t.kind === "str") {
      return ctx ? makeTerm(ctx, t.value, true, t, this.unknown) : makeBare(t.value, true);
    }

    // a word
    const lower = t.value.toLowerCase();
    if (lower === "and" || lower === "or") {
      throw new KqlError(`"${t.value}" needs a search term on each side (put it in quotes to search for the word)`, t.pos, t.end);
    }
    if (ctx) return makeTerm(ctx, t.value, false, t, this.unknown);

    // field > number
    const after = this.peek();
    if (after?.kind === "op") {
      if (!FIELD_NAME.test(t.value)) throw new KqlError(`"${t.value}" is not a field name`, t.pos, t.end);
      this.next();
      const operand = this.next();
      if (!operand || (operand.kind !== "word" && operand.kind !== "str")) {
        throw new KqlError(`Expected a number after "${after.value}"`, after.pos, after.end);
      }
      return makeCompare(t.value, after.value, operand.value, t, operand, this.unknown);
    }

    // field:value  (but 2001:db8::1 and 10.0.0.0/8 are addresses, not fields)
    const colon = t.value.indexOf(":");
    if (colon > 0 && FIELD_NAME.test(t.value.slice(0, colon)) && !parseNet(t.value)) {
      const field = t.value.slice(0, colon);
      const rest = t.value.slice(colon + 1);
      if (rest !== "") return makeTerm(field, rest, false, { ...t, pos: t.pos + colon + 1 }, this.unknown);

      const v = this.next();
      if (!v) throw new KqlError(`Expected a value after "${field}:"`, t.pos, t.end);
      if (v.kind === "(") {
        const inner = this.parseOr(field);
        const close = this.next();
        if (!close || close.kind !== ")") throw new KqlError("Missing closing parenthesis", v.pos, this.srcLen);
        return inner;
      }
      if (v.kind === "str") return makeTerm(field, v.value, true, v, this.unknown);
      if (v.kind === "word" && !["and", "or", "not"].includes(v.value.toLowerCase())) {
        return makeTerm(field, v.value, false, v, this.unknown);
      }
      throw new KqlError(`Expected a value after "${field}:"`, t.pos, v.end);
    }

    return makeBare(t.value, false);
  }
}

// ---- public API ----------------------------------------------------------------------

/** Compiles a query. Throws KqlError (with the position of the problem) if it can't. */
export function compileQuery(src: string): CompiledQuery {
  if (src.trim() === "") return { test: () => true, isEmpty: true, unknownFields: [] };
  const parser = new Parser(tokenize(src), src.length);
  const test = parser.parse();
  return { test, isEmpty: false, unknownFields: parser.unknown };
}

/** Like compileQuery, but returns the error instead of throwing. */
export function tryCompile(src: string): CompileResult {
  try {
    return { ok: true, query: compileQuery(src) };
  } catch (err) {
    if (err instanceof KqlError) return { ok: false, error: { message: err.message, pos: err.pos, end: err.end } };
    throw err;
  }
}
