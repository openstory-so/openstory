import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

/**
 * Database connection configuration
 */
const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL environment variable is not set");
}

/**
 * PostgreSQL connection pool
 * Uses postgres.js for high-performance connection pooling
 */
export const connection = postgres(connectionString, {
  max: 10, // Maximum number of connections in the pool
  idle_timeout: 20, // Close idle connections after 20 seconds
  connect_timeout: 10, // Connection timeout in seconds
});

/**
 * Drizzle database instance
 * Type-safe database client with schema
 */
export const db = drizzle(connection, { schema });

/**
 * Close database connection
 * Call this when shutting down the application
 */
export async function closeDatabase() {
  await connection.end();
}

/**
 * Test database connection
 * Returns true if connection is successful
 */
export async function testConnection(): Promise<boolean> {
  try {
    await connection`SELECT 1`;
    return true;
  } catch (error) {
    console.error("Database connection test failed:", error);
    return false;
  }
}

