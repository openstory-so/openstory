import { z } from 'zod';
import { describe, expect, it } from 'vitest';
// Static, not a dynamic import inside the test: pulling in the whole start
// instance takes seconds under full-suite load and would blow the timeout.
import { startInstance } from '@/start';
import {
  ConfigurationError,
  ConnectionError,
  DatabaseError,
  errorCode,
  errorMessage,
  handleApiError,
  InsufficientCreditsError,
  isInsufficientCreditsError,
  openStoryErrorSerializationAdapter,
  StorageError,
  ValidationError,
  OpenStoryError,
} from './errors';

describe('OpenStoryError', () => {
  it('should create an error with all properties', () => {
    const error = new OpenStoryError('Test error', 'TEST_CODE', 400, {
      extra: 'data',
    });

    expect(error.message).toBe('Test error');
    expect(error.code).toBe('TEST_CODE');
    expect(error.statusCode).toBe(400);
    expect(error.details).toEqual({ extra: 'data' });
    expect(error.name).toBe('OpenStoryError');
  });

  it('should use default status code of 500', () => {
    const error = new OpenStoryError('Test error', 'TEST_CODE');
    expect(error.statusCode).toBe(500);
  });

  it('should serialize to JSON correctly', () => {
    const error = new OpenStoryError('Test error', 'TEST_CODE', 400, {
      extra: 'data',
    });

    const json = error.toJSON();
    expect(json).toEqual({
      name: 'OpenStoryError',
      message: 'Test error',
      code: 'TEST_CODE',
      statusCode: 400,
      details: { extra: 'data' },
    });
  });
});

describe('Custom Error Classes', () => {
  describe('DatabaseError', () => {
    it('should create a database error with 500 status', () => {
      const error = new DatabaseError('Database connection failed', {
        table: 'users',
      });

      expect(error.message).toBe('Database connection failed');
      expect(error.code).toBe('DATABASE_ERROR');
      expect(error.statusCode).toBe(500);
      expect(error.details).toEqual({ table: 'users' });
      expect(error.name).toBe('DatabaseError');
    });
  });

  describe('ConnectionError', () => {
    it('should create a connection error with 503 status', () => {
      const error = new ConnectionError('Service unavailable', {
        service: 'some-service',
      });

      expect(error.message).toBe('Service unavailable');
      expect(error.code).toBe('CONNECTION_ERROR');
      expect(error.statusCode).toBe(503);
      expect(error.details).toEqual({ service: 'some-service' });
      expect(error.name).toBe('ConnectionError');
    });
  });

  describe('ValidationError', () => {
    it('should create a validation error with 400 status', () => {
      const error = new ValidationError('Invalid input', {
        field: 'email',
      });

      expect(error.message).toBe('Invalid input');
      expect(error.code).toBe('VALIDATION_ERROR');
      expect(error.statusCode).toBe(400);
      expect(error.details).toEqual({ field: 'email' });
      expect(error.name).toBe('ValidationError');
    });
  });

  describe('ConfigurationError', () => {
    it('should create a configuration error with 500 status', () => {
      const error = new ConfigurationError('Missing environment variable', {
        variable: 'POSTGRES_URL',
      });

      expect(error.message).toBe('Missing environment variable');
      expect(error.code).toBe('CONFIGURATION_ERROR');
      expect(error.statusCode).toBe(500);
      expect(error.details).toEqual({ variable: 'POSTGRES_URL' });
      expect(error.name).toBe('ConfigurationError');
    });
  });

  describe('StorageError', () => {
    it('should create a storage error with 500 status', () => {
      const error = new StorageError('Failed to upload file', {
        bucket: 'images',
      });

      expect(error.message).toBe('Failed to upload file');
      expect(error.code).toBe('STORAGE_ERROR');
      expect(error.statusCode).toBe(500);
      expect(error.details).toEqual({ bucket: 'images' });
      expect(error.name).toBe('StorageError');
    });
  });
});

describe('handleApiError', () => {
  it('should return OpenStoryError instance as is', () => {
    const openStoryError = new DatabaseError('Test error');
    const result = handleApiError(openStoryError);
    expect(result).toBe(openStoryError);
  });

  it('should convert standard Error to OpenStoryError', () => {
    const standardError = new Error('Standard error');
    const result = handleApiError(standardError);

    expect(result).toBeInstanceOf(OpenStoryError);
    expect(result.message).toBe('Standard error');
    expect(result.code).toBe('INTERNAL_ERROR');
    expect(result.statusCode).toBe(500);
    expect(result.details).toEqual({ originalError: 'Error' });
  });

  it('should handle unknown error types', () => {
    const unknownError = { weird: 'object' };
    const result = handleApiError(unknownError);

    expect(result).toBeInstanceOf(OpenStoryError);
    expect(result.message).toBe('An unknown error occurred');
    expect(result.code).toBe('UNKNOWN_ERROR');
    expect(result.statusCode).toBe(500);
    expect(result.details).toEqual({ originalError: 'object' });
  });

  it('should handle null and undefined errors', () => {
    const nullResult = handleApiError(null);
    expect(nullResult.message).toBe('An unknown error occurred');
    expect(nullResult.details).toEqual({ originalError: 'object' });

    const undefinedResult = handleApiError(undefined);
    expect(undefinedResult.message).toBe('An unknown error occurred');
    expect(undefinedResult.details).toEqual({ originalError: 'undefined' });
  });

  it('should handle string errors', () => {
    const result = handleApiError('String error');
    expect(result.message).toBe('An unknown error occurred');
    expect(result.code).toBe('UNKNOWN_ERROR');
    expect(result.details).toEqual({ originalError: 'string' });
  });
});

