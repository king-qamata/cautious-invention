const CONSULTATION_PERF_START_MARK = 'mindset:consultation:startup-begin';
const CONSULTATION_PERF_FIRST_RENDER_MARK = 'mindset:consultation:first-meaningful-render';
const CONSULTATION_PERF_MEASURE = 'mindset:consultation:first-meaningful-render-ms';

export const CONSULTATION_PERF_HISTORY_KEY = 'mindset_consultation_perf_history';

const CONSULTATION_PERF_HISTORY_LIMIT = 30;
const DEFAULT_TREND_POINTS = 10;

function normalizeConsultationPerfMarker(raw) {
  if (!raw || raw.marker !== 'consultation_first_meaningful_render') return null;
  const duration = Number(raw.durationMs);
  const consultationCount = Number(raw.consultationCount);
  const atValue = raw.at ? new Date(raw.at).toISOString() : new Date().toISOString();
  return {
    marker: 'consultation_first_meaningful_render',
    durationMs: Number.isFinite(duration) ? Math.round(duration * 10) / 10 : null,
    source: String(raw.source || 'unknown'),
    usedPreloadedComms: Boolean(raw.usedPreloadedComms),
    consultationCount: Number.isFinite(consultationCount) ? consultationCount : 0,
    at: atValue
  };
}

function dedupeConsultationPerfMarkers(entries) {
  const seen = new Set();
  const result = [];
  for (const item of entries) {
    const marker = normalizeConsultationPerfMarker(item);
    if (!marker) continue;
    const signature = [
      marker.at,
      marker.durationMs,
      marker.source,
      marker.usedPreloadedComms,
      marker.consultationCount
    ].join('|');
    if (seen.has(signature)) continue;
    seen.add(signature);
    result.push(marker);
  }
  return result.slice(-CONSULTATION_PERF_HISTORY_LIMIT);
}

