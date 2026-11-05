const STATUS_ERROR_CODES = {
  400: 'BAD_REQUEST',
  401: 'AUTHENTICATION_REQUIRED',
  403: 'PERMISSION_DENIED',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  422: 'VALIDATION_ERROR',
  429: 'RATE_LIMITED'
};

/** Convert thrown route errors into the stable, non-sensitive API error envelope. */
export function toHttpErrorResponse(error, requestId, environment = 'development') {
  const status = error.status || 500;
  const message = status >= 500 && environment === 'production'
    ? 'Unexpected server error'
    : error.message || 'Unexpected server error';

  return {
    status,
    payload: {
      error: message,
      code: status >= 500 ? 'INTERNAL_ERROR' : error.code || STATUS_ERROR_CODES[status] || 'INTERNAL_ERROR',
      requestId
    },
    headers: error.retryAfterSeconds
      ? { 'retry-after': String(error.retryAfterSeconds) }
      : {}
  };
}