describe('errorCode / isInsufficientCreditsError', () => {
  it('reads code from a live OpenStoryError', () => {
    const ours = new InsufficientCreditsError('Insufficient credits for image');
    expect(errorCode(ours)).toBe('INSUFFICIENT_CREDITS');
    expect(isInsufficientCreditsError(ours)).toBe(true);
    expect(ours.message).toBe('Insufficient credits for image');
  });

  it('matches our error across the server-fn boundary but not a provider’s', () => {
    // The serialization adapter reconstitutes a thrown OpenStoryError with
    // the same own props (code/statusCode/details) — not the original
    // subclass. See #1087/#1099.
    const acrossBoundary = Object.assign(
      new Error('Insufficient credits for image'),
      {
        name: 'InsufficientCreditsError',
        code: 'INSUFFICIENT_CREDITS',
        statusCode: 402,
      }
    );
    expect(isInsufficientCreditsError(acrossBoundary)).toBe(true);
    expect(errorCode(acrossBoundary)).toBe('INSUFFICIENT_CREDITS');

    // OpenRouter's own balance — pinned in llm-client.test.ts. Routing this to
    // our billing dialog sends the user to top up an account that is fine.
    // Message prose alone must never open the dialog.
    expect(
      isInsufficientCreditsError(
        new Error(
          'Insufficient credits. Add more using https://openrouter.ai/settings/credits'
        )
      )
    ).toBe(false);
    expect(
      errorCode(
        new Error(
          'Insufficient credits. Add more using https://openrouter.ai/settings/credits'
        )
      )
    ).toBeUndefined();
  });

  it('preserves code/statusCode/details through the serialization adapter', () => {
    // The adapter is the ONLY reason `code` reaches the client: TanStack
    // Router's ShallowErrorPlugin matches every Error and keeps `message`
    // alone. Without this round-trip the billing gate silently stops opening.
    const original = new InsufficientCreditsError(
      'Insufficient credits for image',
      { needed: 10 }
    );
    const restored: unknown =
      openStoryErrorSerializationAdapter.fromSerializable(
        openStoryErrorSerializationAdapter.toSerializable(original)
      );

    expect(restored).toBeInstanceOf(Error);
    // Subclass identity is intentionally lost — discriminate on the code.
    expect(restored).not.toBeInstanceOf(InsufficientCreditsError);
    expect(restored).toMatchObject({
      name: 'InsufficientCreditsError',
      message: 'Insufficient credits for image',
      code: 'INSUFFICIENT_CREDITS',
      statusCode: 402,
      details: { needed: 10 },
    });
    expect(isInsufficientCreditsError(restored)).toBe(true);
  });

  it('survives details it cannot serialize rather than failing the error', () => {
    // A throw inside error serialization would replace the real error with an
    // opaque one, so the gate would never open.
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const restored: unknown =
      openStoryErrorSerializationAdapter.fromSerializable(
        openStoryErrorSerializationAdapter.toSerializable(
          new InsufficientCreditsError('Insufficient credits', circular)
        )
      );

    expect(isInsufficientCreditsError(restored)).toBe(true);
    if (!(restored instanceof OpenStoryError)) {
      throw new Error('expected an OpenStoryError');
    }
    expect(restored.details).toBeUndefined();
  });

  it('stays registered in createStart', async () => {
    // Drop the adapter from src/start.ts and everything still typechecks and
    // every other test still passes — the only symptom would be the billing
    // gate quietly never opening again. This is the guard for that.
    const options = await startInstance.getOptions();

    expect(options.serializationAdapters).toContain(
      openStoryErrorSerializationAdapter
    );
  });

  it('surfaces the plain message for display', () => {
    const ours = new InsufficientCreditsError('Insufficient credits for image');
    expect(errorMessage(ours)).toBe('Insufficient credits for image');
    expect(errorMessage(new Error(ours.message))).toBe(
      'Insufficient credits for image'
    );
  });
});

describe('errorMessage', () => {
  // A raw Zod issue array reached users as `status_error` and the enhance
  // banner (#1285) — both live ZodErrors and ones flattened to `message` by
  // the server-fn boundary collapse to one line.
  it('collapses Zod issues to one path: message line', () => {
    const live = z
      .object({ category: z.enum(['film', 'tech']), name: z.string().min(1) })
      .safeParse({ category: 'documentary', name: '' }).error;
    expect(live).toBeDefined();
    expect(errorMessage(live)).toBe(
      'category: Invalid option: expected one of "film"|"tech"; name: Too small: expected string to have >=1 characters'
    );
    expect(errorMessage(new Error(live?.message ?? ''))).toBe(
      errorMessage(live)
    );
  });

  it('leaves non-Zod messages alone, even bracketed ones', () => {
    expect(errorMessage(new Error('[LLM] timed out'))).toBe('[LLM] timed out');
    expect(errorMessage(new Error('[1, 2]'))).toBe('[1, 2]');
    expect(errorMessage('nope', 'fallback')).toBe('fallback');
  });
});
