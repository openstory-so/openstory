import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

/**
 * Run database migrations
 * This script applies pending migrations to the database
 */
async function runMigrations() {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error("DATABASE_URL environment variable is not set");
  }

  console.log("🔄 Running database migrations...");

  // Create a connection for migrations
  const connection = postgres(connectionString, { max: 1 });
  const db = drizzle(connection);

  try {
    await migrate(db, { migrationsFolder: "./drizzle" });
    console.log("✅ Migrations completed successfully");
  } catch (error) {
    console.error("❌ Migration failed:", error);
    process.exit(1);
  } finally {
    await connection.end();
  }
}

runMigrations();

