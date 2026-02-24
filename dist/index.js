// SGNL Job Script - Auto-generated bundle
'use strict';

/**
 * SGNL Actions - Authentication Utilities
 *
 * Shared authentication utilities for SGNL actions.
 * Supports: Bearer Token, Basic Auth, OAuth2 Client Credentials, OAuth2 Authorization Code
 */

/**
 * User-Agent header value for all SGNL CAEP Hub requests.
 */
const SGNL_USER_AGENT = 'SGNL-CAEP-Hub/2.0';

/**
 * Get OAuth2 access token using client credentials flow
 * @param {Object} config - OAuth2 configuration
 * @param {string} config.tokenUrl - Token endpoint URL
 * @param {string} config.clientId - Client ID
 * @param {string} config.clientSecret - Client secret
 * @param {string} [config.scope] - OAuth2 scope
 * @param {string} [config.audience] - OAuth2 audience
 * @param {string} [config.authStyle] - Auth style: 'InParams' or 'InHeader' (default)
 * @returns {Promise<string>} Access token
 */
async function getClientCredentialsToken(config) {
  const { tokenUrl, clientId, clientSecret, scope, audience, authStyle } = config;

  if (!tokenUrl || !clientId || !clientSecret) {
    throw new Error('OAuth2 Client Credentials flow requires tokenUrl, clientId, and clientSecret');
  }

  const params = new URLSearchParams();
  params.append('grant_type', 'client_credentials');

  if (scope) {
    params.append('scope', scope);
  }

  if (audience) {
    params.append('audience', audience);
  }

  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Accept': 'application/json',
    'User-Agent': SGNL_USER_AGENT
  };

  if (authStyle === 'InParams') {
    params.append('client_id', clientId);
    params.append('client_secret', clientSecret);
  } else {
    const credentials = btoa(`${clientId}:${clientSecret}`);
    headers['Authorization'] = `Basic ${credentials}`;
  }

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers,
    body: params.toString()
  });

  if (!response.ok) {
    let errorText;
    try {
      const errorData = await response.json();
      errorText = JSON.stringify(errorData);
    } catch {
      errorText = await response.text();
    }
    throw new Error(
      `OAuth2 token request failed: ${response.status} ${response.statusText} - ${errorText}`
    );
  }

  const data = await response.json();

  if (!data.access_token) {
    throw new Error('No access_token in OAuth2 response');
  }

  return data.access_token;
}

/**
 * Get the Authorization header value from context using available auth method.
 * Supports: Bearer Token, Basic Auth, OAuth2 Authorization Code, OAuth2 Client Credentials
 *
 * @param {Object} context - Execution context with environment and secrets
 * @param {Object} context.environment - Environment variables
 * @param {Object} context.secrets - Secret values
 * @returns {Promise<string>} Authorization header value (e.g., "Bearer xxx" or "Basic xxx")
 */
async function getAuthorizationHeader(context) {
  const env = context.environment || {};
  const secrets = context.secrets || {};

  // Method 1: Simple Bearer Token
  if (secrets.BEARER_AUTH_TOKEN) {
    const token = secrets.BEARER_AUTH_TOKEN;
    return token.startsWith('Bearer ') ? token : `Bearer ${token}`;
  }

  // Method 2: Basic Auth (username + password)
  if (secrets.BASIC_PASSWORD && secrets.BASIC_USERNAME) {
    const credentials = btoa(`${secrets.BASIC_USERNAME}:${secrets.BASIC_PASSWORD}`);
    return `Basic ${credentials}`;
  }

  // Method 3: OAuth2 Authorization Code - use pre-existing access token
  if (secrets.OAUTH2_AUTHORIZATION_CODE_ACCESS_TOKEN) {
    const token = secrets.OAUTH2_AUTHORIZATION_CODE_ACCESS_TOKEN;
    return token.startsWith('Bearer ') ? token : `Bearer ${token}`;
  }

  // Method 4: OAuth2 Client Credentials - fetch new token
  if (secrets.OAUTH2_CLIENT_CREDENTIALS_CLIENT_SECRET) {
    const tokenUrl = env.OAUTH2_CLIENT_CREDENTIALS_TOKEN_URL;
    const clientId = env.OAUTH2_CLIENT_CREDENTIALS_CLIENT_ID;
    const clientSecret = secrets.OAUTH2_CLIENT_CREDENTIALS_CLIENT_SECRET;

    if (!tokenUrl || !clientId) {
      throw new Error('OAuth2 Client Credentials flow requires TOKEN_URL and CLIENT_ID in env');
    }

    const token = await getClientCredentialsToken({
      tokenUrl,
      clientId,
      clientSecret,
      scope: env.OAUTH2_CLIENT_CREDENTIALS_SCOPE,
      audience: env.OAUTH2_CLIENT_CREDENTIALS_AUDIENCE,
      authStyle: env.OAUTH2_CLIENT_CREDENTIALS_AUTH_STYLE
    });

    return `Bearer ${token}`;
  }

  throw new Error(
    'No authentication configured. Provide one of: ' +
    'BEARER_AUTH_TOKEN, BASIC_USERNAME/BASIC_PASSWORD, ' +
    'OAUTH2_AUTHORIZATION_CODE_ACCESS_TOKEN, or OAUTH2_CLIENT_CREDENTIALS_*'
  );
}

/**
 * Get the base URL/address for API calls
 * @param {Object} params - Request parameters
 * @param {string} [params.address] - Address from params
 * @param {Object} context - Execution context
 * @returns {string} Base URL
 */
function getBaseURL(params, context) {
  const env = context.environment || {};
  const address = params?.address || env.ADDRESS;

  if (!address) {
    throw new Error('No URL specified. Provide address parameter or ADDRESS environment variable');
  }

  // Remove trailing slash if present
  return address.endsWith('/') ? address.slice(0, -1) : address;
}

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
      'Content-Type': 'application/json',
      'User-Agent': SGNL_USER_AGENT
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
      'Content-Type': 'application/json',
      'User-Agent': SGNL_USER_AGENT
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

var script = {
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

module.exports = script;
