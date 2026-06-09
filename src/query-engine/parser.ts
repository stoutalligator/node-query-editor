import type {
  ParsedQuery, ExtractQuery, CteQuery, XPathQuery,
  ExtractStep, SelectExpr, LookupExpr, WhereClause, WhereOp,
  CteDefinition, JoinClause, JoinType, ExtractSource,
} from './types';

// ── Tokenizer ─────────────────────────────────────────────────────────────────

type TokKind =
  | 'KW'    // keyword
  | 'IDENT' // identifier / alias
  | 'PATH'  // XPath-like path starting with / or alias//
  | 'STR'   // 'string literal'
  | 'NUM'   // numeric literal
  | 'ATTR'  // @attrName
  | 'STAR'  // *
  | 'DOT'   // .
  | 'COMMA' // ,
  | 'LPAREN'| 'RPAREN'
  | 'EQ' | 'NEQ' | 'GT' | 'LT' | 'GTE' | 'LTE'
  | 'EOF';

const KEYWORDS = new Set([
  'EXTRACT','ROOT','INTO','WHERE','SELECT','AS','WITH','FROM','JOIN','LEFT',
  'INNER','ON','AND','IN','NOT','XPATH','LIMIT','ORDER','BY','ASC','DESC','RETURN','DIR',
  'GROUP','HAVING','COUNT','COLLECT',
]);

interface Token { kind: TokKind; value: string; pos: number; }

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < src.length) {
    // skip whitespace + comments
    if (/\s/.test(src[i])) { i++; continue; }
    if (src[i] === '-' && src[i+1] === '-') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }

    const start = i;

    // String literal
    if (src[i] === "'") {
      i++;
      let s = '';
      while (i < src.length && src[i] !== "'") {
        if (src[i] === '\\' && i + 1 < src.length) {
          const next = src[i + 1];
          if (next === "'" || next === '\\') {
            i++; s += src[i++]; // true escape: \' or \\
          } else {
            s += src[i++];       // literal backslash (e.g. \p stays as \p for Windows paths)
          }
        } else {
          s += src[i++];
        }
      }
      i++; // closing quote
      tokens.push({ kind: 'STR', value: s, pos: start });
      continue;
    }

    // Operators
    if (src[i] === '!' && src[i+1] === '=') { tokens.push({ kind: 'NEQ', value: '!=', pos: start }); i+=2; continue; }
    if (src[i] === '>' && src[i+1] === '=') { tokens.push({ kind: 'GTE', value: '>=', pos: start }); i+=2; continue; }
    if (src[i] === '<' && src[i+1] === '=') { tokens.push({ kind: 'LTE', value: '<=', pos: start }); i+=2; continue; }
    if (src[i] === '=') { tokens.push({ kind: 'EQ',  value: '=',  pos: start }); i++; continue; }
    if (src[i] === '>') { tokens.push({ kind: 'GT',  value: '>',  pos: start }); i++; continue; }
    if (src[i] === '<') { tokens.push({ kind: 'LT',  value: '<',  pos: start }); i++; continue; }
    if (src[i] === ',') { tokens.push({ kind: 'COMMA',  value: ',', pos: start }); i++; continue; }
    if (src[i] === '(') { tokens.push({ kind: 'LPAREN', value: '(', pos: start }); i++; continue; }
    if (src[i] === ')') { tokens.push({ kind: 'RPAREN', value: ')', pos: start }); i++; continue; }
    if (src[i] === '*') { tokens.push({ kind: 'STAR',   value: '*', pos: start }); i++; continue; }
    if (src[i] === '.') { tokens.push({ kind: 'DOT',    value: '.', pos: start }); i++; continue; }

    // Attribute: @name
    if (src[i] === '@') {
      i++;
      let name = '@';
      while (i < src.length && /[\w:-]/.test(src[i])) name += src[i++];
      tokens.push({ kind: 'ATTR', value: name, pos: start });
      continue;
    }

    // Path starting with / or //
    if (src[i] === '/') {
      let path = '';
      // Consume full path: runs of /word[@pred] until whitespace or comma or paren
      while (i < src.length && !/[\s,()]/.test(src[i])) path += src[i++];
      tokens.push({ kind: 'PATH', value: path, pos: start });
      continue;
    }

    // Numbers
    if (/\d/.test(src[i])) {
      let n = '';
      while (i < src.length && /[\d.]/.test(src[i])) n += src[i++];
      tokens.push({ kind: 'NUM', value: n, pos: start });
      continue;
    }

    // Identifiers and keywords
    if (/[a-zA-Z_]/.test(src[i])) {
      let word = '';
      while (i < src.length && /[\w]/.test(src[i])) word += src[i++];
      const upper = word.toUpperCase();
      // Check if followed by // making it a path like "alias//..."
      if (src[i] === '/' && src[i+1] === '/') {
        let path = word;
        while (i < src.length && !/[\s,()]/.test(src[i])) path += src[i++];
        tokens.push({ kind: 'PATH', value: path, pos: start });
      } else {
        tokens.push({ kind: KEYWORDS.has(upper) ? 'KW' : 'IDENT', value: word, pos: start });
      }
      continue;
    }

    throw new SyntaxError(`Unexpected character '${src[i]}' at position ${i}`);
  }

  tokens.push({ kind: 'EOF', value: '', pos: src.length });
  return tokens;
}

