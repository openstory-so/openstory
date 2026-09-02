/**
 * Shared ID validation schemas
 * ULID validation for all database entities
 */

import { isValidId } from '@/shared/id';
import { z } from 'zod';

/**
 * ULID schema validator
 * Validates that a string is a valid ULID (26 characters, Crockford's Base32)
 *
 * @example
 * ```ts
 * const schema = z.object({ id: ulidSchema });
 * schema.parse({ id: '01HF5Z8XKQYC5N8Z3KQXR6TBQM' }); // ✓
 * schema.parse({ id: 'invalid' }); // ✗
 * ```
 */
export const ulidSchema = z
  .string()
  .length(26, 'ULID must be exactly 26 characters')
  .refine((val) => isValidId(val), {
    message: 'Invalid ULID format',
  });

/**
 * Optional ULID schema
 * Allows undefined or null values
 */
export const ulidSchemaOptional = ulidSchema.optional();
