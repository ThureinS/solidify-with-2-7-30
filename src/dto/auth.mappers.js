const { DEMO_ACCOUNT_EMAIL } = require('../lib/demoAccount');

function toAuthUser(user) {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    isSuspended: user.isSuspended,
    createdAt: user.createdAt.toISOString(),
    // Lets the frontend say "read-only" up front. The demo email still lives
    // only on the server; blockDemoWrites is what actually enforces it.
    isDemo: user.email === DEMO_ACCOUNT_EMAIL,
  };
}

module.exports = { toAuthUser };
