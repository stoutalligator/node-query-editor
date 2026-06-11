import type {
  ParsedQuery, ExtractQuery, CteQuery,
  ExtractStep, SelectExpr, LookupExpr, WhereClause,
  ResultRow, QueryResult, ExtractSource,
} from './types';

export type XmlFilterMode = 'keep' | 'exclude';
import * as fs from 'fs';
import * as path from 'path';
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

function resolveDoc(source: ExtractSource | null): Document {
  if (source !== null) {
    if (source.kind === 'dir') throw new Error("Internal: resolveDoc called with dir source — use runDirExtract instead.");
    const doc = docCache.get(source.path);
    if (!doc) throw new Error(`File not loaded: ${source.path}`);
    return doc;
  }
  if (defaultDoc) return defaultDoc;
  throw new Error("No file loaded. Load a file or add FROM 'path/to/file.xml' to your EXTRACT.");
}

/** Run an EXTRACT query against every *.xml in a directory; injects _source column. */
function runDirExtract(query: ExtractQuery): ResultRow[] {
  const dirPath = query.source!.path;
  const fileNames = fs.readdirSync(dirPath)
    .filter(f => f.toLowerCase().endsWith('.xml'))
    .sort();
  const allRows: ResultRow[] = [];
  for (const fileName of fileNames) {
    const fp = path.join(dirPath, fileName);
    if (!hasDocForPath(fp)) {
      loadXmlForPath(fs.readFileSync(fp, 'utf8'), fp);
    }
    const fileQuery: ExtractQuery = { ...query, source: { kind: 'file', path: fp } };
    const res = runExtract(fileQuery, docCache.get(fp)!, null);
    for (const row of res.rows) allRows.push({ _source: fileName, ...row });
  }
  return allRows;
}

// ── Entry point ───────────────────────────────────────────────────────────────

