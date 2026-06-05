import { parentPort } from 'worker_threads';
import * as fs from 'fs';
import * as path from 'path';
import { parse as parseDsl } from './query-engine/parser';
import { loadXml, loadXmlForPath, hasDocForPath, evaluate, hasDocument, exportFilteredXml } from './query-engine/evaluator';
import type { WorkerInMessage, WorkerOutMessage, ParsedQuery, ExtractQuery, ResultRow } from './query-engine/types';

function send(msg: WorkerOutMessage): void {
  parentPort!.postMessage(msg);
}

parentPort!.on('message', (msg: WorkerInMessage) => {
  switch (msg.type) {
    case 'loadFile':  handleLoadFile(msg.filePath);                            break;
    case 'runQuery':  handleRunQuery(msg.queryText, msg.limit);                break;
    case 'exportXml': handleExportXml(msg.queryText, msg.mode, msg.savePath); break;
  }
});

function handleLoadFile(filePath: string): void {
  try {
    send({ type: 'progress', message: 'Reading file…' });
    const xml = fs.readFileSync(filePath, 'utf8');
    send({ type: 'progress', message: 'Parsing XML…' });
    loadXml(xml, filePath);
    const stat = fs.statSync(filePath);
    send({ type: 'fileLoaded', filePath, sizeBytes: stat.size });
  } catch (err: any) {
    send({ type: 'fileError', message: err.message });
  }
}

function handleRunQuery(queryText: string, limit: number | null): void {
  let parsed: ParsedQuery;
  try {
    parsed = parseDsl(queryText);
  } catch (err: any) {
    send({ type: 'queryError', error: { message: err.message } });
    return;
  }

  // FROM DIR — handle separately (expands to multiple files, unions results)
  if (parsed.kind === 'extract' && parsed.source?.kind === 'dir') {
    handleDirQuery(parsed, limit);
    return;
  }

  // Auto-load any single-file sources declared inline in the query
  const sourcePaths = getQuerySourcePaths(parsed);
  for (const fp of sourcePaths) {
    if (!hasDocForPath(fp)) {
      try {
        send({ type: 'progress', message: `Loading ${path.basename(fp)}…` });
        const xml = fs.readFileSync(fp, 'utf8');
        loadXmlForPath(xml, fp);
      } catch (err: any) {
        send({ type: 'queryError', error: { message: `Failed to load '${fp}': ${err.message}` } });
        return;
      }
    }
  }

  if (sourcePaths.length === 0 && !hasDocument() && !hasDirSource(parsed)) {
    send({ type: 'queryError', error: { message: "No file loaded. Load a file or add FROM 'path/to/file.xml' to your EXTRACT." } });
    return;
  }

  try {
    send({ type: 'progress', message: 'Running query…' });
    const result = evaluate(parsed, limit);
    send({ type: 'queryResult', result });
  } catch (err: any) {
    send({ type: 'queryError', error: { message: err.message } });
  }
}

function handleDirQuery(query: ExtractQuery, limit: number | null): void {
  const dirPath = query.source!.path;

  let fileNames: string[];
  try {
    fileNames = fs.readdirSync(dirPath)
      .filter(f => f.toLowerCase().endsWith('.xml'))
      .sort();
  } catch (err: any) {
    send({ type: 'queryError', error: { message: `Cannot read directory '${dirPath}': ${err.message}` } });
    return;
  }

  if (fileNames.length === 0) {
    send({ type: 'queryError', error: { message: `No XML files found in '${dirPath}'` } });
    return;
  }

  const allRows: ResultRow[] = [];
  let columns: string[] = [];
  let truncated = false;

  for (const fileName of fileNames) {
    if (limit !== null && allRows.length >= limit) {
      truncated = true;
      break;
    }

    const fp = path.join(dirPath, fileName);
    if (!hasDocForPath(fp)) {
      try {
        send({ type: 'progress', message: `Loading ${fileName} (${fileNames.indexOf(fileName) + 1}/${fileNames.length})…` });
        const xml = fs.readFileSync(fp, 'utf8');
        loadXmlForPath(xml, fp);
      } catch (err: any) {
        send({ type: 'queryError', error: { message: `Failed to load '${fp}': ${err.message}` } });
        return;
      }
    }

    try {
      const remaining = limit !== null ? limit - allRows.length : null;
      const fileQuery: ExtractQuery = { ...query, source: { kind: 'file', path: fp } };
      const res = evaluate(fileQuery, remaining);

      if (columns.length === 0 && res.columns.length > 0) {
        columns = ['_source', ...res.columns];
      }

      for (const row of res.rows) {
        allRows.push({ _source: fileName, ...row });
      }
    } catch (err: any) {
      send({ type: 'queryError', error: { message: `Error querying '${fileName}': ${err.message}` } });
      return;
    }
  }

  send({ type: 'queryResult', result: { columns, rows: allRows, totalRows: allRows.length, truncated } });
}

function getQuerySourcePaths(parsed: ParsedQuery): string[] {
  if (parsed.kind === 'extract') return parsed.source?.kind === 'file' ? [parsed.source.path] : [];
  if (parsed.kind === 'cte') return parsed.ctes.map(c => c.query.source).filter((s): s is { kind: 'file'; path: string } => s?.kind === 'file').map(s => s.path);
  return [];
}

function hasDirSource(parsed: ParsedQuery): boolean {
  if (parsed.kind === 'extract') return parsed.source?.kind === 'dir';
  if (parsed.kind === 'cte') return parsed.ctes.some(c => c.query.source?.kind === 'dir');
  return false;
}

function handleExportXml(queryText: string, mode: 'keep' | 'exclude', savePath: string): void {
  let parsed: ParsedQuery;
  try {
    parsed = parseDsl(queryText);
  } catch (err: any) {
    send({ type: 'xmlExportError', message: err.message });
    return;
  }

  try {
    send({ type: 'progress', message: 'Building filtered XML…' });
    const xml = exportFilteredXml(parsed, mode);
    send({ type: 'progress', message: 'Writing file…' });
    fs.writeFileSync(savePath, xml, 'utf8');
    send({ type: 'xmlExportDone', savePath });
  } catch (err: any) {
    send({ type: 'xmlExportError', message: err.message });
  }
}
