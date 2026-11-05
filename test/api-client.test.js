import assert from 'node:assert/strict';
import test from 'node:test';

import { ApiError, createApiClient } from '../public/js/api-client.js';

function mockResponse({ status = 200, payload = {}, contentType = 'application/json', requestId = '' } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        if (name === 'content-type') return contentType;
        if (name === 'x-request-id') return requestId;
        if (name === 'retry-after') return '';
        return null;
      }
    },
    async json() {
      return payload;
    }
  };
}

async function withFetch(t, fetchImplementation, run) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImplementation;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  await run();
}

test('API client returns data from successful JSON responses', async (t) => {
  await withFetch(t, async () => mockResponse({ payload: { data: { ready: true } } }), async () => {
    const api = createApiClient({ token: 'token' });
    assert.deepEqual(await api('/api/v1/health'), { ready: true });
  });
});

test('API client preserves validation message and request ID', async (t) => {
  await withFetch(t, async () => mockResponse({
    status: 422,
    payload: { error: 'Email is invalid.', code: 'VALIDATION_ERROR', requestId: 'req-test-1' }
  }), async () => {
    const api = createApiClient({ token: '' });
    await assert.rejects(api('/api/v1/account/profile'), (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.message, 'Email is invalid.');
      assert.equal(error.status, 422);
      assert.equal(error.code, 'VALIDATION_ERROR');
      assert.equal(error.requestId, 'req-test-1');
      return true;
    });
  });
});

test('API client rejects unexpected successful response formats clearly', async (t) => {
  await withFetch(t, async () => mockResponse({ contentType: 'text/html', requestId: 'req-html-1' }), async () => {
    const api = createApiClient({ token: '' });
    await assert.rejects(api('/api/v1/catalogue'), (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.code, 'INVALID_RESPONSE');
      assert.equal(error.requestId, 'req-html-1');
      assert.match(error.message, /unexpected response/i);
      return true;
    });
  });
});

test('API client gives a clear message when the network is unavailable', async (t) => {
  await withFetch(t, async () => {
    throw new TypeError('Failed to fetch');
  }, async () => {
    const api = createApiClient({ token: '' });
    await assert.rejects(api('/api/v1/catalogue'), (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.message, 'Unable to connect. Check your connection and try again.');
      assert.equal(error.code, 'NETWORK_ERROR');
      return true;
    });
  });
});