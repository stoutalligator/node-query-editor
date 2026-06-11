import type { ResolvedConnection, Dataset, TestResult } from './types';

export interface DataDriver {
  ping(conn: ResolvedConnection): Promise<TestResult>;
  test(conn: ResolvedConnection, dataset: Dataset): Promise<TestResult>;
  fetchValues(conn: ResolvedConnection, dataset: Dataset): Promise<string[]>;
}
