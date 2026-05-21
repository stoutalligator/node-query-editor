import { parentPort } from 'worker_threads';
import * as fs from 'fs';
import { parse as parseDsl } from './query-engine/parser';
import { loadXml, evaluate, hasDocument } from './query-engine/evaluator';
import type { WorkerInMessage, WorkerOutMessage } from './query-engine/types';

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
  if (!hasDocument()) {
    send({ type: 'queryError', error: { message: 'No file loaded.' } });
    return;
  }

  try {
    send({ type: 'progress', message: 'Running query…' });
    const parsed = parseDsl(queryText);
    const result = evaluate(parsed, limit);
    send({ type: 'queryResult', result });
  } catch (err: any) {
    send({ type: 'queryError', error: { message: err.message } });
  }
}
