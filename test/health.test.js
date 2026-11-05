import test from 'node:test';
import assert from 'node:assert/strict';

import { buildHealthSnapshot } from '../src/health.js';

test('buildHealthSnapshot reports app health when dependencies are healthy', () => {
  const snapshot = buildHealthSnapshot({
    status: 'ok',
    startedAt: '2026-01-01T00:00:00.000Z',
    uptimeMs: 1000,
    checks: {
      dataStore: true,
      documentDir: true
    }
  });

  assert.equal(snapshot.status, 'ok');
  assert.equal(snapshot.checks.dataStore, true);
  assert.equal(snapshot.checks.documentDir, true);
  assert.ok(snapshot.uptimeSeconds >= 1);
});

test('buildHealthSnapshot reports degraded health when dependencies fail', () => {
  const snapshot = buildHealthSnapshot({
    status: 'ok',
    startedAt: '2026-01-01T00:00:00.000Z',
    uptimeMs: 1000,
    checks: {
      dataStore: false,
      documentDir: true
    }
  });

  assert.equal(snapshot.status, 'degraded');
  assert.equal(snapshot.checks.dataStore, false);
  assert.ok(snapshot.summary.includes('dataStore'));
});

test('buildHealthSnapshot includes operational service checks when provided', () => {
  const snapshot = buildHealthSnapshot({
    status: 'ok',
    startedAt: '2026-01-01T00:00:00.000Z',
    uptimeMs: 1000,
    checks: {
      dataStore: true,
      documentDir: true,
      consultationWorkflow: false,
      paymentIntegrity: true,
      notificationPipeline: true
    }
  });

  assert.equal(snapshot.status, 'degraded');
  assert.equal(snapshot.checks.consultationWorkflow, false);
  assert.ok(snapshot.summary.includes('consultationWorkflow'));
});
