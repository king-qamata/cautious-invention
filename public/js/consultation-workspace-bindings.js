export const CONSULTATION_QUEUE_PRESET_KEY = 'mindset_consultation_filter_preset';
const CONSULTATION_SEARCH_DEBOUNCE_MS = 450;

export const consultationQueuePresetCatalog = {
  all_queue: {
    label: 'All queue',
    sort: 'recent',
    filters: {
      status: 'all',
      tier: 'all',
      search: ''
    }
  },
  needs_claim: {
    label: 'Needs claim',
    sort: 'claim_expiry',
    filters: {
      status: 'REQUESTED',
      tier: 'all',
      search: ''
    }
  },
  live_triage: {
    label: 'Live triage',
    sort: 'risk_score',
    filters: {
      status: 'IN_PROGRESS',
      tier: 'all',
      search: ''
    }
  },
  critical_followup: {
    label: 'Critical follow-up',
    sort: 'risk_score',
    filters: {
      status: 'IN_PROGRESS',
      tier: 'super_priority',
      search: ''
    }
  }
};

function normalizedSearch(value) {
  return String(value || '').trim();
}

function queueMatchesPreset(state, presetKey) {
  const preset = consultationQueuePresetCatalog[presetKey];
  if (!preset) return false;
  const filters = state.consultationQueueFilters || {};
  return (
    String(state.consultationQueueSortMode || 'recent') === String(preset.sort) &&
    String(filters.status || 'all') === String(preset.filters.status) &&
    String(filters.tier || 'all') === String(preset.filters.tier) &&
    normalizedSearch(filters.search) === normalizedSearch(preset.filters.search)
  );
}

function inferQueuePreset(state) {
  const keys = Object.keys(consultationQueuePresetCatalog);
  return keys.find((presetKey) => queueMatchesPreset(state, presetKey)) || 'custom';
}

export function inferQueuePresetFromQueueState(state) {
  return inferQueuePreset(state);
}

function persistQueueState(state) {
  const filters = state.consultationQueueFilters || {};
  localStorage.setItem('mindset_consultation_sort_mode', String(state.consultationQueueSortMode || 'recent'));
  localStorage.setItem('mindset_consultation_filter_status', String(filters.status || 'all'));
  localStorage.setItem('mindset_consultation_filter_tier', String(filters.tier || 'all'));
  localStorage.setItem('mindset_consultation_filter_search', normalizedSearch(filters.search));
  localStorage.setItem(CONSULTATION_QUEUE_PRESET_KEY, String(state.consultationQueuePreset || 'custom'));
}

function syncQueueInputControls(qs, state) {
  const presetInput = qs('#consultationFilterPreset');
  if (presetInput) {
    presetInput.value = String(state.consultationQueuePreset || 'custom');
  }

  const sortInput = qs('#consultationSortMode');
  if (sortInput) {
    sortInput.value = String(state.consultationQueueSortMode || 'recent');
  }

  const statusInput = qs('#consultationStatusFilter');
  if (statusInput) {
    statusInput.value = String(state.consultationQueueFilters?.status || 'all');
  }

  const tierInput = qs('#consultationTierFilter');
  if (tierInput) {
    tierInput.value = String(state.consultationQueueFilters?.tier || 'all');
  }

  const searchInput = qs('#consultationSearchFilter');
  if (searchInput) {
    searchInput.value = normalizedSearch(state.consultationQueueFilters?.search);
  }
}

function syncPresetChipState(qsa, state) {
  qsa('[data-consult-preset-chip]').forEach((button) => {
    const presetKey = String(button.dataset.consultPresetChip || '');
    const isActive = presetKey === String(state.consultationQueuePreset || 'custom');
    button.classList.toggle('active', isActive);
    button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
  });
}

function persistQueueSearchHint(qs, value) {
  const node = qs('#consultationSearchHint');
  if (!node) return;
  if (!value) {
    node.textContent = 'Type 3+ chars for live search, or press Enter.';
    return;
  }
  node.textContent = `Search queued: "${value}"`;
}

function applyQueuePreset(state, presetKey) {
  const preset = consultationQueuePresetCatalog[presetKey];
  if (!preset) {
    throw new Error('Unknown queue preset selected.');
  }
  state.consultationQueuePreset = presetKey;
  state.consultationQueueSortMode = preset.sort;
  state.consultationQueueFilters = {
    status: preset.filters.status,
    tier: preset.filters.tier,
    search: preset.filters.search
  };
}

