import { beforeAll, afterAll, jest } from '@jest/globals';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { request } from 'https';
import script from '../src/script.mjs';

const FIXTURES_DIR = '__recordings__';
const FIXTURE_FILE = `${FIXTURES_DIR}/slack-revoke-session.json`;
const IS_RECORDING = process.env.RECORD_MODE === 'true';

function loadFixtures() {
  if (existsSync(FIXTURE_FILE)) {
    return JSON.parse(readFileSync(FIXTURE_FILE, 'utf-8'));
  }
  return {};
}

function saveFixtures(fixtures) {
  if (!existsSync(FIXTURES_DIR)) mkdirSync(FIXTURES_DIR, { recursive: true });
  writeFileSync(FIXTURE_FILE, JSON.stringify(fixtures, null, 2));
}

function httpsRequest(url, options) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const body = options.body;
    const reqOptions = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: options.method || 'GET',
      headers: {
        ...options.headers,
        ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {})
      }
    };
    const req = request(reqOptions, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        const isJson = res.headers['content-type']?.includes('application/json');
        const parsedBody = isJson ? JSON.parse(data) : data;
        resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, statusText: res.statusMessage, body: parsedBody });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function makeRecordReplayFetch(fixtures, key) {
  return async (url, options) => {
    // Always use pre-injected fixtures first (synthetic responses)
    if (fixtures[key]) {
      const f = fixtures[key];
      return {
        ok: f.ok, status: f.status, statusText: f.statusText,
        json: async () => f.body,
        text: async () => (typeof f.body === 'string' ? f.body : JSON.stringify(f.body))
      };
    }
    if (IS_RECORDING) {
      const res = await httpsRequest(url, options || {});
      fixtures[key] = { status: res.status, ok: res.ok, statusText: res.statusText, body: res.body };
      return {
        ok: res.ok, status: res.status, statusText: res.statusText,
        json: async () => res.body,
        text: async () => (typeof res.body === 'string' ? res.body : JSON.stringify(res.body))
      };
    }
    throw new Error(`No fixture for "${key}". Run with RECORD_MODE=true first.`);
  };
}

// WHY SYNTHETIC FIXTURES FOR admin.users.session.reset?
//
// The admin.users.session.reset endpoint is only available on Slack Enterprise Grid
// (paid enterprise plan). It requires a user token (xoxp-) with the admin.users:write
// scope, which itself can only be installed on Enterprise workspaces.
//
// Attempting to use a regular bot token (xoxb-) or installing admin scopes on a free
// workspace both return "not_allowed_token_type" or block installation entirely with:
// "Apps with this feature are only available to Enterprise customers."
//
// As a result, we cannot record real responses for this endpoint in a standard test
// workspace. Instead, we pre-inject synthetic fixtures that accurately match the
// documented Slack API response shapes for success and known error cases.
// The users.lookupByEmail calls are still recorded against the real Slack API.
function injectAdminFixtures(fixtures) {
  if (!IS_RECORDING) return;

  // Successful session reset response
  const successReset = { status: 200, ok: true, statusText: 'OK', body: { ok: true } };
  fixtures['revoke-session-reset'] = successReset;
  fixtures['revoke-idempotency-reset-1'] = successReset;
  fixtures['revoke-idempotency-reset-2'] = successReset;
  fixtures['revoke-missing-scope-reset'] = { status: 200, ok: true, statusText: 'OK', body: { ok: false, error: 'missing_scope' } };
  fixtures['revoke-delay-reset'] = successReset;
}

