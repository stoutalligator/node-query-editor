import type { DataDriver } from '../driver';
import type { ResolvedConnection, Dataset, TestResult } from '../types';

export class PostgresDriver implements DataDriver {
  async ping(conn: ResolvedConnection): Promise<TestResult> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Client } = require('pg');
    const client = new Client({
      host: conn.host,
      port: conn.port ?? 5432,
      database: conn.database,
      user: conn.username,
      password: conn.password,
    });
    try {
      await client.connect();
      await client.query('SELECT 1');
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err.message };
    } finally {
      await client.end().catch(() => {});
    }
  }

  async fetchValues(conn: ResolvedConnection, dataset: Dataset): Promise<string[]> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Client } = require('pg');
    const client = new Client({
      host: conn.host,
      port: conn.port ?? 5432,
      database: conn.database,
      user: conn.username,
      password: conn.password,
    });
    try {
      await client.connect();
      const result = await client.query(dataset.query);
      return result.rows.map((r: any) => String(r[dataset.valueColumn] ?? ''));
    } finally {
      await client.end().catch(() => {});
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
