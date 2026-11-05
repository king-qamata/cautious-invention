import assert from 'node:assert/strict';
import test from 'node:test';

import { toHttpErrorResponse } from '../src/http-errors.js';

test('HTTP error response maps validation errors and includes request ID', () => {
  const response = toHttpErrorResponse(
    Object.assign(new Error('Email is invalid.'), { status: 422 }),
    'req-validation-1'
  );

  assert.equal(response.status, 422);
  assert.deepEqual(response.payload, {
    error: 'Email is invalid.',
    code: 'VALIDATION_ERROR',
    requestId: 'req-validation-1'
  });
  assert.deepEqual(response.headers, {});
});

test('HTTP error response redacts production server errors and preserves retry timing', () => {
  const response = toHttpErrorResponse(
    Object.assign(new Error('internal database detail'), { status: 500, retryAfterSeconds: 12 }),
    'req-server-1',
    'production'
  );

  assert.equal(response.status, 500);
  assert.deepEqual(response.payload, {
    error: 'Unexpected server error',
    code: 'INTERNAL_ERROR',
    requestId: 'req-server-1'
  });
  assert.deepEqual(response.headers, { 'retry-after': '12' });
});

test('HTTP error response preserves explicit domain error codes', () => {
  const response = toHttpErrorResponse(
    Object.assign(new Error('Consultation already claimed.'), { status: 409, code: 'CLAIM_CONFLICT' }),
    'req-conflict-1'
  );

  assert.equal(response.payload.code, 'CLAIM_CONFLICT');
});