export function evaluate(query: ParsedQuery, limit: number | null): QueryResult {
  if (query.kind === 'extract') {
    const doc = resolveDoc(query.source);
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
  select: Array<SelectExpr | LookupExpr>,
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
  if (where.kind === 'and') return where.clauses.every(c => passesWhere(el, c));
  if (where.kind === 'or')  return where.clauses.some(c  => passesWhere(el, c));

  // where.kind === 'condition'
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
  // Build named flat tables from each CTE (each may reference a different source doc or dir)
  const tables: Record<string, ResultRow[]> = {};
  for (const cte of q.ctes) {
    if (cte.query.source?.kind === 'dir') {
      tables[cte.name] = runDirExtract(cte.query);
    } else {
      const doc = resolveDoc(cte.query.source);
      const res = runExtract(cte.query, doc, null);
      tables[cte.name] = res.rows;
    }
  }

  // Execute final SELECT with JOINs
  const { final } = q;
  let rows = tables[final.from] ?? [];

  for (const join of final.joins) {
    const right = tables[join.table] ?? [];
    rows = applyJoin(rows, final.fromAlias, right, join);
  }

  // GROUP BY + HAVING
  if (final.groupBy && final.groupBy.length > 0) {
    const collectExprs = final.columns
      .map(c => c.expr)
      .filter(e => /^COLLECT\((.+)\)$/.test(e))
      .map(e => {
        const inner = e.match(/^COLLECT\((.+)\)$/)![1];
        const dirMatch = inner.match(/^(.+?)\s+(ASC|DESC)$/i);
        return { full: e, col: dirMatch ? dirMatch[1] : inner, dir: dirMatch ? dirMatch[2].toUpperCase() as 'ASC' | 'DESC' : null };
      });

    const groups = new Map<string, { row: ResultRow; count: number; collected: Map<string, string[]> }>();
    for (const row of rows) {
      const key = final.groupBy.map(c => resolveColExpr(c, row)).join('\0');
      if (!groups.has(key)) {
        groups.set(key, { row: { ...row }, count: 0, collected: new Map(collectExprs.map(ce => [ce.full, []])) });
      }
      const g = groups.get(key)!;
      g.count++;
      for (const ce of collectExprs) {
        const val = resolveColExpr(ce.col, row);
        if (val !== '') g.collected.get(ce.full)!.push(val);
      }
    }
    rows = [];
    for (const { row, count, collected } of groups.values()) {
      if (final.having && !applyHaving(count, final.having)) continue;
      row['__count__'] = String(count);
      for (const [expr, vals] of collected) {
        const ce = collectExprs.find(c => c.full === expr)!;
        let sorted = vals;
        if (ce.dir) {
          const allNumeric = vals.every(v => !isNaN(Number(v)));
          sorted = allNumeric
            ? [...vals].sort((a, b) => ce.dir === 'ASC' ? Number(a) - Number(b) : Number(b) - Number(a))
            : [...vals].sort((a, b) => ce.dir === 'ASC' ? a.localeCompare(b) : b.localeCompare(a));
        }
        row[`__collect__${expr}`] = sorted.join(', ');
      }
      rows.push(row);
    }
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
  if (expr === 'COUNT(*)') return row['__count__'] ?? '0';
  if (/^COLLECT\(/.test(expr)) return row[`__collect__${expr}`] ?? '';
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

function applyHaving(count: number, having: { op: string; value: number }): boolean {
  switch (having.op) {
    case '>':  return count > having.value;
    case '>=': return count >= having.value;
    case '<':  return count < having.value;
    case '<=': return count <= having.value;
    case '=':  return count === having.value;
    case '!=': return count !== having.value;
    default:   return true;
  }
}

// ── Filtered XML export ───────────────────────────────────────────────────────

function escapeAttrVal(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeTextContent(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Builds the set of Element nodes to omit from the serialized output.
 *
 * keep mode   — omit elements that MATCH the path but FAIL the WHERE filter
 *               (i.e. keep only what passes; applies to each step within its parent context)
 * exclude mode — omit elements that MATCH the path AND PASS the WHERE filter
 *               (i.e. remove the matching ones; applies globally for each step)
 */
function buildExcludeSet(query: ExtractQuery, doc: Document, mode: XmlFilterMode): Set<Element> {
  const excluded = new Set<Element>();

  if (mode === 'keep') {
    // Walk steps in order; each step only searches within nodes kept by the previous step
    let prevContexts: AnyNode[] = [doc as unknown as AnyNode];
    for (const step of query.steps) {
      const nextKept: Element[] = [];
      for (const ctx of prevContexts) {
        for (const el of matchPath(step.path, ctx)) {
          if (passesWhere(el, step.where)) {
            nextKept.push(el);
          } else {
            excluded.add(el);
          }
        }
      }
      prevContexts = nextKept;
    }
  } else {
    // Exclude mode: each step searched globally; elements passing WHERE are excluded
    for (const step of query.steps) {
      for (const el of matchPath(step.path, doc as unknown as AnyNode)) {
        if (passesWhere(el, step.where)) {
          excluded.add(el);
        }
      }
    }
  }

  return excluded;
}

function serializeAnyNode(node: AnyNode, excluded: Set<Element>, indent: number = 0): string {
  const pad = '  '.repeat(indent);

  if (isTag(node)) {
    if (excluded.has(node as Element)) return '';
    const el = node as Element;
    const attrs = Object.entries(el.attribs ?? {})
      .map(([k, v]) => ` ${k}="${escapeAttrVal(v)}"`)
      .join('');

    const rawChildren = el.children ?? [];

    // Determine whether children are purely text (inline) or element-bearing (block)
    const elementChildren = rawChildren.filter(c => isTag(c) || (c as any).type === 'comment');
    const hasElementChildren = elementChildren.length > 0;

    if (rawChildren.length === 0) {
      return `${pad}<${el.name}${attrs}/>`;
    }

    if (hasElementChildren) {
      // Block layout: each child on its own indented line, filtered empty strings removed
      const childLines = rawChildren
        .map(c => serializeAnyNode(c as AnyNode, excluded, indent + 1))
        .filter(s => s !== '');
      if (childLines.length === 0) {
        return `${pad}<${el.name}${attrs}/>`;
      }
      return `${pad}<${el.name}${attrs}>\n${childLines.join('\n')}\n${pad}</${el.name}>`;
    }

    // Inline layout: text-only children, no extra whitespace
    const inline = rawChildren.map(c => serializeAnyNode(c as AnyNode, excluded, 0)).join('');
    return `${pad}<${el.name}${attrs}>${inline}</${el.name}>`;
  }

  if (isDocument(node)) {
    return (node as Document).children
      .map(c => serializeAnyNode(c as AnyNode, excluded, indent))
      .filter(s => s !== '')
      .join('\n');
  }

  const raw = node as any;
  if (raw.type === 'text') {
    const text = escapeTextContent(raw.data ?? '').trim();
    return text ? `${pad}${text}` : '';
  }
  if (raw.type === 'comment') return `${pad}<!--${raw.data ?? ''}-->`;
  return '';
}

/**
 * Serialize the loaded XML document with nodes filtered according to the
 * EXTRACT query's WHERE clauses.
 *
 * mode = 'keep'    → only keep elements that pass each step's WHERE filter
 * mode = 'exclude' → remove elements that pass each step's WHERE filter
 */
export function exportFilteredXml(query: ParsedQuery, mode: XmlFilterMode): string {
  if (query.kind !== 'extract') {
    throw new Error('XML export only supports EXTRACT queries (not WITH/CTE).');
  }
  if (query.source?.kind === 'dir') {
    throw new Error('XML export does not support FROM DIR queries.');
  }

  const doc = resolveDoc(query.source);
  const excluded = buildExcludeSet(query, doc, mode);
  const body = serializeAnyNode(doc as unknown as AnyNode, excluded);
  return `<?xml version="1.0" encoding="UTF-8"?>\n${body}`;
}
