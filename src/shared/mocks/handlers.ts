import { http, HttpResponse } from 'msw';

/**
 * Creates a mock SSE stream for the realtime endpoint.
 * Returns a connected message then keeps connection minimal.
 */
function createMockSSEStream() {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      // Send initial connected message
      controller.enqueue(
        encoder.encode('data: {"type":"connected","channel":"default"}\n\n')
      );
    },
  });
  return stream;
}

/**
 * MSW handlers for mocking API requests in Storybook and tests
 * These handlers intercept fetch requests and return mock data
 */
export const handlers = [
  // GET /api/realtime - Mock SSE endpoint for the realtime Durable Object
  http.get('/api/realtime', () => {
    return new HttpResponse(createMockSSEStream(), {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  }),

  // GET /api/user/me - Get current user
  http.get('/api/user/me', () => {
    return HttpResponse.json({
      success: true,
      data: {
        user: {
          id: 'mock-user-id',
          email: 'demo@example.com',
          name: 'Demo User',
          emailVerified: false,
          image: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        isAuthenticated: true,
        isAnonymous: false,
        teamId: 'demo-team',
        teamRole: 'owner',
        teamName: 'Demo Team',
      },
    });
  }),

  // POST /api/auth/sign-in/anonymous - Create anonymous session
  http.post('/api/auth/sign-in/anonymous', () => {
    return HttpResponse.json({
      user: {
        id: 'mock-anonymous-user',
        email: null,
        name: 'Anonymous User',
        emailVerified: false,
        image: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      session: {
        id: 'mock-session-id',
        userId: 'mock-anonymous-user',
        expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24), // 24 hours
        token: 'mock-token',
        ipAddress: '127.0.0.1',
        userAgent: 'Mozilla/5.0',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
  }),

  // GET /api/auth/get-session - Get current session
  http.get('/api/auth/get-session', () => {
    return HttpResponse.json({
      user: {
        id: 'mock-user-id',
        email: 'demo@example.com',
        name: 'Demo User',
        emailVerified: false,
        image: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      session: {
        id: 'mock-session-id',
        userId: 'mock-user-id',
        expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24),
        token: 'mock-token',
        ipAddress: '127.0.0.1',
        userAgent: 'Mozilla/5.0',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
  }),
];
