import type { DataDriver } from '../driver';
import type { ResolvedConnection, Dataset, TestResult } from '../types';

export class SqlServerDriver implements DataDriver {
  async ping(conn: ResolvedConnection): Promise<TestResult> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mssql = require('mssql');
    let pool: any = null;
    try {
      pool = await mssql.connect({
        server: conn.host,
        port: conn.port ?? 1433,
        database: conn.database,
        user: conn.username,
        password: conn.password,
        options: {
          trustServerCertificate: conn.trustServerCertificate ?? false,
        },
      });
      await pool.request().query('SELECT 1');
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err.message };
    } finally {
      if (pool) await pool.close().catch(() => {});
    }
  }

  async fetchValues(conn: ResolvedConnection, dataset: Dataset): Promise<string[]> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mssql = require('mssql');
    let pool: any = null;
    try {
      pool = await mssql.connect({
        server: conn.host,
        port: conn.port ?? 1433,
        database: conn.database,
        user: conn.username,
        password: conn.password,
        options: {
          trustServerCertificate: conn.trustServerCertificate ?? false,
        },
      });
      const result = await pool.request().query(dataset.query);
      return result.recordset.map((r: any) => String(r[dataset.valueColumn] ?? ''));
    } finally {
      if (pool) await pool.close().catch(() => {});
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