// ── Token stream ──────────────────────────────────────────────────────────────

class TokenStream {
  private tokens: Token[];
  private pos = 0;

  constructor(tokens: Token[]) { this.tokens = tokens; }

  peek(): Token { return this.tokens[this.pos]; }
  next(): Token { return this.tokens[this.pos++]; }
  eof(): boolean { return this.peek().kind === 'EOF'; }

  peekKw(kw: string): boolean {
    const t = this.peek();
    return t.kind === 'KW' && t.value.toUpperCase() === kw.toUpperCase();
  }

  expectKw(kw: string): void {
    const t = this.next();
    if (t.kind !== 'KW' || t.value.toUpperCase() !== kw.toUpperCase()) {
      throw new SyntaxError(`Expected keyword '${kw}', got '${t.value}' at pos ${t.pos}`);
    }
  }

  consumeKw(kw: string): boolean {
    if (this.peekKw(kw)) { this.next(); return true; }
    return false;
  }

  expectIdent(): string {
    const t = this.next();
    if (t.kind !== 'IDENT' && t.kind !== 'KW') {
      throw new SyntaxError(`Expected identifier, got '${t.value}' at pos ${t.pos}`);
    }
    return t.value;
  }

  expectPath(): string {
    const t = this.next();
    if (t.kind !== 'PATH') throw new SyntaxError(`Expected path, got '${t.value}' at pos ${t.pos}`);
    return t.value;
  }
}

// ── Parser ────────────────────────────────────────────────────────────────────

export function parse(src: string): ParsedQuery {
  const ts = new TokenStream(tokenize(src.trim()));

  if (ts.peekKw('XPATH')) {
    ts.next();
    const rest = src.slice(src.toUpperCase().indexOf('XPATH') + 5).trim();
    return { kind: 'xpath', expression: rest } as XPathQuery;
  }

  if (ts.peekKw('WITH')) {
    return parseCte(ts);
  }

  if (ts.peekKw('EXTRACT')) {
    return parseExtract(ts);
  }

  throw new SyntaxError(`Query must start with EXTRACT, WITH, or XPATH. Got '${ts.peek().value}'`);
}

