import { readConnections, readDatasets } from './store';
import { decryptConnection } from './credentials';
import { createDriver } from './factory';

const DATASET_PATTERN = /\(dataset:([A-Za-z0-9_-]+)\)/g;

/**
 * Scan queryText for (dataset:name) references.
 * Resolve each by executing the external query and substituting
 * ('val1','val2',...) inline so the worker sees a normal IN clause.
 * Throws if a dataset name is unknown or a driver call fails.
 */
export async function resolveDatasets(queryText: string): Promise<string> {
  // Fast path — no dataset references
  const matches = [...queryText.matchAll(DATASET_PATTERN)];
  if (matches.length === 0) return queryText;

  const names = [...new Set(matches.map(m => m[1]))];
  const allDatasets = readDatasets();
  const allConnections = readConnections();

  const replacements = new Map<string, string>();

  await Promise.all(names.map(async (name) => {
    const dataset = allDatasets.find(d => d.name === name);
    if (!dataset) throw new Error(`Unknown dataset: "${name}"`);

    const conn = allConnections.find(c => c.id === dataset.connectionId);
    if (!conn) throw new Error(`Dataset "${name}" references a deleted connection`);

    const driver = createDriver(conn.kind);
    const values = await driver.fetchValues(decryptConnection(conn), dataset);

    // Build inline SQL list — single-quote escape values
    const escaped = values.length > 0
      ? values.map(v => `'${v.replace(/'/g, "''")}'`).join(',')
      : "''";  // empty → ('') so IN ('') matches nothing

    replacements.set(name, `(${escaped})`);
  }));

  return queryText.replace(DATASET_PATTERN, (_match, name) => replacements.get(name)!);
}