export function bindConsultationWorkspaceHandlers(deps) {
  const {
    qs,
    qsa,
    state,
    notice,
    loadConsultations
  } = deps;

  async function applySearchValue(value, options = {}) {
    const nextValue = normalizedSearch(value);
    const announce = options.announce !== false;
    state.consultationQueueFilters.search = nextValue;
    state.consultationQueuePreset = inferQueuePreset(state);
    persistQueueState(state);
    syncQueueInputControls(qs, state);
    syncPresetChipState(qsa, state);
    persistQueueSearchHint(qs, nextValue);
    await loadConsultations();
    if (announce) {
      notice(nextValue ? 'Consultation search applied.' : 'Consultation search cleared.');
    }
  }

  function queueDebouncedSearchApply(rawValue) {
    const nextValue = normalizedSearch(rawValue);
    clearTimeout(state.consultationQueueSearchDebounceTimer);
    const qualifiesLiveSearch = nextValue.length === 0 || nextValue.length >= 3;
    if (!qualifiesLiveSearch) {
      persistQueueSearchHint(qs, nextValue);
      return;
    }
    state.consultationQueueSearchDebounceTimer = setTimeout(() => {
      applySearchValue(nextValue, { announce: false }).catch((error) => notice(error.message, true));
    }, CONSULTATION_SEARCH_DEBOUNCE_MS);
  }

  function cancelQueuedSearchApply() {
    clearTimeout(state.consultationQueueSearchDebounceTimer);
    state.consultationQueueSearchDebounceTimer = null;
  }

  function syncPresetFromQueueState() {
    state.consultationQueuePreset = inferQueuePreset(state);
    localStorage.setItem(CONSULTATION_QUEUE_PRESET_KEY, String(state.consultationQueuePreset || 'custom'));
    syncPresetChipState(qsa, state);
  }

  function applySavedQueuePresetIfAny() {
    const savedPreset = String(state.consultationQueuePreset || 'custom');
    if (savedPreset === 'custom') return;
    const preset = consultationQueuePresetCatalog[savedPreset];
    if (!preset) {
      state.consultationQueuePreset = 'custom';
      localStorage.setItem(CONSULTATION_QUEUE_PRESET_KEY, 'custom');
      return;
    }
    applyQueuePreset(state, savedPreset);
    persistQueueState(state);
  }

  applySavedQueuePresetIfAny();
  syncPresetFromQueueState();
  syncQueueInputControls(qs, state);
  syncPresetChipState(qsa, state);
  persistQueueSearchHint(qs, normalizedSearch(state.consultationQueueFilters.search));

  qs('#eventLogKindFilter').addEventListener('change', async (event) => {
    try {
      state.consultationEventLogKindFilter = event.target.value || 'all';
      state.consultationEventLogById = {};
      state.consultationEventLogErrorById = {};
      state.consultationEventLogLoadingById = {};
      await loadConsultations();
      notice('Consultation event log filter updated.');
    } catch (error) {
      notice(error.message, true);
    }
  });

  qs('#consultationFilterPreset').addEventListener('change', async (event) => {
    try {
      const presetKey = String(event.target.value || 'custom');
      if (presetKey === 'custom') {
        state.consultationQueuePreset = 'custom';
        persistQueueState(state);
        syncPresetChipState(qsa, state);
        notice('Queue preset cleared.');
        return;
      }

      applyQueuePreset(state, presetKey);
      persistQueueState(state);
      syncQueueInputControls(qs, state);
      syncPresetChipState(qsa, state);
      persistQueueSearchHint(qs, normalizedSearch(state.consultationQueueFilters.search));
      await loadConsultations();
      notice(`Consultation queue preset applied: ${consultationQueuePresetCatalog[presetKey].label}.`);
    } catch (error) {
      notice(error.message, true);
    }
  });

  qsa('[data-consult-preset-chip]').forEach((button) => {
    button.addEventListener('click', async () => {
      try {
        const presetKey = String(button.dataset.consultPresetChip || '');
        if (!presetKey) return;
        applyQueuePreset(state, presetKey);
        persistQueueState(state);
        syncQueueInputControls(qs, state);
        syncPresetChipState(qsa, state);
        persistQueueSearchHint(qs, normalizedSearch(state.consultationQueueFilters.search));
        await loadConsultations();
        notice(`Consultation queue preset applied: ${consultationQueuePresetCatalog[presetKey].label}.`);
      } catch (error) {
        notice(error.message, true);
      }
    });
  });

  qs('#consultationSortMode').addEventListener('change', async (event) => {
    try {
      state.consultationQueueSortMode = event.target.value || 'recent';
      syncPresetFromQueueState();
      persistQueueState(state);
      await loadConsultations();
      notice('Consultation queue sort updated.');
    } catch (error) {
      notice(error.message, true);
    }
  });

  qs('#consultationStatusFilter').addEventListener('change', async (event) => {
    try {
      state.consultationQueueFilters.status = event.target.value || 'all';
      syncPresetFromQueueState();
      persistQueueState(state);
      await loadConsultations();
      notice('Consultation status filter updated.');
    } catch (error) {
      notice(error.message, true);
    }
  });

  qs('#consultationTierFilter').addEventListener('change', async (event) => {
    try {
      state.consultationQueueFilters.tier = event.target.value || 'all';
      syncPresetFromQueueState();
      persistQueueState(state);
      await loadConsultations();
      notice('Consultation tier filter updated.');
    } catch (error) {
      notice(error.message, true);
    }
  });

  qs('#consultationSearchFilter').addEventListener('keydown', async (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    try {
      cancelQueuedSearchApply();
      await applySearchValue(event.target.value, { announce: true });
    } catch (error) {
      notice(error.message, true);
    }
  });

  qs('#consultationSearchFilter').addEventListener('input', (event) => {
    queueDebouncedSearchApply(event.target.value);
  });

  qs('#applyConsultationSearch').addEventListener('click', async () => {
    try {
      cancelQueuedSearchApply();
      await applySearchValue(qs('#consultationSearchFilter').value, { announce: true });
    } catch (error) {
      notice(error.message, true);
    }
  });

  qs('#consultationSearchFilter').addEventListener('blur', async (event) => {
    try {
      const nextValue = normalizedSearch(event.target.value);
      const currentValue = normalizedSearch(state.consultationQueueFilters.search);
      if (nextValue === currentValue) {
        persistQueueSearchHint(qs, currentValue);
        return;
      }
      cancelQueuedSearchApply();
      await applySearchValue(nextValue, { announce: false });
    } catch (error) {
      notice(error.message, true);
    }
  });

  qs('#clearConsultationFilters').addEventListener('click', async () => {
    try {
      state.consultationQueueFilters = {
        status: 'all',
        tier: 'all',
        search: ''
      };
      syncPresetFromQueueState();
      persistQueueState(state);
      syncQueueInputControls(qs, state);
      persistQueueSearchHint(qs, '');
      await loadConsultations();
      notice('Consultation queue filters cleared.');
    } catch (error) {
      notice(error.message, true);
    }
  });
}