function parseExtract(ts: TokenStream): ExtractQuery {
  ts.expectKw('EXTRACT');

  // Optional: FROM 'file-path'  or  FROM DIR 'dir-path'
  let source: ExtractSource | null = null;
  if (ts.consumeKw('FROM')) {
    if (ts.consumeKw('DIR')) {
      const pathTok = ts.next();
      if (pathTok.kind !== 'STR') throw new SyntaxError(`Expected string path after FROM DIR, got '${pathTok.value}'`);
      source = { kind: 'dir', path: pathTok.value };
    } else {
      const pathTok = ts.next();
      if (pathTok.kind !== 'STR') throw new SyntaxError(`Expected string path after FROM, got '${pathTok.value}'`);
      source = { kind: 'file', path: pathTok.value };
    }
  }

  const steps: ExtractStep[] = [];

  // ROOT step
  ts.expectKw('ROOT');
  const rootPath = ts.expectPath();
  ts.expectKw('AS');
  const rootAlias = ts.expectIdent();
  const rootWhere = ts.peekKw('WHERE') ? parseWhere(ts) : null;
  steps.push({ alias: rootAlias, path: rootPath, where: rootWhere });

  // INTO steps
  while (ts.peekKw('INTO')) {
    ts.next();
    const path = ts.expectPath();
    ts.expectKw('AS');
    const alias = ts.expectIdent();
    const where = ts.peekKw('WHERE') ? parseWhere(ts) : null;
    steps.push({ alias, path, where });
  }

  // SELECT
  ts.expectKw('SELECT');
  const select = parseSelectExprs(ts);

  // Optional LIMIT
  let limit: number | null = null;
  if (ts.peekKw('LIMIT')) {
    ts.next();
    const t = ts.next();
    limit = parseInt(t.value, 10);
  }

  return { kind: 'extract', source, steps, select, limit };
}

function parseWhere(ts: TokenStream): WhereClause {
  ts.expectKw('WHERE');
  const t = ts.next();
  if (t.kind !== 'ATTR') throw new SyntaxError(`Expected @attribute in WHERE, got '${t.value}'`);
  const attr = t.value.slice(1); // strip @

  const opTok = ts.next();
  let op: WhereOp;
  let value: string | string[];

  if (ts.peekKw('NOT')) {
    ts.next(); ts.expectKw('IN');
    op = 'NOT IN';
    value = parseInList(ts);
  } else if (opTok.kind === 'KW' && opTok.value.toUpperCase() === 'IN') {
    op = 'IN';
    value = parseInList(ts);
  } else {
    op = opTok.value as WhereOp;
    const valTok = ts.next();
    value = valTok.value;
  }

  return { attr, op, value };
}

function parseInList(ts: TokenStream): string[] {
  ts.next(); // (
  const values: string[] = [];
  while (!ts.eof()) {
    const t = ts.next();
    if (t.kind === 'RPAREN') break;
    if (t.kind === 'COMMA') continue;
    values.push(t.value);
  }
  return values;
}

function parseSelectExprs(ts: TokenStream): Array<SelectExpr | LookupExpr> {
  const exprs: Array<SelectExpr | LookupExpr> = [];

  while (!ts.eof() && !ts.peekKw('LIMIT') && !ts.peekKw('ORDER') && ts.peek().kind !== 'RPAREN') {
    const t = ts.next();

    // Inline lookup: alias//Tag [WHERE @attr OP value] RETURN @attr AS name
    if (t.kind === 'PATH') {
      const where = ts.peekKw('WHERE') ? parseWhere(ts) : null;
      ts.expectKw('RETURN');
      const retTok = ts.next();
      if (retTok.kind !== 'ATTR') throw new SyntaxError(`Expected @attribute after RETURN, got '${retTok.value}'`);
      const returnAttr = retTok.value.slice(1);
      let as: string | null = null;
      if (ts.peekKw('AS')) { ts.next(); as = ts.expectIdent(); }
      exprs.push({ kind: 'lookup', path: t.value, where, returnAttr, as });

    // alias.* or alias.@attr or alias.attrName
    } else if (t.kind === 'IDENT' || t.kind === 'KW') {
      const alias = t.value;
      const dot = ts.next();
      if (dot.kind !== 'DOT') throw new SyntaxError(`Expected '.' after alias '${alias}', got '${dot.value}'`);

      const attrTok = ts.next();
      let attr: string;
      if (attrTok.kind === 'STAR') {
        attr = '*';
      } else if (attrTok.kind === 'ATTR') {
        attr = attrTok.value.slice(1);
      } else if (attrTok.kind === 'IDENT') {
        attr = attrTok.value;
      } else {
        throw new SyntaxError(`Expected attribute name or * after '${alias}.', got '${attrTok.value}'`);
      }

      let as: string | null = null;
      if (ts.peekKw('AS')) { ts.next(); as = ts.expectIdent(); }
      exprs.push({ alias, attr, as });

    } else {
      throw new SyntaxError(`Unexpected token '${t.value}' in SELECT`);
    }

    if (ts.peek().kind === 'COMMA') ts.next();
  }

  return exprs;
}

