import script from '../src/script.mjs';
import { jest } from '@jest/globals';
import { SGNL_USER_AGENT } from '@sgnl-actions/utils';

describe('Slack Revoke Session Script', () => {
  const mockContext = {
    environment: { ADDRESS: 'https://slack.com' },
    secrets: { BEARER_AUTH_TOKEN: 'xoxb-test-token' },
    outputs: {}
  };

  const successLookup = () => Promise.resolve({
    ok: true,
    json: async () => ({ ok: true, user: { id: 'U123456' } })
  });

  const successReset = () => Promise.resolve({
    ok: true,
    json: async () => ({ ok: true })
  });

  beforeEach(() => {
    fetch.mockClear();
    jest.spyOn(global, 'setTimeout').mockImplementation((fn) => fn());
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('invoke handler - success', () => {
    test('should look up user and revoke sessions successfully', async () => {
      fetch.mockImplementationOnce(successLookup).mockImplementationOnce(successReset);

      const result = await script.invoke({ userEmail: 'user@example.com' }, mockContext);

      expect(fetch).toHaveBeenCalledTimes(2);
      expect(result.sessionsRevoked).toBe(true);
      expect(result.userId).toBe('U123456');
      expect(result.userEmail).toBe('user@example.com');
      expect(result.revokedAt).toBeDefined();
    });

    test('should call users.lookupByEmail with correct URL and headers', async () => {
      fetch.mockImplementationOnce(successLookup).mockImplementationOnce(successReset);

      await script.invoke({ userEmail: 'user@example.com' }, mockContext);

      expect(fetch).toHaveBeenNthCalledWith(1,
        'https://slack.com/api/users.lookupByEmail?email=user%40example.com',
        {
          method: 'GET',
          headers: {
            'Authorization': 'Bearer xoxb-test-token',
            'Content-Type': 'application/json',
            'User-Agent': SGNL_USER_AGENT
          }
        }
      );
    });

    test('should call admin.users.session.reset with correct URL and headers', async () => {
      fetch.mockImplementationOnce(successLookup).mockImplementationOnce(successReset);

      await script.invoke({ userEmail: 'user@example.com' }, mockContext);

      expect(fetch).toHaveBeenNthCalledWith(2,
        'https://slack.com/api/admin.users.session.reset',
        {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer xoxb-test-token',
            'Content-Type': 'application/json',
            'User-Agent': SGNL_USER_AGENT
          },
          body: JSON.stringify({ user_id: 'U123456' })
        }
      );
    });

    test('should encode email with special characters in lookup URL', async () => {
      fetch.mockImplementationOnce(successLookup).mockImplementationOnce(successReset);

      await script.invoke({ userEmail: 'user+test@example.com' }, mockContext);

      expect(fetch).toHaveBeenNthCalledWith(1,
        'https://slack.com/api/users.lookupByEmail?email=user%2Btest%40example.com',
        expect.any(Object)
      );
    });

    test('should use custom address from params over environment ADDRESS', async () => {
      fetch.mockImplementationOnce(successLookup).mockImplementationOnce(successReset);

      await script.invoke({
        userEmail: 'user@example.com',
        address: 'https://custom-proxy.example.com'
      }, mockContext);

      expect(fetch).toHaveBeenNthCalledWith(1,
        expect.stringContaining('https://custom-proxy.example.com'),
        expect.any(Object)
      );
    });
  });

  describe('invoke handler - idempotency', () => {
    test('should succeed on first call', async () => {
      fetch.mockImplementationOnce(successLookup).mockImplementationOnce(successReset);

      const result = await script.invoke({ userEmail: 'user@example.com' }, mockContext);

      expect(result.sessionsRevoked).toBe(true);
    });

    test('should succeed on second identical call (no active sessions)', async () => {
      // Second call: sessions already revoked, reset still returns ok:true
      fetch.mockImplementationOnce(successLookup).mockImplementationOnce(successReset);

      const result = await script.invoke({ userEmail: 'user@example.com' }, mockContext);

      expect(result.sessionsRevoked).toBe(true);
    });

    test('should produce same result on repeated calls', async () => {
      fetch
        .mockImplementationOnce(successLookup).mockImplementationOnce(successReset)
        .mockImplementationOnce(successLookup).mockImplementationOnce(successReset);

      const r1 = await script.invoke({ userEmail: 'user@example.com' }, mockContext);
      const r2 = await script.invoke({ userEmail: 'user@example.com' }, mockContext);

      expect(r1.sessionsRevoked).toBe(r2.sessionsRevoked);
      expect(r1.userId).toBe(r2.userId);
      expect(r1.userEmail).toBe(r2.userEmail);
    });
  });

  describe('invoke handler - input validation', () => {
    test('should throw for missing userEmail', async () => {
      await expect(script.invoke({}, mockContext))
        .rejects.toThrow('Invalid or missing userEmail parameter');
      expect(fetch).not.toHaveBeenCalled();
    });

    test('should throw for empty userEmail', async () => {
      await expect(script.invoke({ userEmail: '   ' }, mockContext))
        .rejects.toThrow('Invalid or missing userEmail parameter');
      expect(fetch).not.toHaveBeenCalled();
    });

    test('should throw for invalid email format', async () => {
      await expect(script.invoke({ userEmail: 'not-an-email' }, mockContext))
        .rejects.toThrow('Invalid email format');
      expect(fetch).not.toHaveBeenCalled();
    });

    test('should throw for missing auth token', async () => {
      await expect(script.invoke(
        { userEmail: 'user@example.com' },
        { ...mockContext, secrets: {} }
      )).rejects.toThrow('No authentication configured');
      expect(fetch).not.toHaveBeenCalled();
    });
  });

  describe('invoke handler - lookup errors', () => {
    test('should throw FatalError for user not found', async () => {
      fetch.mockImplementationOnce(() => Promise.resolve({
        ok: true,
        json: async () => ({ ok: false, error: 'users_not_found' })
      }));

      const err = await script.invoke({ userEmail: 'user@example.com' }, mockContext).catch(e => e);
      expect(err.message).toMatch(/User not found/);
      expect(err.retryable).toBe(false);
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    test('should throw FatalError for invalid_auth during lookup', async () => {
      fetch.mockImplementationOnce(() => Promise.resolve({
        ok: true,
        json: async () => ({ ok: false, error: 'invalid_auth' })
      }));

      const err = await script.invoke({ userEmail: 'user@example.com' }, mockContext).catch(e => e);
      expect(err.message).toBe('Invalid or missing authentication token');
      expect(err.retryable).toBe(false);
    });

    test('should throw RetryableError for rate limit during lookup', async () => {
      fetch.mockImplementationOnce(() => Promise.resolve({
        ok: false, status: 429, statusText: 'Too Many Requests'
      }));

      const err = await script.invoke({ userEmail: 'user@example.com' }, mockContext).catch(e => e);
      expect(err.message).toMatch(/rate limit/i);
      expect(err.retryable).toBe(true);
    });

    test('should throw RetryableError for 5xx during lookup', async () => {
      fetch.mockImplementationOnce(() => Promise.resolve({
        ok: false, status: 500, statusText: 'Internal Server Error'
      }));

      const err = await script.invoke({ userEmail: 'user@example.com' }, mockContext).catch(e => e);
      expect(err.retryable).toBe(true);
    });

    test('should throw FatalError when lookup returns no user ID', async () => {
      fetch.mockImplementationOnce(() => Promise.resolve({
        ok: true,
        json: async () => ({ ok: true, user: {} })
      }));

      await expect(script.invoke({ userEmail: 'user@example.com' }, mockContext))
        .rejects.toThrow();
    });
  });

  describe('invoke handler - reset errors', () => {
    test('should throw FatalError for missing_scope on reset', async () => {
      fetch.mockImplementationOnce(successLookup).mockImplementationOnce(() => Promise.resolve({
        ok: true,
        json: async () => ({ ok: false, error: 'missing_scope' })
      }));

      const err = await script.invoke({ userEmail: 'user@example.com' }, mockContext).catch(e => e);
      expect(err.message).toBe('Token missing required scope: admin.users:write');
      expect(err.retryable).toBe(false);
    });

    test('should throw RetryableError for rate limit on reset', async () => {
      fetch.mockImplementationOnce(successLookup).mockImplementationOnce(() => Promise.resolve({
        ok: false, status: 429, statusText: 'Too Many Requests'
      }));

      const err = await script.invoke({ userEmail: 'user@example.com' }, mockContext).catch(e => e);
      expect(err.message).toMatch(/rate limit/i);
      expect(err.retryable).toBe(true);
    });

    test('should throw FatalError for token_revoked on reset', async () => {
      fetch.mockImplementationOnce(successLookup).mockImplementationOnce(() => Promise.resolve({
        ok: true,
        json: async () => ({ ok: false, error: 'token_revoked' })
      }));

      const err = await script.invoke({ userEmail: 'user@example.com' }, mockContext).catch(e => e);
      expect(err.message).toBe('Authentication token is inactive or revoked');
      expect(err.retryable).toBe(false);
    });

    test('should throw FatalError for HTTP error on reset', async () => {
      fetch.mockImplementationOnce(successLookup).mockImplementationOnce(() => Promise.resolve({
        ok: false, status: 403, statusText: 'Forbidden'
      }));

      const err = await script.invoke({ userEmail: 'user@example.com' }, mockContext).catch(e => e);
      expect(err.message).toMatch(/403 Forbidden/);
      expect(err.retryable).toBe(false);
    });
  });

  describe('invoke handler - delay/parseDuration', () => {
    test('should use default 100ms delay when not specified', async () => {
      fetch.mockImplementationOnce(successLookup).mockImplementationOnce(successReset);
      const spy = jest.spyOn(global, 'setTimeout').mockImplementation((fn) => fn());

      await script.invoke({ userEmail: 'user@example.com' }, mockContext);

      expect(spy).toHaveBeenCalledWith(expect.any(Function), 100);
    });

    test('should parse delay in milliseconds', async () => {
      fetch.mockImplementationOnce(successLookup).mockImplementationOnce(successReset);
      const spy = jest.spyOn(global, 'setTimeout').mockImplementation((fn) => fn());

      await script.invoke({ userEmail: 'user@example.com', delay: '500ms' }, mockContext);

      expect(spy).toHaveBeenCalledWith(expect.any(Function), 500);
    });

    test('should parse delay in seconds', async () => {
      fetch.mockImplementationOnce(successLookup).mockImplementationOnce(successReset);
      const spy = jest.spyOn(global, 'setTimeout').mockImplementation((fn) => fn());

      await script.invoke({ userEmail: 'user@example.com', delay: '2s' }, mockContext);

      expect(spy).toHaveBeenCalledWith(expect.any(Function), 2000);
    });

    test('should fall back to 100ms for invalid delay format', async () => {
      fetch.mockImplementationOnce(successLookup).mockImplementationOnce(successReset);
      const spy = jest.spyOn(global, 'setTimeout').mockImplementation((fn) => fn());

      await script.invoke({ userEmail: 'user@example.com', delay: 'invalid' }, mockContext);

      expect(spy).toHaveBeenCalledWith(expect.any(Function), 100);
    });
  });

  describe('error handler', () => {
    test('should re-throw error for framework to handle', async () => {
      const error = new Error('Network timeout');
      error.statusCode = 500;

      await expect(script.error({ userEmail: 'user@example.com', error }, mockContext))
        .rejects.toThrow('Network timeout');
    });
  });

  describe('halt handler', () => {
    test('should handle graceful shutdown with userEmail', async () => {
      const result = await script.halt({ userEmail: 'user@example.com', reason: 'timeout' }, mockContext);

      expect(result.userEmail).toBe('user@example.com');
      expect(result.reason).toBe('timeout');
      expect(result.haltedAt).toBeDefined();
      expect(result.cleanupCompleted).toBe(true);
    });

    test('should handle halt with missing userEmail', async () => {
      const result = await script.halt({ reason: 'system_shutdown' }, mockContext);

      expect(result.userEmail).toBe('unknown');
      expect(result.reason).toBe('system_shutdown');
      expect(result.cleanupCompleted).toBe(true);
    });

    test('should handle halt with missing reason', async () => {
      const result = await script.halt({ userEmail: 'user@example.com' }, mockContext);

      expect(result.reason).toBe('unknown');
      expect(result.cleanupCompleted).toBe(true);
    });
  });
});