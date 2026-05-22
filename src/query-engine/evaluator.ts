import type {
  ParsedQuery, ExtractQuery, CteQuery,
  ExtractStep, SelectExpr, LookupExpr, WhereClause,
  ResultRow, QueryResult,
} from './types';
import { parseDocument } from 'htmlparser2';
import { isTag, isDocument } from 'domhandler';
import type { Document, Element, AnyNode } from 'domhandler';

// ── XML document cache ────────────────────────────────────────────────────────

const docCache = new Map<string, Document>();
let defaultDoc: Document | null = null;     // set by browse-button loadFile
let defaultFilePath: string | null = null;

/** Load a file via the browse button — becomes the default doc for queries without FROM. */
export function loadXml(xml: string, filePath: string): void {
  const doc = parseDocument(xml, { xmlMode: true });
  docCache.set(filePath, doc);
  defaultDoc = doc;
  defaultFilePath = filePath;
}

/** Load a file referenced inline in a query (FROM 'path'). Does not change the default doc. */
export function loadXmlForPath(xml: string, filePath: string): void {
  docCache.set(filePath, parseDocument(xml, { xmlMode: true }));
}

export function hasDocForPath(filePath: string): boolean { return docCache.has(filePath); }
export function hasDocument(): boolean { return defaultDoc !== null; }
export function currentFilePath(): string | null { return defaultFilePath; }

function resolveDoc(sourcePath: string | null): Document {
  if (sourcePath !== null) {
    const doc = docCache.get(sourcePath);
    if (!doc) throw new Error(`File not loaded: ${sourcePath}`);
    return doc;
  }
  if (defaultDoc) return defaultDoc;
  throw new Error("No file loaded. Load a file or add FROM 'path/to/file.xml' to your EXTRACT.");
}

// ── Entry point ───────────────────────────────────────────────────────────────

export function evaluate(query: ParsedQuery, limit: number | null): QueryResult {
  if (query.kind === 'extract') {
    const doc = resolveDoc(query.sourcePath);
    return runExtract(query, doc, limit ?? query.limit);
  }

  if (query.kind === 'cte') {
    return runCte(query, limit);
  }

  throw new Error('XPATH mode not yet implemented in evaluator (routed separately).');
}

// ── EXTRACT evaluator ─────────────────────────────────────────────────────────

function runExtract(q: ExtractQuery, doc: Document, limitOverride: number | null): QueryResult {
  const limit = limitOverride ?? q.limit;
  const rows: ResultRow[] = [];
  const ancestorAttrs: Record<string, Record<string, string>> = {};

  descend(q.steps, 0, doc as any, ancestorAttrs, {}, q.select, rows, limit);

  const columns = deriveColumns(q.select, rows);
  return { columns, rows, totalRows: rows.length, truncated: false };
}

function descend(
  steps: ExtractStep[],
  stepIdx: number,
  context: AnyNode,
  ancestorAttrs: Record<string, Record<string, string>>,
  ancestorNodes: Record<string, AnyNode>,
  select: SelectExpr[],
  out: ResultRow[],
  limit: number | null,
): void {
  if (limit !== null && out.length >= limit) return;

  const step = steps[stepIdx];
  // If the path starts with a known alias (e.g. "pg_scen//PropertyGroupBO"),
  // search within that ancestor node rather than the immediately previous one.
  const searchContext = resolvePathContext(step.path, ancestorNodes, context);
  const matched = matchPath(step.path, searchContext);

  for (const el of matched) {
    if (limit !== null && out.length >= limit) return;
    if (!passesWhere(el, step.where)) continue;

    const attrs = getAttrs(el);
    const nextAncestors = { ...ancestorAttrs, [step.alias]: attrs };
    const nextNodes     = { ...ancestorNodes,  [step.alias]: el };

    if (stepIdx === steps.length - 1) {
      out.push(buildRow(select, nextAncestors, nextNodes, el));
    } else {
      descend(steps, stepIdx + 1, el, nextAncestors, nextNodes, select, out, limit);
    }
  }
}

