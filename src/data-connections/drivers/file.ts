import * as fs from 'fs';
import type { DataDriver } from '../driver';
import type { ResolvedConnection, Dataset, TestResult } from '../types';

export class FileDriver implements DataDriver {
  async ping(conn: ResolvedConnection): Promise<TestResult> {
    try {
      fs.accessSync(conn.filePath!, fs.constants.R_OK);
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  }

  async fetchValues(conn: ResolvedConnection, dataset: Dataset): Promise<string[]> {
    if (conn.kind === 'csv') {
      return this.fetchCsv(conn.filePath!, dataset.valueColumn);
    } else {
      return this.fetchExcel(conn.filePath!, dataset.valueColumn);
    }
  }

  private fetchCsv(filePath: string, valueColumn: string): string[] {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { parse } = require('csv-parse/sync');
    const content = fs.readFileSync(filePath, 'utf8');
    const records: Record<string, string>[] = parse(content, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
    });
    return records.map(r => String(r[valueColumn] ?? ''));
  }

  private fetchExcel(filePath: string, valueColumn: string): string[] {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const XLSX = require('xlsx');
    const wb = XLSX.readFile(filePath);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1 });
    if (rows.length < 2) return [];

    const headers: string[] = rows[0].map(String);
    const colIdx = headers.indexOf(valueColumn);
    if (colIdx < 0) throw new Error(`Column "${valueColumn}" not found in Excel file. Available: ${headers.join(', ')}`);

    return rows.slice(1)
      .map(r => String(r[colIdx] ?? ''))
      .filter(v => v !== '' && v !== 'undefined');
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
