// ── Query plan types ──────────────────────────────────────────────────────────

export type WhereOp = '=' | '!=' | '>' | '<' | '>=' | '<=' | 'IN' | 'NOT IN';

/** A single attribute comparison: @attr OP value */
export interface WhereLeaf {
  kind: 'condition';
  attr: string;
  op: WhereOp;
  value: string | string[];
}

/** AND of two or more clauses (all must pass) */
export interface WhereAnd {
  kind: 'and';
  clauses: WhereClause[];
}

/** OR of two or more clauses (any must pass) */
export interface WhereOr {
  kind: 'or';
  clauses: WhereClause[];
}

export type WhereClause = WhereLeaf | WhereAnd | WhereOr;

export interface SelectExpr {
  alias: string;        // which EXTRACT alias (e.g. "rd")
  attr: string;         // attribute name, or '*' for all
  as: string | null;    // optional rename
}

/** Inline lookup: find a descendant from an ancestor alias, return one attribute.
 *  SELECT pg_scen//PropertyBO WHERE @propertyType = 'ScenarioId' RETURN @integerValue AS scenarioId
 */
export interface LookupExpr {
  kind: 'lookup';
  path: string;           // e.g. "pg_scen//PropertyBO"
  where: WhereClause | null;
  returnAttr: string;     // attribute to pull from the first matched node
  as: string | null;
}

export interface ExtractStep {
  alias: string;        // e.g. "cg", "cp", "rcv"
  path: string;         // e.g. "//*/ClaimGroupBO" or "cg//ClaimPeriodBO"
  where: WhereClause | null;
}

export type ExtractSource =
  | { kind: 'file'; path: string }   // FROM 'path/to/file.xml'
  | { kind: 'dir';  path: string };  // FROM DIR 'path/to/dir' — all *.xml in that directory

export interface ExtractQuery {
  kind: 'extract';
  source: ExtractSource | null;  // null = use doc loaded via browse button
  steps: ExtractStep[];
  select: Array<SelectExpr | LookupExpr>;
  limit: number | null;
}

export interface CteDefinition {
  name: string;
  query: ExtractQuery;
}

export type JoinType = 'INNER' | 'LEFT';

export interface JoinClause {
  type: JoinType;
  table: string;        // CTE name
  alias: string;
  on: Array<{ left: string; right: string }>; // column pairs
}

export interface FinalSelect {
  columns: Array<{ expr: string; as: string | null }>;
  from: string;         // CTE name
  fromAlias: string;
  joins: JoinClause[];
  groupBy: string[] | null;
  having: { op: WhereOp; value: number } | null;
  limit: number | null;
}

export interface CteQuery {
  kind: 'cte';
  ctes: CteDefinition[];
  final: FinalSelect;
}

export interface XPathQuery {
  kind: 'xpath';
  expression: string;
}

export type ParsedQuery = ExtractQuery | CteQuery | XPathQuery;

// ── Result types ──────────────────────────────────────────────────────────────

/** A flat row: column name → string value */
export type ResultRow = Record<string, string>;

export interface QueryResult {
  columns: string[];
  rows: ResultRow[];
  totalRows: number;       // before limit
  truncated: boolean;
}

export interface QueryError {
  message: string;
  line?: number;
  col?: number;
}

// ── Worker message types ──────────────────────────────────────────────────────

export type XmlFilterMode = 'keep' | 'exclude';

export type WorkerInMessage =
  | { type: 'loadFile'; filePath: string }
  | { type: 'runQuery'; queryText: string; limit: number | null }
  | { type: 'exportXml'; queryText: string; mode: XmlFilterMode; savePath: string };

export type WorkerOutMessage =
  | { type: 'fileLoaded'; filePath: string; sizeBytes: number }
  | { type: 'fileError'; message: string }
  | { type: 'queryResult'; result: QueryResult }
  | { type: 'queryError'; error: QueryError }
  | { type: 'progress'; message: string }
  | { type: 'xmlExportDone'; savePath: string }
  | { type: 'xmlExportError'; message: string };
