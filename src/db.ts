import sql from 'mssql';
import { env } from './config';

let pool: sql.ConnectionPool | null = null;

export async function getPool(): Promise<sql.ConnectionPool> {
  if (pool && pool.connected) return pool;
  pool = await new sql.ConnectionPool({
    server: env.DB_HOST,
    port: env.DB_PORT,
    user: env.DB_USER,
    password: env.DB_PASS,
    database: env.DB_NAME,
    options: {
      encrypt: true,               // keep true; good default
      trustServerCertificate: true // allow self-signed for local
    },
    pool: { min: 0, max: 10, idleTimeoutMillis: 30000 }
  }).connect();
  return pool;
}

export const SQL = sql;