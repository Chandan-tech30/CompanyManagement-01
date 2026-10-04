// An error whose message is safe (and useful) to show to the user.
class UserError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'UserError';
    this.status = status;
    this.expose = true;
  }
}

function wantsJson(req) {
  return Boolean(req.xhr || req.headers['x-requested-with'] === 'XMLHttpRequest' ||
    ((req.headers.accept || '').includes('application/json') && !req.headers['hx-request']));
}

module.exports = { UserError, wantsJson };
