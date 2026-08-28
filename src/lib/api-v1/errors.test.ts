import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ValidationError } from '@/lib/errors';
import { z } from 'zod';

const { mockWarn, mockError } = vi.hoisted(() => ({
  mockWarn: vi.fn(),
  mockError: vi.fn(),
}));

vi.mock('@/lib/observability/logger', () => ({
  getLogger: () => ({
    error: mockError,
    warn: mockWarn,
    info: vi.fn(),
    debug: vi.fn(),
  }),
  toErrorPayload: (error: unknown) => ({ message: String(error) }),
}));

const { runApiV1Handler } = await import('./errors');

describe('runApiV1Handler', () => {
  beforeEach(() => {
    mockWarn.mockClear();
    mockError.mockClear();
  });

  it('logs 4xx OpenStory errors at warn with the error code', async () => {
    const response = await runApiV1Handler(async () => {
      throw new ValidationError(
        'Character "Ada" reference image #2 could not be fetched (timeout): https://slow.example/a.png'
      );
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'VALIDATION_ERROR',
        message: expect.stringContaining('could not be fetched'),
        details: undefined,
      },
    });
    expect(mockWarn).toHaveBeenCalledWith(
      'api/v1 handler rejected: {code} {message}',
      expect.objectContaining({
        code: 'VALIDATION_ERROR',
        status: 400,
      })
    );
    expect(mockError).not.toHaveBeenCalled();
  });

  it('logs Zod validation failures at warn', async () => {
    await runApiV1Handler(async () => {
      throw new z.ZodError([
        {
          code: 'custom',
          path: ['script'],
          message: 'Required',
        },
      ]);
    });

    expect(mockWarn).toHaveBeenCalledWith(
      'api/v1 handler rejected: {code} {message}',
      expect.objectContaining({
        code: 'VALIDATION_ERROR',
        status: 400,
      })
    );
    expect(mockError).not.toHaveBeenCalled();
  });

  it('logs 5xx at error, not warn', async () => {
    const response = await runApiV1Handler(async () => {
      throw new Error('boom');
    });

    expect(response.status).toBe(500);
    expect(mockError).toHaveBeenCalled();
    expect(mockWarn).not.toHaveBeenCalled();
  });
});
