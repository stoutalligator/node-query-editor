import { safeStorage } from 'electron';
import type { Connection } from './types';

// Returns hex-encoded encrypted string, or "plain:value" fallback when
// safeStorage is unavailable (headless/CI environments).
export function encrypt(plaintext: string): string {
  if (!safeStorage.isEncryptionAvailable()) return 'plain:' + plaintext;
  return safeStorage.encryptString(plaintext).toString('hex');
}

export function decrypt(stored: string): string {
  if (stored.startsWith('plain:')) return stored.slice(6);
  return safeStorage.decryptString(Buffer.from(stored, 'hex'));
}

export function encryptConnection(conn: Connection): Connection {
  const out = { ...conn };
  if (conn.kind === 'databricks' && conn.token) {
    out.token = encrypt(conn.token);
  }
  if ((conn.kind === 'postgres' || conn.kind === 'sqlserver') && conn.password) {
    out.password = encrypt(conn.password);
  }
  return out;
}

export function decryptConnection(conn: Connection): Connection {
  const out = { ...conn };
  if (conn.kind === 'databricks' && conn.token) {
    out.token = decrypt(conn.token);
  }
  if ((conn.kind === 'postgres' || conn.kind === 'sqlserver') && conn.password) {
    out.password = decrypt(conn.password);
  }
  return out;
}
