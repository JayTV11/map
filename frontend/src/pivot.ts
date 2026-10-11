/** Click-to-pivot: turns a value shown in an event's details into a search clause, and joins it onto the current search. Pure (no DOM). */

/** The fields a detail value can pivot on (all are fields of the search bar's query language). */
export type PivotField = "src_ip" | "dst_ip" | "src_port" | "dst_port" | "ip" | "signature" | "signature_id" | "category" |
  "protocol" | "action" | "src_asset" | "dst_asset" | "direction" | "severity";

const SAFE = /^[A-Za-z0-9_.:\-\/]+$/;

/** `field:value`, quoted whenever the value has anything the query language would read as syntax.
 *  Inside quotes `*` is literal, so a value with a wildcard can't turn the pivot into a pattern. */
export function pivotClause(field: PivotField, value: string | number): string {
  const v = String(value).trim();
  if (SAFE.test(v) && !/^(and|or|not)$/i.test(v)) return `${field}:${v}`;
  return `${field}:"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Joins a clause onto the current search. `and` keeps what is already there; otherwise the clause replaces it.
 *  The existing text is wrapped in brackets so an "or" in it can't swallow the new clause. */
export function pivotQuery(current: string, clause: string, and: boolean): string {
  const cur = current.trim();
  if (!and || cur === "") return clause;
  if (cur.split(/\s+/).includes(clause)) return cur; // clicking the same value twice shouldn't pile it up
  const needsBrackets = /\b(or)\b/i.test(cur) && !/^\(.*\)$/.test(cur);
  return `${needsBrackets ? `(${cur})` : cur} and ${clause}`;
}
