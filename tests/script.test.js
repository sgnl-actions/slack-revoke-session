import script from '../src/script.mjs';
import { SGNL_USER_AGENT } from '@sgnl-actions/utils';

describe('Slack Revoke Session Script', () => {
  const mockContext = {
    environment: {
      ADDRESS: 'https://slack.com'
    },
    secrets: {
      BEARER_AUTH_TOKEN: 'xoxb-test-token'
    },
    outputs: {}
  };

  beforeEach(() => {
    // Mock console to avoid noise in tests
    global.console.log = () => {};
    global.console.error = () => {};
  });

  describe('invoke handler', () => {
    test('should throw error for missing userEmail', async () => {
      const params = {};

      await expect(script.invoke(params, mockContext))
        .rejects.toThrow('Invalid or missing userEmail parameter');
    });

    test('should throw error for invalid email format', async () => {
      const params = {
        userEmail: 'not-an-email'
      };

      await expect(script.invoke(params, mockContext))
        .rejects.toThrow('Invalid email format');
    });

    test('should throw error for missing BEARER_AUTH_TOKEN', async () => {
      const params = {
        userEmail: 'user@example.com'
      };

      const contextWithoutToken = {
        ...mockContext,
        secrets: {}
      };

      await expect(script.invoke(params, contextWithoutToken))
        .rejects.toThrow('No authentication configured');
    });

    test('should validate empty userEmail', async () => {
      const params = {
        userEmail: '   '
      };

      await expect(script.invoke(params, mockContext))
        .rejects.toThrow('Invalid or missing userEmail parameter');
    });

    test('should include User-Agent header in all API calls', async () => {
      const params = {
        userEmail: 'user@example.com'
      };

      const capturedRequests = [];
      global.fetch = async (url, options) => {
        capturedRequests.push({ url, options });

        // Lookup call
        if (url.includes('lookupByEmail')) {
          return {
            ok: true,
            json: async () => ({ ok: true, user: { id: 'U123' } })
          };
        }

        // Reset sessions call
        return {
          ok: true,
          json: async () => ({ ok: true })
        };
      };

      await script.invoke(params, mockContext);

      expect(capturedRequests.length).toBe(2);
      for (const req of capturedRequests) {
        expect(req.options.headers['User-Agent']).toBe(SGNL_USER_AGENT);
      }
    });

    // Note: Testing actual Slack API calls would require mocking fetch
    // or integration tests with real Slack credentials
  });

  describe('error handler', () => {
    test('should re-throw error for framework to handle', async () => {
      const error = new Error('Network timeout');
      error.statusCode = 500;

      const params = {
        userEmail: 'user@example.com',
        error: error
      };

      await expect(script.error(params, mockContext))
        .rejects.toThrow('Network timeout');
    });
  });

  describe('halt handler', () => {
    test('should handle graceful shutdown', async () => {
      const params = {
        userEmail: 'user@example.com',
        reason: 'timeout'
      };

      const result = await script.halt(params, mockContext);

      expect(result.userEmail).toBe('user@example.com');
      expect(result.reason).toBe('timeout');
      expect(result.haltedAt).toBeDefined();
      expect(result.cleanupCompleted).toBe(true);
    });

    test('should handle halt with missing params', async () => {
      const params = {
        reason: 'system_shutdown'
      };

      const result = await script.halt(params, mockContext);

      expect(result.userEmail).toBe('unknown');
      expect(result.reason).toBe('system_shutdown');
      expect(result.cleanupCompleted).toBe(true);
    });
  });
});