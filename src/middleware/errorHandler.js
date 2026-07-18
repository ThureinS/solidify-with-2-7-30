const { Prisma } = require('@prisma/client');

class AppError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (err instanceof AppError) {
    return res.status(err.status).json({ error: { message: err.message, code: err.code } });
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') {
      return res
        .status(409)
        .json({ error: { message: 'A record with that value already exists', code: 'CONFLICT' } });
    }
    if (err.code === 'P2025') {
      return res.status(404).json({ error: { message: 'Not found', code: 'NOT_FOUND' } });
    }
  }

  console.error(err);
  res.status(500).json({ error: { message: 'Something went wrong', code: 'INTERNAL_ERROR' } });
}

module.exports = { AppError, errorHandler };
