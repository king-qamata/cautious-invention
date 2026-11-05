const HTTP_ERROR_MESSAGES = {
  400: 'The request could not be understood. Check the information and try again.',
  401: 'Your session has expired. Sign in again to continue.',
  403: 'You do not have permission to perform this action.',
  404: 'The requested item could not be found. Refresh and try again.',
  409: 'This item changed or is already being handled. Refresh and try again.',
  413: 'The submitted content is too large. Reduce its size and try again.',
  422: 'Some information is missing or invalid. Review the form and try again.',
  429: 'Too many requests. Wait briefly, then try again.',
  500: 'The service encountered an unexpected problem. Try again shortly.'
};

export class ApiError extends Error {
  constructor(message, { status = null, code = 'REQUEST_FAILED', requestId = '', retryAfter = '' } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.retryAfter = retryAfter;
  }
}

function responseMessage(payload, status) {
  const error = payload?.error;
  if (typeof error === 'string' && error.trim()) return error;
  if (typeof error?.message === 'string' && error.message.trim()) return error.message;
  return HTTP_ERROR_MESSAGES[status] || 'The request could not be completed. Try again.';
}

async function readPayload(response) {
  if (response.status === 204) return null;
  const contentType = response.headers?.get?.('content-type') || '';
  if (!contentType.includes('application/json')) return null;

  try {
    return await response.json();
  } catch {
    return null;
  }
}

export function createApiClient(state) {
  return async function api(path, options = {}) {
    let response;
    try {
      response = await fetch(path, {
        ...options,
        headers: {
          'content-type': 'application/json',
          ...(state.token ? { authorization: `Bearer ${state.token}` } : {}),
          ...(options.headers || {})
        }
      });
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      throw new ApiError('Unable to connect. Check your connection and try again.', {
        code: 'NETWORK_ERROR'
      });
    }

    const payload = await readPayload(response);
    if (!response.ok) {
      const error = payload?.error;
      throw new ApiError(responseMessage(payload, response.status), {
        status: response.status,
        code: error?.code || payload?.code || `HTTP_${response.status}`,
        requestId: payload?.requestId || response.headers?.get?.('x-request-id') || '',
        retryAfter: response.headers?.get?.('retry-after') || ''
      });
    }

    if (!payload || !Object.hasOwn(payload, 'data')) {
      throw new ApiError('The service returned an unexpected response. Try again shortly.', {
        status: response.status,
        code: 'INVALID_RESPONSE',
        requestId: response.headers?.get?.('x-request-id') || ''
      });
    }

    return payload.data;
  };
}