function resolvePathContext(
  path: string,
  ancestorNodes: Record<string, AnyNode>,
  defaultContext: AnyNode,
): AnyNode {
  const m = path.match(/^([a-zA-Z_]\w*)\//);
  if (m && ancestorNodes[m[1]]) return ancestorNodes[m[1]];
  return defaultContext;
}

// ── Path matching ─────────────────────────────────────────────────────────────
// Supports:
//   //tagName              — all descendants named tagName
//   //*/tagName            — same
//   alias//tagName         — all descendants of alias-bound node named tagName
//   alias/tag/tag2         — navigate specific child path

function matchPath(path: string, context: AnyNode): Element[] {
  // Strip leading alias// prefix — we always search within context
  const normalized = path.replace(/^[a-zA-Z_]\w*\/\//, '//');

  if (normalized.startsWith('//')) {
    // Find all descendants matching the tag name pattern after //
    const rest = normalized.slice(2); // e.g. "*/ClaimGroupBO" or "ClaimGroupBO"
    const tagName = rest.includes('/') ? rest.split('/').pop()! : rest;
    const realTag = (tagName === '*') ? null : tagName.replace(/^\*\//, '');
    return findDescendants(context, realTag);
  }

  // Relative path: tag/tag2
  const parts = normalized.split('/').filter(Boolean);
  let current: AnyNode[] = [context];
  for (const part of parts) {
    const next: AnyNode[] = [];
    for (const node of current) {
      const children = getChildren(node);
      for (const c of children) {
        if (isTag(c) && (part === '*' || (c as Element).name === part)) next.push(c);
      }
    }
    current = next;
  }
  return current.filter(isTag) as Element[];
}

function findDescendants(node: AnyNode, tagName: string | null): Element[] {
  const results: Element[] = [];
  const stack: AnyNode[] = getChildren(node).slice(); // copy — never mutate the node's own children array
  while (stack.length) {
    const cur = stack.pop()!;
    if (isTag(cur)) {
      if (tagName === null || (cur as Element).name === tagName) results.push(cur as Element);
      stack.push(...getChildren(cur));
    }
  }
  return results;
}

function getChildren(node: AnyNode): AnyNode[] {
  if (isDocument(node)) return node.children as AnyNode[];
  if (isTag(node)) return (node as Element).children as AnyNode[];
  return [];
}

// ── Where filtering ───────────────────────────────────────────────────────────

function passesWhere(el: Element, where: WhereClause | null): boolean {
  if (!where) return true;
  const val = el.attribs[where.attr];
  if (val === undefined) return false;

  switch (where.op) {
    case '=':      return val === where.value;
    case '!=':     return val !== where.value;
    case '>':      return parseFloat(val) > parseFloat(where.value as string);
    case '<':      return parseFloat(val) < parseFloat(where.value as string);
    case '>=':     return parseFloat(val) >= parseFloat(where.value as string);
    case '<=':     return parseFloat(val) <= parseFloat(where.value as string);
    case 'IN':     return (where.value as string[]).includes(val);
    case 'NOT IN': return !(where.value as string[]).includes(val);
  }
}

// ── Row building ──────────────────────────────────────────────────────────────

function getAttrs(el: Element): Record<string, string> {
  return el.attribs ?? {};
}

function buildRow(
  select: Array<SelectExpr | LookupExpr>,
  ancestorAttrs: Record<string, Record<string, string>>,
  ancestorNodes: Record<string, AnyNode>,
  leafEl: Element,
): ResultRow {
  const row: ResultRow = {};
  for (const expr of select) {
    if ((expr as LookupExpr).kind === 'lookup') {
      const lk = expr as LookupExpr;
      const searchCtx = resolvePathContext(lk.path, ancestorNodes, leafEl);
      const allMatches = matchPath(lk.path, searchCtx);
      const matches = allMatches.filter(el => passesWhere(el, lk.where));
      const col = lk.as ?? `${lk.path}.${lk.returnAttr}`;
      row[col] = matches.length > 0 ? (matches[0].attribs[lk.returnAttr] ?? '') : '';
      continue;
    }

    const fe = expr as SelectExpr;
    const attrs = ancestorAttrs[fe.alias];
    if (!attrs) continue;

    if (fe.attr === '*') {
      for (const [k, v] of Object.entries(attrs)) {
        const col = fe.as ?? `${fe.alias}.${k}`;
        row[col] = v;
      }
    } else {
      const col = fe.as ?? `${fe.alias}.${fe.attr}`;
      row[col] = attrs[fe.attr] ?? '';
    }
  }
  return row;
}

function deriveColumns(select: Array<SelectExpr | LookupExpr>, rows: ResultRow[]): string[] {
  // For wildcard selects, column set is determined from actual rows
  const hasWildcard = select.some(e => (e as SelectExpr).attr === '*');
  if (!hasWildcard) {
    return select.map(e => {
      if ((e as LookupExpr).kind === 'lookup') {
        const lk = e as LookupExpr;
        return lk.as ?? `${lk.path}.${lk.returnAttr}`;
      }
      const fe = e as SelectExpr;
      return fe.as ?? `${fe.alias}.${fe.attr}`;
    });
  }
  // Collect all columns in insertion order
  const seen = new Set<string>();
  const cols: string[] = [];
  for (const row of rows) {
    for (const k of Object.keys(row)) {
      if (!seen.has(k)) { seen.add(k); cols.push(k); }
    }
  }
  return cols;
}

// ── CTE + JOIN evaluator ──────────────────────────────────────────────────────

function runCte(q: CteQuery, limitOverride: number | null): QueryResult {
  // Build named flat tables from each CTE (each may reference a different source doc)
  const tables: Record<string, ResultRow[]> = {};
  for (const cte of q.ctes) {
    const doc = resolveDoc(cte.query.sourcePath);
    const res = runExtract(cte.query, doc, null);
    tables[cte.name] = res.rows;
  }

  // Execute final SELECT with JOINs
  const { final } = q;
  let rows = tables[final.from] ?? [];

  for (const join of final.joins) {
    const right = tables[join.table] ?? [];
    rows = applyJoin(rows, final.fromAlias, right, join);
  }

  // Apply column projection
  let projected: ResultRow[];
  const selectAll = final.columns.length === 1 && final.columns[0].expr === '*';
  if (selectAll) {
    projected = rows;
  } else {
    projected = rows.map(row => {
      const out: ResultRow = {};
      for (const col of final.columns) {
        const val = resolveColExpr(col.expr, row);
        const name = col.as ?? col.expr;
        out[name] = val;
      }
      return out;
    });
  }

  // Apply limit
  const limit = limitOverride ?? final.limit;
  const limited = limit !== null ? projected.slice(0, limit) : projected;
  const columns = limited.length > 0 ? Object.keys(limited[0]) : [];

  return { columns, rows: limited, totalRows: projected.length, truncated: limit !== null && projected.length > limited.length };
}

function applyJoin(
  left: ResultRow[],
  leftAlias: string,
  right: ResultRow[],
  join: { type: 'INNER' | 'LEFT'; alias: string; on: Array<{ left: string; right: string }> },
): ResultRow[] {
  // Build hash index on right side keyed by join columns
  const idx = new Map<string, ResultRow[]>();
  for (const rr of right) {
    const key = join.on.map(c => resolveColExpr(c.right, rr)).join('\0');
    if (!idx.has(key)) idx.set(key, []);
    idx.get(key)!.push(rr);
  }

  const out: ResultRow[] = [];
  for (const lr of left) {
    const key = join.on.map(c => resolveColExpr(c.left, lr)).join('\0');
    const matches = idx.get(key);
    if (matches && matches.length > 0) {
      for (const rr of matches) {
        const merged: ResultRow = {};
        for (const [k, v] of Object.entries(lr)) merged[`${leftAlias}.${k}`] = v;
        for (const [k, v] of Object.entries(rr)) merged[`${join.alias}.${k}`] = v;
        out.push(merged);
      }
    } else if (join.type === 'LEFT') {
      const merged: ResultRow = {};
      for (const [k, v] of Object.entries(lr)) merged[`${leftAlias}.${k}`] = v;
      out.push(merged);
    }
  }
  return out;
}

function resolveColExpr(expr: string, row: ResultRow): string {
  // expr is "alias.column" or just "column"
  if (row[expr] !== undefined) return row[expr];
  // Try stripping alias prefix
  const dot = expr.indexOf('.');
  if (dot >= 0) {
    const col = expr.slice(dot + 1);
    if (row[col] !== undefined) return row[col];
  }
  return '';
}
