export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function requireValue(condition, message) {
  if (!condition) throw new ApiError(400, 'VALIDATION_ERROR', message);
}
