import { getBaseURL, getAuthorizationHeader} from '@sgnl-actions/utils';

class RetryableError extends Error {
  constructor(message) {
    super(message);
    this.retryable = true;
  }
}

class FatalError extends Error {
  constructor(message) {
    super(message);
    this.retryable = false;
  }
}

function parseDuration(durationStr) {
  if (!durationStr) return 100; // default 100ms

  const match = durationStr.match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/i);
  if (!match) {
    console.warn(`Invalid duration format: ${durationStr}, using default 100ms`);
    return 100;
  }

  const value = parseFloat(match[1]);
  const unit = (match[2] || 'ms').toLowerCase();

  switch (unit) {
    case 'ms':
      return value;
    case 's':
      return value * 1000;
    case 'm':
      return value * 60 * 1000;
    case 'h':
      return value * 60 * 60 * 1000;
    default:
      return value;
  }
}

async function lookupUserByEmail(email, authHeader, baseUrl = 'https://slack.com') {
  const encodedEmail = encodeURIComponent(email);
  const url = `${baseUrl.replace(/\/$/, '')}/api/users.lookupByEmail?email=${encodedEmail}`;

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': authHeader,
      'Content-Type': 'application/json'
    }
  });

  if (!response.ok) {
    if (response.status === 429) {
      throw new RetryableError('Slack API rate limit exceeded');
    }
    if (response.status >= 500) {
      throw new RetryableError(`Slack API error: ${response.status}`);
    }
    throw new FatalError(`Failed to lookup user: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();

  if (!data.ok) {
    if (data.error === 'users_not_found') {
      throw new FatalError(`User not found with email: ${email}`);
    }
    if (data.error === 'invalid_auth' || data.error === 'not_authed') {
      throw new FatalError('Invalid or missing authentication token');
    }
    if (data.error === 'account_inactive' || data.error === 'token_revoked') {
      throw new FatalError('Authentication token is inactive or revoked');
    }
    throw new FatalError(`Slack API error: ${data.error}`);
  }

  return data.user;
}

async function resetUserSessions(userId, authHeader, baseUrl = 'https://slack.com') {
  const url = `${baseUrl.replace(/\/$/, '')}/api/admin.users.session.reset`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': authHeader,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      user_id: userId
    })
  });

  if (!response.ok) {
    if (response.status === 429) {
      throw new RetryableError('Slack API rate limit exceeded');
    }
    if (response.status >= 500) {
      throw new RetryableError(`Slack API error: ${response.status}`);
    }
    throw new FatalError(`Failed to reset sessions: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();

  if (!data.ok) {
    if (data.error === 'user_not_found') {
      throw new FatalError(`User not found: ${userId}`);
    }
    if (data.error === 'invalid_auth' || data.error === 'not_authed') {
      throw new FatalError('Invalid or missing authentication token');
    }
    if (data.error === 'missing_scope') {
      throw new FatalError('Token missing required scope: admin.users:write');
    }
    if (data.error === 'account_inactive' || data.error === 'token_revoked') {
      throw new FatalError('Authentication token is inactive or revoked');
    }
    throw new FatalError(`Slack API error: ${data.error}`);
  }

  return true;
}

function validateInputs(params) {
  if (!params.userEmail || typeof params.userEmail !== 'string' || params.userEmail.trim() === '') {
    throw new FatalError('Invalid or missing userEmail parameter');
  }

  // Basic email validation
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(params.userEmail)) {
    throw new FatalError('Invalid email format');
  }
}

export default {
  /**
   * Main execution handler - revokes all active sessions for a Slack user by email
   * @param {Object} params - Job input parameters
   * @param {string} params.userEmail - Email address of the Slack user (required)
   * @param {string} params.delay - Optional delay between API calls (e.g., 100ms, 1s)
   * @param {string} params.address - Optional Slack API base URL
   * @param {Object} context - Execution context with secrets and environment
   * @param {string} context.environment.ADDRESS - Default Slack API base URL
   *
   * The configured auth type will determine which of the following environment variables and secrets are available
   * @param {string} context.secrets.BEARER_AUTH_TOKEN
   *
   * @param {string} context.secrets.OAUTH2_AUTHORIZATION_CODE_ACCESS_TOKEN
   *
   * @returns {Promise<Object>} Action result
   */
  invoke: async (params, context) => {
    console.log('Starting Slack Revoke Session action');

    try {
      validateInputs(params);

      const { userEmail, delay } = params;

      console.log(`Processing user email: ${userEmail}`);

      const authHeader = await getAuthorizationHeader(context);

      // Get base URL using utility function
      const baseUrl = getBaseURL(params, context);

      // Parse delay duration
      const delayMs = parseDuration(delay);

      // Step 1: Look up user by email
      console.log(`Looking up Slack user by email: ${userEmail}`);
      const user = await lookupUserByEmail(userEmail, authHeader, baseUrl);
      console.log(`Found user with ID: ${user.id}`);

      // Add delay between API calls to avoid rate limiting
      console.log(`Waiting ${delayMs}ms before resetting sessions`);
      await new Promise(resolve => setTimeout(resolve, delayMs));

      // Step 2: Reset user sessions
      console.log(`Resetting sessions for user: ${user.id}`);
      await resetUserSessions(user.id, authHeader, baseUrl);

      const result = {
        userEmail,
        userId: user.id,
        sessionsRevoked: true,
        revokedAt: new Date().toISOString()
      };

      console.log(`Successfully revoked sessions for user: ${userEmail}`);
      return result;

    } catch (error) {
      console.error(`Error revoking Slack sessions: ${error.message}`);

      if (error instanceof RetryableError || error instanceof FatalError) {
        throw error;
      }

      throw new FatalError(`Unexpected error: ${error.message}`);
    }
  },

  error: async (params, _context) => {
    const { error } = params;
    throw error;
  },

  halt: async (params, _context) => {
    const { reason, userEmail } = params;
    console.log(`Job is being halted (${reason})`);

    return {
      userEmail: userEmail || 'unknown',
      reason: reason || 'unknown',
      haltedAt: new Date().toISOString(),
      cleanupCompleted: true
    };
  }
};