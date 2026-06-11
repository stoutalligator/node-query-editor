export type DriverKind = 'databricks' | 'postgres' | 'sqlserver' | 'csv' | 'excel';

export interface Connection {
  id: string;
  name: string;
  kind: DriverKind;
  // Databricks
  serverHostname?: string;
  httpPath?: string;
  token?: string;           // stored as encrypted hex string
  // Postgres / SQL Server
  host?: string;
  port?: number;
  database?: string;
  username?: string;
  password?: string;        // stored as encrypted hex string
  // CSV / Excel
  filePath?: string;
  trustServerCertificate?: boolean;  // SQL Server only
}

export interface Dataset {
  id: string;
  name: string;             // referenced as dataset:name in NXQL
  connectionId: string;
  query: string;            // SQL for DB drivers; unused for file drivers
  valueColumn: string;      // column name to extract as the value list
}

// Decrypted form used only inside main process when connecting
export interface ResolvedConnection extends Omit<Connection, 'token' | 'password'> {
  token?: string;           // plaintext
  password?: string;        // plaintext
}

export interface TestResult {
  ok: boolean;
  error?: string;
  rowCount?: number;
  preview?: string[];       // first 5 values
}