function parseCte(ts: TokenStream): CteQuery {
  const ctes: CteDefinition[] = [];

  while (ts.peekKw('WITH') || (ctes.length > 0 && ts.peek().kind === 'COMMA')) {
    if (ts.peekKw('WITH')) ts.next();
    if (ts.peek().kind === 'COMMA') ts.next();
    const name = ts.expectIdent();
    ts.expectKw('AS');
    ts.next(); // (
    const query = parseExtract(ts);
    ts.next(); // )
    ctes.push({ name, query });
  }

  // Final SELECT
  ts.expectKw('SELECT');
  const columns: Array<{ expr: string; as: string | null }> = [];
  while (!ts.eof() && !ts.peekKw('FROM')) {
    const parts: string[] = [];
    while (!ts.eof() && ts.peek().kind !== 'COMMA' && !ts.peekKw('FROM') && !ts.peekKw('AS')) {
      const tok = ts.next();
      parts.push((tok.kind === 'KW' && parts.length > 0 ? ' ' : '') + tok.value);
    }
    let as: string | null = null;
    if (ts.peekKw('AS')) { ts.next(); as = ts.expectIdent(); }
    columns.push({ expr: parts.join(''), as });
    if (ts.peek().kind === 'COMMA') ts.next();
  }

  ts.expectKw('FROM');
  const fromTable = ts.expectIdent();
  ts.expectKw('AS');
  const fromAlias = ts.expectIdent();

  const joins: JoinClause[] = [];
  while (!ts.eof() && (ts.peekKw('JOIN') || ts.peekKw('LEFT') || ts.peekKw('INNER'))) {
    let joinType: JoinType = 'INNER';
    if (ts.peekKw('LEFT'))  { ts.next(); joinType = 'LEFT'; }
    if (ts.peekKw('INNER')) { ts.next(); joinType = 'INNER'; }
    ts.expectKw('JOIN');
    const table = ts.expectIdent();
    ts.expectKw('AS');
    const alias = ts.expectIdent();
    ts.expectKw('ON');
    const on: Array<{ left: string; right: string }> = [];
    do {
      const left  = parseColRef(ts);
      ts.next(); // =
      const right = parseColRef(ts);
      on.push({ left, right });
    } while (ts.consumeKw('AND'));
    joins.push({ type: joinType, table, alias, on });
  }

  // GROUP BY
  let groupBy: string[] | null = null;
  if (ts.consumeKw('GROUP')) {
    ts.expectKw('BY');
    groupBy = [];
    do {
      groupBy.push(parseColRef(ts));
    } while (ts.peek().kind === 'COMMA' && (ts.next(), true));
  }

  // HAVING COUNT(*) op n
  let having: { op: WhereOp; value: number } | null = null;
  if (ts.consumeKw('HAVING')) {
    ts.expectKw('COUNT');
    ts.next(); ts.next(); ts.next(); // consume ( * )
    const opTok = ts.next();
    const valTok = ts.next();
    having = { op: opTok.value as WhereOp, value: parseFloat(valTok.value) };
  }

  let limit: number | null = null;
  if (ts.peekKw('LIMIT')) { ts.next(); limit = parseInt(ts.next().value, 10); }

  return { kind: 'cte', ctes, final: { columns, from: fromTable, fromAlias, joins, groupBy, having, limit } };
}

function parseColRef(ts: TokenStream): string {
  const parts: string[] = [];
  parts.push(ts.next().value); // alias or column
  if (ts.peek().kind === 'DOT') { ts.next(); parts.push('.'); parts.push(ts.next().value); }
  return parts.join('');
}
