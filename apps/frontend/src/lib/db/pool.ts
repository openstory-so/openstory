import pg from "pg";

const { Pool } = pg;

const conn = process.env.DATABASE_URL;
if (!conn) {
  throw new Error("DATABASE_URL environment variable is required");
}
const u = new URL(conn);

const isSupabaseHost = /(\.supabase\.co|\.pooler\.supabase\.com)$/i.test(
  u.hostname,
);
const isPoolerPort = u.port === "6543";

// Force SSL for Supabase/hosted; disable for localhost
const shouldUseSsl =
  isSupabaseHost || isPoolerPort || process.env.NODE_ENV === "production";

export const pgPool = new Pool({
  connectionString: conn,
  ssl: shouldUseSsl ? { rejectUnauthorized: false } : false,
});
