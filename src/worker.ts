import { parentPort } from 'worker_threads';
import * as fs from 'fs';
import * as path from 'path';
import { parse as parseDsl } from './query-engine/parser';
import { loadXml, loadXmlForPath, hasDocForPath, evaluate, hasDocument } from './query-engine/evaluator';
import type { WorkerInMessage, WorkerOutMessage, ParsedQuery } from './query-engine/types';

function send(msg: WorkerOutMessage): void {
  parentPort!.postMessage(msg);
}

parentPort!.on('message', (msg: WorkerInMessage) => {
  switch (msg.type) {
    case 'loadFile':  handleLoadFile(msg.filePath);              break;
    case 'runQuery':  handleRunQuery(msg.queryText, msg.limit);  break;
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

  // Auto-load any XML sources declared inline in the query
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

  if (sourcePaths.length === 0 && !hasDocument()) {
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

function getQuerySourcePaths(parsed: ParsedQuery): string[] {
  if (parsed.kind === 'extract') return parsed.sourcePath ? [parsed.sourcePath] : [];
  if (parsed.kind === 'cte') return parsed.ctes.map(c => c.query.sourcePath).filter((p): p is string => p !== null);
  return [];
}
