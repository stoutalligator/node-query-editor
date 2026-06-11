import type { DataDriver } from '../driver';
import type { ResolvedConnection, Dataset, TestResult } from '../types';

export class DatabricksDriver implements DataDriver {
  async ping(conn: ResolvedConnection): Promise<TestResult> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DBSQLClient } = require('@databricks/sql');
    const client = new DBSQLClient();
    let session: any = null;
    const host = (conn.serverHostname ?? '').replace(/^https?:\/\//i, '');
    try {
      await client.connect({
        host,
        path: conn.httpPath,
        token: conn.token,
      });
      session = await client.openSession();
      const stmt = await session.executeStatement('SELECT 1', { runAsync: false });
      await stmt.close();
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err.message };
    } finally {
      if (session) await session.close().catch(() => {});
      await client.close().catch(() => {});
    }
  }

  async fetchValues(conn: ResolvedConnection, dataset: Dataset): Promise<string[]> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DBSQLClient } = require('@databricks/sql');
    const client = new DBSQLClient();
    let session: any = null;
    const host = (conn.serverHostname ?? '').replace(/^https?:\/\//i, '');
    try {
      await client.connect({
        host,
        path: conn.httpPath,
        token: conn.token,
      });
      session = await client.openSession();
      const stmt = await session.executeStatement(dataset.query, { runAsync: false });
      const rows: any[] = await stmt.fetchAll();
      await stmt.close();
      return rows.map(r => String(r[dataset.valueColumn] ?? ''));
    } finally {
      if (session) await session.close().catch(() => {});
      await client.close().catch(() => {});
    }
  }

  async test(conn: ResolvedConnection, dataset: Dataset): Promise<TestResult> {
    try {
      const values = await this.fetchValues(conn, dataset);
      return {
        ok: true,
        rowCount: values.length,
        preview: values.slice(0, 5),
      };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  }
}
