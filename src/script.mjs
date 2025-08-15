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

async function lookupUserByEmail(email, token) {
  const url = new URL('https://slack.com/api/users.lookupByEmail');
  url.searchParams.append('email', email);

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': token.startsWith('Bearer ') ? token : `Bearer ${token}`,
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

async function resetUserSessions(userId, token) {
  const url = 'https://slack.com/api/admin.users.session.reset';

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': token.startsWith('Bearer ') ? token : `Bearer ${token}`,
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
  invoke: async (params, context) => {
    console.log('Starting Slack Revoke Session action');

    try {
      validateInputs(params);

      const { userEmail } = params;

      console.log(`Processing user email: ${userEmail}`);

      if (!context.secrets?.SLACK_TOKEN) {
        throw new FatalError('Missing required secret: SLACK_TOKEN');
      }

      // Step 1: Look up user by email
      console.log(`Looking up Slack user by email: ${userEmail}`);
      const user = await lookupUserByEmail(userEmail, context.secrets.SLACK_TOKEN);
      console.log(`Found user with ID: ${user.id}`);

      // Add delay between API calls to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 100));

      // Step 2: Reset user sessions
      console.log(`Resetting sessions for user: ${user.id}`);
      await resetUserSessions(user.id, context.secrets.SLACK_TOKEN);

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
    console.error(`Error handler invoked: ${error?.message}`);

    // Re-throw to let framework handle retries
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