export function createStartupPerfTelemetryController(deps) {
  const {
    qs,
    e,
    trendPoints = DEFAULT_TREND_POINTS
  } = deps;

  const perfState = {
    startupConsultationMarkEmitted: false,
    startupStartedAt: 0,
    perfHistoryLoaded: false
  };

  function readConsultationPerfHistory() {
    try {
      const raw = localStorage.getItem(CONSULTATION_PERF_HISTORY_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return dedupeConsultationPerfMarkers(parsed);
    } catch {
      return [];
    }
  }

  function persistConsultationPerfHistory(entries) {
    try {
      localStorage.setItem(
        CONSULTATION_PERF_HISTORY_KEY,
        JSON.stringify(dedupeConsultationPerfMarkers(entries))
      );
    } catch {
      // Keep telemetry best-effort if localStorage is unavailable.
    }
  }

  function ensureConsultationPerfHistoryLoaded() {
    if (perfState.perfHistoryLoaded) return;
    const persisted = readConsultationPerfHistory();
    const current = Array.isArray(window.__mindsetPerf) ? window.__mindsetPerf : [];
    const merged = dedupeConsultationPerfMarkers([...persisted, ...current]);
    window.__mindsetPerf = merged;
    perfState.perfHistoryLoaded = true;
  }

  function consultationPerfMarkers() {
    ensureConsultationPerfHistoryLoaded();
    return Array.isArray(window.__mindsetPerf)
      ? dedupeConsultationPerfMarkers(window.__mindsetPerf)
      : [];
  }

  function latestConsultationPerfMarker() {
    const entries = consultationPerfMarkers();
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      if (entries[i]?.marker === 'consultation_first_meaningful_render') {
        return entries[i];
      }
    }
    return null;
  }

  function renderStartupPerfTelemetryPanel() {
    const grid = qs('#perfTelemetryGrid');
    const updatedAt = qs('#perfTelemetryUpdatedAt');
    if (!grid || !updatedAt) return;

    const marker = latestConsultationPerfMarker();
    const history = consultationPerfMarkers().slice(-trendPoints);
    if (!marker) {
      updatedAt.textContent = 'Waiting for startup marker.';
      grid.innerHTML = `
        <div class="metric">
          <span>First meaningful consultation render</span>
          <strong>--</strong>
          <div class="subtle">No marker captured yet.</div>
        </div>
      `;
      return;
    }

    const duration = Number.isFinite(Number(marker.durationMs)) ? `${Number(marker.durationMs)} ms` : '--';
    const source = String(marker.source || 'unknown').replace(/_/g, ' ');
    const usedComms = marker.usedPreloadedComms ? 'yes' : 'no';
    const consultationCount = Number.isFinite(Number(marker.consultationCount))
      ? Number(marker.consultationCount)
      : 0;
    const capturedAt = marker.at ? new Date(marker.at) : null;
    const capturedTimeLabel = capturedAt && !Number.isNaN(capturedAt.getTime())
      ? capturedAt.toLocaleTimeString()
      : '--';
    const durationSamples = history
      .map((item) => Number(item.durationMs))
      .filter((value) => Number.isFinite(value) && value >= 0);
    const peak = durationSamples.length ? Math.max(...durationSamples) : 1;
    const avgDuration = durationSamples.length
      ? Math.round((durationSamples.reduce((sum, value) => sum + value, 0) / durationSamples.length) * 10) / 10
      : null;
    const bestDuration = durationSamples.length ? Math.min(...durationSamples) : null;
    const trendBars = history.length
      ? history.map((item, index) => {
        const value = Number(item.durationMs);
        const isFiniteValue = Number.isFinite(value) && value >= 0;
        const height = isFiniteValue
          ? Math.max(14, Math.round((value / Math.max(peak, 1)) * 6) * 7 + 14)
          : 14;
        const barClass = `perf-trend-bar perf-trend-bar-height-${height}${index === history.length - 1 ? ' latest' : ''}`;
        const label = isFiniteValue ? `${value}ms` : 'n/a';
        return `<span class="${barClass}" title="${e(label)}"></span>`;
      }).join('')
      : '<span class="perf-trend-empty">No history yet.</span>';
    const avgLabel = avgDuration === null ? '--' : `${avgDuration} ms`;
    const bestLabel = bestDuration === null ? '--' : `${bestDuration} ms`;

    updatedAt.textContent = `Last marker: ${capturedTimeLabel}`;
    grid.innerHTML = `
      <div class="metric">
        <span>First meaningful consultation render</span>
        <strong>${e(duration)}</strong>
        <div class="subtle">From startup begin to first consultation workspace render.</div>
      </div>
      <div class="metric">
        <span>Payload source</span>
        <strong>${e(source)}</strong>
        <div class="subtle">How consultations were hydrated.</div>
      </div>
      <div class="metric">
        <span>Preloaded comms used</span>
        <strong>${e(usedComms)}</strong>
        <div class="subtle">First Communication Desk open used cached bootstrap data.</div>
      </div>
      <div class="metric">
        <span>Consultations in first render</span>
        <strong>${e(String(consultationCount))}</strong>
        <div class="subtle">Queue size at marker capture time.</div>
      </div>
      <div class="metric perf-trend-metric">
        <span>Last ${e(String(trendPoints))} startup renders</span>
        <div class="perf-trend-bars">${trendBars}</div>
        <div class="subtle">Avg ${e(avgLabel)} · Best ${e(bestLabel)} · Latest highlighted</div>
      </div>
    `;
  }

  function beginStartupConsultationPerf() {
    if (!window.performance?.mark) return;
    perfState.startupConsultationMarkEmitted = false;
    perfState.startupStartedAt = performance.now();
    performance.mark(CONSULTATION_PERF_START_MARK);
  }

  function markStartupConsultationFirstRender(meta = {}) {
    if (perfState.startupConsultationMarkEmitted) return;
    if (!window.performance?.mark) return;

    performance.mark(CONSULTATION_PERF_FIRST_RENDER_MARK);
    if (window.performance?.measure) {
      try {
        performance.measure(
          CONSULTATION_PERF_MEASURE,
          CONSULTATION_PERF_START_MARK,
          CONSULTATION_PERF_FIRST_RENDER_MARK
        );
      } catch {
        // Keep marker emission best-effort even if measure cannot be recorded.
      }
    }

    const durationMs = perfState.startupStartedAt
      ? Math.round((performance.now() - perfState.startupStartedAt) * 10) / 10
      : null;
    const marker = {
      marker: 'consultation_first_meaningful_render',
      durationMs,
      source: String(meta.source || 'unknown'),
      usedPreloadedComms: Boolean(meta.usedPreloadedComms),
      consultationCount: Number(meta.consultationCount || 0),
      at: new Date().toISOString()
    };

    const existing = consultationPerfMarkers();
    window.__mindsetPerf = dedupeConsultationPerfMarkers([...existing, marker]);
    persistConsultationPerfHistory(window.__mindsetPerf);
    window.dispatchEvent(new CustomEvent('mindset:perf', { detail: marker }));
    console.info('[mindset-perf]', marker);
    renderStartupPerfTelemetryPanel();
    perfState.startupConsultationMarkEmitted = true;
    return marker;
  }

  return {
    renderStartupPerfTelemetryPanel,
    beginStartupConsultationPerf,
    markStartupConsultationFirstRender
  };
}
