import { describe, expect, it } from "bun:test";
import {
  type InitializeDatabaseInput,
  initializeDatabaseSchema,
  type SetupStatusInput,
  setupStatusSchema,
} from "./setup";

describe("initializeDatabaseSchema", () => {
  describe("valid inputs", () => {
    it("should parse valid input with all fields", () => {
      const input = {
        skipIfExists: true,
        seedData: true,
      };

      const result = initializeDatabaseSchema.parse(input);
      expect(result).toEqual({
        skipIfExists: true,
        seedData: true,
      });
    });

    it("should apply default values when fields are missing", () => {
      const input = {};
      const result = initializeDatabaseSchema.parse(input);

      expect(result).toEqual({
        skipIfExists: false,
        seedData: false,
      });
    });

    it("should handle partial input with skipIfExists only", () => {
      const input = { skipIfExists: true };
      const result = initializeDatabaseSchema.parse(input);

      expect(result).toEqual({
        skipIfExists: true,
        seedData: false,
      });
    });

    it("should handle partial input with seedData only", () => {
      const input = { seedData: true };
      const result = initializeDatabaseSchema.parse(input);

      expect(result).toEqual({
        skipIfExists: false,
        seedData: true,
      });
    });

    it("should handle false values explicitly", () => {
      const input = {
        skipIfExists: false,
        seedData: false,
      };

      const result = initializeDatabaseSchema.parse(input);
      expect(result).toEqual({
        skipIfExists: false,
        seedData: false,
      });
    });
  });

  describe("invalid inputs", () => {
    it("should reject invalid skipIfExists type", () => {
      const input = { skipIfExists: "yes" };
      expect(() => initializeDatabaseSchema.parse(input)).toThrow();
    });

    it("should reject invalid seedData type", () => {
      const input = { seedData: 1 };
      expect(() => initializeDatabaseSchema.parse(input)).toThrow();
    });

    it("should reject null values", () => {
      const input = { skipIfExists: null };
      expect(() => initializeDatabaseSchema.parse(input)).toThrow();
    });

    it("should ignore extra fields", () => {
      const input = {
        skipIfExists: true,
        seedData: false,
        extraField: "should be ignored",
      };

      const result = initializeDatabaseSchema.parse(input);
      expect(result).toEqual({
        skipIfExists: true,
        seedData: false,
      });
      expect(result).not.toHaveProperty("extraField");
    });
  });

  describe("type inference", () => {
    it("should infer correct TypeScript types", () => {
      const validInput: InitializeDatabaseInput = {
        skipIfExists: true,
        seedData: false,
      };

      const result = initializeDatabaseSchema.parse(validInput);

      // Type checking - these should compile without errors
      const skipIfExists: boolean = result.skipIfExists;
      const seedData: boolean = result.seedData;

      expect(skipIfExists).toBe(true);
      expect(seedData).toBe(false);
    });

    it("should allow optional fields in type", () => {
      const validInput: InitializeDatabaseInput = {
        skipIfExists: false,
        seedData: false,
      };
      const result = initializeDatabaseSchema.parse(validInput);

      expect(result.skipIfExists).toBe(false);
      expect(result.seedData).toBe(false);
    });
  });
});

describe("setupStatusSchema", () => {
  describe("valid inputs", () => {
    it("should parse valid input with includeDetails true", () => {
      const input = { includeDetails: true };
      const result = setupStatusSchema.parse(input);

      expect(result).toEqual({
        includeDetails: true,
      });
    });

    it("should parse valid input with includeDetails false", () => {
      const input = { includeDetails: false };
      const result = setupStatusSchema.parse(input);

      expect(result).toEqual({
        includeDetails: false,
      });
    });

    it("should apply default value when includeDetails is missing", () => {
      const input = {};
      const result = setupStatusSchema.parse(input);

      expect(result).toEqual({
        includeDetails: false,
      });
    });
  });

  describe("invalid inputs", () => {
    it("should reject invalid includeDetails type", () => {
      const input = { includeDetails: "yes" };
      expect(() => setupStatusSchema.parse(input)).toThrow();
    });

    it("should reject numeric values", () => {
      const input = { includeDetails: 1 };
      expect(() => setupStatusSchema.parse(input)).toThrow();
    });

    it("should reject null value", () => {
      const input = { includeDetails: null };
      expect(() => setupStatusSchema.parse(input)).toThrow();
    });

    it("should ignore extra fields", () => {
      const input = {
        includeDetails: true,
        extraField: "should be ignored",
        anotherField: 123,
      };

      const result = setupStatusSchema.parse(input);
      expect(result).toEqual({
        includeDetails: true,
      });
      expect(result).not.toHaveProperty("extraField");
      expect(result).not.toHaveProperty("anotherField");
    });
  });

  describe("type inference", () => {
    it("should infer correct TypeScript types", () => {
      const validInput: SetupStatusInput = {
        includeDetails: true,
      };

      const result = setupStatusSchema.parse(validInput);

      // Type checking - this should compile without errors
      const includeDetails: boolean = result.includeDetails;
      expect(includeDetails).toBe(true);
    });

    it("should allow optional field in type", () => {
      const validInput: SetupStatusInput = {
        includeDetails: false,
      };
      const result = setupStatusSchema.parse(validInput);

      expect(result.includeDetails).toBe(false);
    });
  });

  describe("edge cases", () => {
    it("should handle undefined input", () => {
      // Undefined is not a valid input for Zod object schema
      expect(() => setupStatusSchema.parse(undefined)).toThrow();
    });

    it("should handle empty object", () => {
      const result = setupStatusSchema.parse({});
      expect(result).toEqual({
        includeDetails: false,
      });
    });

    it("should handle empty string as object key", () => {
      const input = { "": true, includeDetails: true };
      const result = setupStatusSchema.parse(input);

      expect(result).toEqual({
        includeDetails: true,
      });
    });
  });
});
