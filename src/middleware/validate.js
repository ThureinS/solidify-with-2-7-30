const { AppError } = require('./errorHandler');

// Validates req[source] (default: body) against a zod schema.
// On success, stores the parsed (and type-coerced) data back on the request.
//
// req.query is a special case: Express 5 made it a read-only getter that
// re-parses the URL on every access, so it can't be reassigned or mutated.
// Validated query params go on req.validatedQuery instead.
function validate(schema, source = 'body') {
  return (req, res, next) => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      return next(new AppError(400, 'VALIDATION_ERROR', result.error.issues[0].message));
    }
    if (source === 'query') {
      req.validatedQuery = result.data;
    } else {
      req[source] = result.data;
    }
    next();
  };
}

module.exports = validate;
