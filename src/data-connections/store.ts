import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import type { Connection, Dataset } from './types';

const connectionsPath = () => path.join(app.getPath('userData'), 'data-connections.json');
const datasetsPath    = () => path.join(app.getPath('userData'), 'datasets.json');

// Returns connections with credentials still encrypted (safe to send to renderer)
export function readConnections(): Connection[] {
  try { return JSON.parse(fs.readFileSync(connectionsPath(), 'utf8')); }
  catch { return []; }
}

export function writeConnections(list: Connection[]): void {
  fs.writeFileSync(connectionsPath(), JSON.stringify(list, null, 2), 'utf8');
}

export function readDatasets(): Dataset[] {
  try { return JSON.parse(fs.readFileSync(datasetsPath(), 'utf8')); }
  catch { return []; }
}

export function writeDatasets(list: Dataset[]): void {
  fs.writeFileSync(datasetsPath(), JSON.stringify(list, null, 2), 'utf8');
}
