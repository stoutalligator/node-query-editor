import * as fs from 'fs';
import * as path from 'path';
import { parse as parseDsl } from './query-engine/parser';
import { loadXml, loadXmlForPath, hasDocForPath, evaluate } from './query-engine/evaluator';
import type { ExtractQuery, QueryResult, ResultRow } from './query-engine/types';

// ── Batch spec types ──────────────────────────────────────────────────────────

interface QuerySpec {
  name: string;
  query: string;
}

interface BatchSpec {
  xmlFile?: string;
  xmlDir?: string;
  queries: QuerySpec[];
}

type BatchResult = Record<string, QueryResult | { error: string }>;

// ── Dir query runner (mirrors worker.ts handleDirQuery logic) ─────────────────

function runDirQuery(query: ExtractQuery, dirPath: string): QueryResult {
  let fileNames: string[];
  try {
    fileNames = fs.readdirSync(dirPath)
      .filter(f => f.toLowerCase().endsWith('.xml'))
      .sort();
  } catch (err: any) {
    throw new Error(`Cannot read directory '${dirPath}': ${err.message}`);
  }

  if (fileNames.length === 0) {
    throw new Error(`No XML files found in '${dirPath}'`);
  }

  const allRows: ResultRow[] = [];
  let columns: string[] = [];
  const limit = query.limit;

  for (const fileName of fileNames) {
    if (limit !== null && allRows.length >= limit) break;

    const fp = path.join(dirPath, fileName);
    if (!hasDocForPath(fp)) {
      loadXmlForPath(fs.readFileSync(fp, 'utf8'), fp);
    }

    const remaining = limit !== null ? limit - allRows.length : null;
    const fileQuery: ExtractQuery = { ...query, source: { kind: 'file', path: fp } };
    const res = evaluate(fileQuery, remaining);

    if (columns.length === 0 && res.columns.length > 0) {
      columns = ['_source', ...res.columns];
    }

    for (const row of res.rows) {
      allRows.push({ _source: fileName, ...row });
    }
  }

  const truncated = limit !== null && allRows.length >= limit;
  return { columns, rows: allRows, totalRows: allRows.length, truncated };
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main() {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk);

  let spec: BatchSpec;
  try {
    spec = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (err: any) {
    process.stderr.write(`Invalid JSON input: ${err.message}\n`);
    process.exit(1);
  }

  if (spec.xmlFile && spec.xmlDir) {
    process.stderr.write('Provide either xmlFile or xmlDir, not both\n');
    process.exit(1);
  }

  if (!Array.isArray(spec.queries) || spec.queries.length === 0) {
    process.stderr.write('queries array is required and must not be empty\n');
    process.exit(1);
  }

  // Pre-load the default doc once if xmlFile provided
  if (spec.xmlFile) {
    try {
      loadXml(fs.readFileSync(spec.xmlFile, 'utf8'), spec.xmlFile);
    } catch (err: any) {
      process.stderr.write(`Failed to load xmlFile '${spec.xmlFile}': ${err.message}\n`);
      process.exit(1);
    }
  }

  const results: BatchResult = {};

  for (const { name, query: queryText } of spec.queries) {
    // Substitute placeholders
    const substituted = queryText
      .replace(/\{xmlFile\}/g, spec.xmlFile ?? '')
      .replace(/\{xmlDir\}/g, spec.xmlDir ?? '');

    let parsed;
    try {
      parsed = parseDsl(substituted);
    } catch (err: any) {
      results[name] = { error: err.message };
      continue;
    }

    try {
      if (parsed.kind === 'extract' && parsed.source?.kind === 'dir') {
        results[name] = runDirQuery(parsed, parsed.source.path);
      } else {
        results[name] = evaluate(parsed, null);
      }
    } catch (err: any) {
      results[name] = { error: err.message };
    }
  }

  process.stdout.write(JSON.stringify(results) + '\n');
}

main().catch(err => {
  process.stderr.write(`Fatal: ${err.message}\n`);
  process.exit(1);
});
