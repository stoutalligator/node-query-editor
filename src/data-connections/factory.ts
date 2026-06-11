import type { DriverKind } from './types';
import type { DataDriver } from './driver';
import { DatabricksDriver } from './drivers/databricks';
import { PostgresDriver } from './drivers/postgres';
import { SqlServerDriver } from './drivers/sqlserver';
import { FileDriver } from './drivers/file';

export function createDriver(kind: DriverKind): DataDriver {
  switch (kind) {
    case 'databricks': return new DatabricksDriver();
    case 'postgres':   return new PostgresDriver();
    case 'sqlserver':  return new SqlServerDriver();
    case 'csv':
    case 'excel':      return new FileDriver();
    default: {
      const exhaustive: never = kind;
      throw new Error(`Unknown driver kind: ${exhaustive}`);
    }
  }
}
