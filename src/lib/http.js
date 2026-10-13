// Express 4 does not catch rejected promises; route handlers go through this.
export const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
