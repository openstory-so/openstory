import { describe, expect, it, vi } from 'vitest';

const capture = vi.fn();
const identify = vi.fn();
vi.doMock('./posthog-server', () => ({
  getPostHogClient: () => ({ capture, identify }),
}));

const { captureProductEvent } = await import('./product-events');

describe('captureProductEvent', () => {
  it('forwards to posthog-node with distinctId + event', () => {
    capture.mockClear();
    identify.mockClear();
    captureProductEvent({
      distinctId: 'user_1',
      event: 'user_signed_up',
      properties: { email: 'a@b.com' },
    });
    expect(identify).not.toHaveBeenCalled();
    expect(capture).toHaveBeenCalledWith({
      distinctId: 'user_1',
      event: 'user_signed_up',
      properties: { email: 'a@b.com' },
    });
  });

  it('identifies the person and $sets person properties on the event (#1110)', () => {
    capture.mockClear();
    identify.mockClear();
    captureProductEvent({
      distinctId: 'user_1',
      event: 'user_signed_up',
      properties: {
        email: 'a@b.com',
        name: 'Ada',
        team_id: 'organization_1',
      },
      personProperties: {
        email: 'a@b.com',
        name: 'Ada',
      },
    });
    expect(identify).toHaveBeenCalledWith({
      distinctId: 'user_1',
      properties: { email: 'a@b.com', name: 'Ada' },
    });
    expect(capture).toHaveBeenCalledWith({
      distinctId: 'user_1',
      event: 'user_signed_up',
      properties: {
        email: 'a@b.com',
        name: 'Ada',
        team_id: 'organization_1',
        $set: { email: 'a@b.com', name: 'Ada' },
      },
    });
  });

  it('skips identify and $set when personProperties is empty', () => {
    capture.mockClear();
    identify.mockClear();
    captureProductEvent({
      distinctId: 'user_1',
      event: 'user_signed_in',
      properties: { path: '/api/auth/sign-in' },
      personProperties: {},
    });
    expect(identify).not.toHaveBeenCalled();
    expect(capture).toHaveBeenCalledWith({
      distinctId: 'user_1',
      event: 'user_signed_in',
      properties: { path: '/api/auth/sign-in' },
    });
  });
});
