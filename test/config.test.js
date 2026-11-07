import assert from 'node:assert/strict';
import test from 'node:test';

test('Vercel defaults application writes to its writable temporary directory', async () => {
  const previousVercel = process.env.VERCEL;
  process.env.VERCEL = '1';

  try {
    const { config } = await import(`../src/config.js?vercel-test=${Date.now()}`);
    assert.equal(config.dataFile, '/tmp/mindset-healthcare/mindset.json');
    assert.equal(config.documentDir, '/tmp/mindset-healthcare/documents');
  } finally {
    if (previousVercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = previousVercel;
  }
});