describe('Slack Revoke Session - Record & Replay', () => {
  let fixtures = {};

  beforeAll(() => {
    fixtures = loadFixtures();
    injectAdminFixtures(fixtures);
  });

  afterAll(() => {
    if (IS_RECORDING) saveFixtures(fixtures);
  });

  beforeEach(() => {
    fetch.mockClear();
    jest.spyOn(global, 'setTimeout').mockImplementation((fn) => fn());
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const context = {
    environment: { ADDRESS: 'https://slack.com' },
    secrets: { BEARER_AUTH_TOKEN: process.env.SLACK_BOT_TOKEN || 'xoxb-fake-token' },
    outputs: {}
  };

  test('should look up user and revoke sessions successfully', async () => {
    fetch
      .mockImplementationOnce(makeRecordReplayFetch(fixtures, 'revoke-user-lookup'))
      .mockImplementationOnce(makeRecordReplayFetch(fixtures, 'revoke-session-reset'));

    const result = await script.invoke({
      userEmail: process.env.SLACK_USER_EMAIL || 'test@example.com'
    }, context);

    expect(result.sessionsRevoked).toBe(true);
    expect(result.userId).toBeDefined();
    expect(result.userId).toMatch(/^U/);
    expect(result.userEmail).toBe(process.env.SLACK_USER_EMAIL || 'test@example.com');
    expect(result.revokedAt).toBeDefined();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test('should be idempotent - second call succeeds with no active sessions', async () => {
    fetch
      .mockImplementationOnce(makeRecordReplayFetch(fixtures, 'revoke-idempotency-lookup-1'))
      .mockImplementationOnce(makeRecordReplayFetch(fixtures, 'revoke-idempotency-reset-1'))
      .mockImplementationOnce(makeRecordReplayFetch(fixtures, 'revoke-idempotency-lookup-2'))
      .mockImplementationOnce(makeRecordReplayFetch(fixtures, 'revoke-idempotency-reset-2'));

    // Reuse the user lookup fixture for idempotency calls
    if (IS_RECORDING) {
      fixtures['revoke-idempotency-lookup-1'] = fixtures['revoke-user-lookup'];
      fixtures['revoke-idempotency-lookup-2'] = fixtures['revoke-user-lookup'];
    }

    const params = { userEmail: process.env.SLACK_USER_EMAIL || 'test@example.com' };
    const r1 = await script.invoke(params, context);
    const r2 = await script.invoke(params, context);

    expect(r1.sessionsRevoked).toBe(true);
    expect(r2.sessionsRevoked).toBe(true);
    expect(r1.userId).toBe(r2.userId);
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  test('should handle missing_scope on session reset', async () => {
    if (IS_RECORDING) {
      fixtures['revoke-missing-scope-lookup'] = fixtures['revoke-user-lookup'];
    }

    fetch
      .mockImplementationOnce(makeRecordReplayFetch(fixtures, 'revoke-missing-scope-lookup'))
      .mockImplementationOnce(makeRecordReplayFetch(fixtures, 'revoke-missing-scope-reset'));

    await expect(script.invoke({
      userEmail: process.env.SLACK_USER_EMAIL || 'test@example.com'
    }, context)).rejects.toThrow('Token missing required scope: admin.users:write');
  });

  test('should handle invalid auth token', async () => {
    if (IS_RECORDING) {
      fixtures['revoke-invalid-auth-lookup'] = {
        status: 200, ok: true, statusText: 'OK',
        body: { ok: false, error: 'invalid_auth' }
      };
    }

    fetch.mockImplementationOnce(makeRecordReplayFetch(fixtures, 'revoke-invalid-auth-lookup'));

    await expect(script.invoke({
      userEmail: process.env.SLACK_USER_EMAIL || 'test@example.com'
    }, context)).rejects.toThrow('Invalid or missing authentication token');

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test('should handle rate limiting (retryable error)', async () => {
    if (IS_RECORDING) {
      fixtures['revoke-rate-limit-lookup'] = {
        status: 429, ok: false, statusText: 'Too Many Requests',
        body: { ok: false, error: 'ratelimited' }
      };
    }

    fetch.mockImplementationOnce(makeRecordReplayFetch(fixtures, 'revoke-rate-limit-lookup'));

    const error = await script.invoke({
      userEmail: process.env.SLACK_USER_EMAIL || 'test@example.com'
    }, context).catch(e => e);

    expect(error.message).toMatch(/rate limit/i);
    expect(error.retryable).toBe(true);
  });

  test('should handle missing auth token without making API calls', async () => {
    await expect(script.invoke({
      userEmail: process.env.SLACK_USER_EMAIL || 'test@example.com'
    }, { environment: { ADDRESS: 'https://slack.com' }, secrets: {}, outputs: {} }))
      .rejects.toThrow(/No authentication configured/);

    expect(fetch).not.toHaveBeenCalled();
  });

  test('should validate invalid email format without making API calls', async () => {
    await expect(script.invoke({ userEmail: 'not-an-email' }, context))
      .rejects.toThrow('Invalid email format');

    expect(fetch).not.toHaveBeenCalled();
  });

  test('should validate missing email without making API calls', async () => {
    await expect(script.invoke({}, context))
      .rejects.toThrow('Invalid or missing userEmail parameter');

    expect(fetch).not.toHaveBeenCalled();
  });

  test('should respect custom delay between lookup and reset', async () => {
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout').mockImplementation((fn) => fn());

    if (IS_RECORDING) {
      fixtures['revoke-delay-lookup'] = fixtures['revoke-user-lookup'];
    }

    fetch
      .mockImplementationOnce(makeRecordReplayFetch(fixtures, 'revoke-delay-lookup'))
      .mockImplementationOnce(makeRecordReplayFetch(fixtures, 'revoke-delay-reset'));

    await script.invoke({
      userEmail: process.env.SLACK_USER_EMAIL || 'test@example.com',
      delay: '200ms'
    }, context);

    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 200);
    setTimeoutSpy.mockRestore();
  });
});