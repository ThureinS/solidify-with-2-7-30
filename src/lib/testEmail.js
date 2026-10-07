// example.com, example.net and example.org are reserved for testing
// (RFC 2606): no real person owns a mailbox there. Test and seed accounts
// use them, so sending to them only produces bounce mails in our Gmail inbox.
const TEST_DOMAINS = ['example.com', 'example.net', 'example.org'];

function isTestEmail(email) {
  const domain = String(email).split('@').pop().toLowerCase();
  return TEST_DOMAINS.some((test) => domain === test || domain.endsWith(`.${test}`));
}

module.exports = { isTestEmail };
