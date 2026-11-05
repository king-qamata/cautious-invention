export function buildHealthSnapshot({ status, startedAt, uptimeMs, checks }) {
  const normalizedChecks = {
    dataStore: Boolean(checks?.dataStore),
    documentDir: Boolean(checks?.documentDir)
  };

  if (checks && typeof checks === 'object') {
    for (const [key, value] of Object.entries(checks)) {
      if (key === 'dataStore' || key === 'documentDir') continue;
      normalizedChecks[key] = Boolean(value);
    }
  }

  const degraded = Object.values(normalizedChecks).some((value) => value === false);
  const failedChecks = Object.entries(normalizedChecks)
    .filter(([, value]) => value === false)
    .map(([key]) => key);
  const snapshot = {
    status: status === 'ok' && !degraded ? 'ok' : 'degraded',
    startedAt,
    uptimeMs,
    uptimeSeconds: Number((uptimeMs / 1000).toFixed(2)),
    checks: normalizedChecks,
    summary: degraded
      ? `Health degraded: ${failedChecks.join(', ')} check failed.`
      : 'All required dependencies are healthy.'
  };

  return snapshot;
}
