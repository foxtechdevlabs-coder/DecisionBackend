// Express 4 does not catch rejected promises from async route handlers —
// an unexpected error would otherwise just hang the request instead of
// reaching the error-handling middleware. Wrap async handlers with this so
// every failure still produces a response.
export function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}
