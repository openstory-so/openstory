import { afterAll, describe, expect, test } from "bun:test";
import { closeDatabase, db, testConnection } from "@/db";

describe("Database Connection", () => {
  afterAll(async () => {
    await closeDatabase();
  });

  test("should connect to database", async () => {
    const isConnected = await testConnection();
    expect(isConnected).toBe(true);
  });

  test("should execute simple query", async () => {
    const result = await db.execute("SELECT 1 as value");
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toEqual({ value: 1 });
  });

  test("should have schema loaded", () => {
    expect(db.query).toBeDefined();
    expect(db.query.teams).toBeDefined();
    expect(db.query.users).toBeDefined();
    expect(db.query.sequences).toBeDefined();
    expect(db.query.frames).toBeDefined();
    expect(db.query.styles).toBeDefined();
  });
});
