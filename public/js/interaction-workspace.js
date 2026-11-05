function consultationInteractionCacheKey(consultationId, sessionId, query = '') {
  return `${consultationId || ''}:${sessionId || ''}?${query || ''}`;
}

function interactionTypeBadgeClass(interactionType) {
  const type = String(interactionType || '').replace(/[^a-z_]/g, '');
  return `badge interaction-type-${type}`;
}

export function createInteractionWorkspaceController(deps) {
  const {
    state,
    qs,
    e,
    timestampMs,
    api,
    syncCallDesk,
    interactionPresetKey,
    interactionPresetCatalog,
    interactionPresetsForRole,
    interactionTypesForChannel,
    inferInteractionTypeClient,
    validateInteractionPayloadClient,
    isMessageRequiredInteractionType,
    interactionPollMs = 5000,
    interactionCacheTtlMs = 12000
  } = deps;

  function renderInteractionPresetOptions() {
    const select = qs('#interactionPreset');
    if (!select) return;
    const role = state.user?.role || 'coordinator';
    const options = interactionPresetsForRole(role)
      .map((key) => `<option value="${e(key)}">${e(interactionPresetCatalog[key]?.label || key)}</option>`)
      .join('');
    select.innerHTML = `<option value="">Custom</option>${options}`;
    const savedPreset = localStorage.getItem(`${interactionPresetKey}:${role}`) || '';
    if (savedPreset && interactionPresetCatalog[savedPreset]) {
      select.value = savedPreset;
    }
  }

  function applyInteractionPreset(presetKey) {
    if (!presetKey || !interactionPresetCatalog[presetKey]) return;
    const preset = interactionPresetCatalog[presetKey];
    state.consultationInteractionFilters = {
      ...state.consultationInteractionFilters,
      ...preset.filters
    };
    localStorage.setItem('mindset_interaction_filter_type', state.consultationInteractionFilters.type);
    localStorage.setItem('mindset_interaction_filter_actor', state.consultationInteractionFilters.actorRole);
    localStorage.setItem('mindset_interaction_filter_limit', state.consultationInteractionFilters.limit);

    const typeSelect = qs('#interactionType');
    const markerSelect = qs('#interactionMarker');
    if (typeSelect) {
      typeSelect.value = preset.draftType;
    }
    if (markerSelect && preset.marker) {
      markerSelect.value = preset.marker;
    }
    renderInteractionTypeControl();
  }

  async function downloadInteractionTranscriptExport(consultationId, sessionId, format = 'csv') {
    const query = new URLSearchParams();
    query.set('format', format);
    const type = String(state.consultationInteractionFilters.type || 'all');
    const actorRole = String(state.consultationInteractionFilters.actorRole || 'all');
    const limit = String(state.consultationInteractionFilters.limit || '50');
    if (type !== 'all') query.set('type', type);
    if (actorRole !== 'all') query.set('actorRole', actorRole);
    if (limit) query.set('limit', limit);

    const response = await fetch(
      `/api/v1/consultations/${consultationId}/sessions/${sessionId}/interactions/export?${query.toString()}`,
      { headers: state.token ? { authorization: `Bearer ${state.token}` } : {} }
    );
    if (!response.ok) {
      let message = 'Transcript export failed.';
      try {
        const payload = await response.json();
        if (payload?.error) message = payload.error;
      } catch {
        // Keep default fallback.
      }
      throw new Error(message);
    }

    const blob = await response.blob();
    const disposition = response.headers.get('content-disposition') || '';
    const matched = disposition.match(/filename="?([^";]+)"?/i);
    const fallbackName = `${consultationId}-${sessionId}-interactions.${format}`;
    const fileName = matched?.[1] || fallbackName;

    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.click();
    URL.revokeObjectURL(url);
  }

  function currentInteractionSession() {
    const consultationId = state.consultationInteractionContext.consultationId;
    const sessionId = state.consultationInteractionContext.sessionId;
    const sessions = state.consultationSessionsById[consultationId] || [];
    return sessions.find((item) => item.id === sessionId) || null;
  }

  function renderInteractionTypeControl() {
    const session = currentInteractionSession();
    const typeSelect = qs('#interactionType');
    const markerWrap = qs('#interactionMarkerWrap');
    const messageWrap = qs('#interactionMessageWrap');
    if (!typeSelect || !markerWrap || !messageWrap) return;

    const allowed = interactionTypesForChannel(session?.channel);
    const current = typeSelect.value;
    typeSelect.innerHTML = allowed
      .map((value) => `<option value="${e(value)}">${e(value.replace(/_/g, ' '))}</option>`)
      .join('');
    typeSelect.value = allowed.includes(current) ? current : allowed[0];

    const isMarker = typeSelect.value === 'session_marker';
    markerWrap.classList.toggle('hidden', !isMarker);
    messageWrap.classList.toggle('hidden', isMarker);

    const draftKey = `${state.consultationInteractionContext.consultationId || ''}:${session?.id || ''}`;
    const currentDraft = state.consultationInteractionDraftBySession[draftKey] || {};
    if (!currentDraft.type || currentDraft.type !== typeSelect.value) {
      state.consultationInteractionDraftBySession[draftKey] = {
        ...currentDraft,
        type: typeSelect.value
      };
    }

    updateInteractionSubmitState();
  }

  function updateInteractionSubmitState() {
    const submitButton = qs('#consultationInteractionForm button[type="submit"], #consultationInteractionForm button:not([type])');
    const hint = qs('#interactionFormHint');
    const session = currentInteractionSession();
    const requestedType = qs('#interactionType')?.value || 'clinical_note';
    const markerValue = qs('#interactionMarker')?.value || '';
    const messageValue = qs('#interactionMessage')?.value || '';
    const resolvedType = inferInteractionTypeClient(session, state.user, messageValue, markerValue, requestedType);
    const error = validateInteractionPayloadClient(resolvedType, messageValue, markerValue);
    const needsMessage = isMessageRequiredInteractionType(resolvedType);

    if (submitButton) {
      submitButton.disabled = Boolean(error);
      submitButton.title = error || '';
    }

    if (hint) {
      if (error) {
        hint.textContent = error;
        hint.classList.add('error');
      } else if (needsMessage) {
        hint.textContent = 'Message required for this interaction type.';
        hint.classList.remove('error');
      } else {
        hint.textContent = 'Ready to submit.';
        hint.classList.remove('error');
      }
    }
  }

  function applyInteractionFilterControls() {
    const type = qs('#interactionFilterType');
    const actorRole = qs('#interactionFilterActorRole');
    const limit = qs('#interactionFilterLimit');
    if (type) type.value = state.consultationInteractionFilters.type;
    if (actorRole) actorRole.value = state.consultationInteractionFilters.actorRole;
    if (limit) limit.value = state.consultationInteractionFilters.limit;
  }

  function interactionQueryString() {
    const params = new URLSearchParams();
    const type = String(state.consultationInteractionFilters.type || 'all');
    const actorRole = String(state.consultationInteractionFilters.actorRole || 'all');
    const limit = String(state.consultationInteractionFilters.limit || '50');
    if (type && type !== 'all') params.set('type', type);
    if (actorRole && actorRole !== 'all') params.set('actorRole', actorRole);
    if (limit) params.set('limit', limit);
    return params.toString();
  }

  function isConsultationsViewActive() {
    const active = qs('.view.active');
    return active?.id === 'consultations';
  }

  function stopInteractionPolling() {
    if (!state.interactionPollTimer) return;
    clearInterval(state.interactionPollTimer);
    state.interactionPollTimer = null;
  }

  function startInteractionPolling() {
    stopInteractionPolling();
    if (!state.token) return;
    if (!isConsultationsViewActive()) return;
    state.interactionPollTimer = setInterval(() => {
      if (!isConsultationsViewActive()) {
        stopInteractionPolling();
        return;
      }
      renderInteractionDesk(null, { forceRefresh: true }).catch(() => null);
    }, interactionPollMs);
  }

  function renderInteractionTranscript(items = []) {
    const list = qs('#consultationInteractionList');
    if (!list) return;
    if (!items.length) {
      list.innerHTML = '<div class="empty">No interactions recorded for this session yet.</div>';
      return;
    }

    list.innerHTML = items.map((item) => {
      const meta = [item.channel?.replace(/_/g, ' '), item.interactionType?.replace(/_/g, ' '), item.createdByRole]
        .filter(Boolean)
        .join(' · ');
      const marker = item.marker ? `<div><strong>marker:</strong> ${e(item.marker)}</div>` : '';
      const message = item.message ? `<div>${e(item.message)}</div>` : '';
      return `
        <article class="item">
          <div class="item-row">
            <strong>${e(new Date(item.createdAt).toLocaleString())}</strong>
            <span class="${interactionTypeBadgeClass(item.interactionType)}">${e(item.interactionType)}</span>
          </div>
          <div class="subtle">${e(meta)}</div>
          ${marker}
          ${message}
        </article>
      `;
    }).join('');
  }

  async function postQuickSessionMarker(marker) {
    const consultationId = state.consultationInteractionContext.consultationId;
    const sessionId = state.consultationInteractionContext.sessionId;
    if (!consultationId || !sessionId) {
      throw new Error('Select an active consultation session first.');
    }
    await api(`/api/v1/consultations/${consultationId}/sessions/${sessionId}/interactions`, {
      method: 'POST',
      body: JSON.stringify({ interactionType: 'session_marker', marker })
    });
  }

  async function fetchConsultationSessions(consultationId, options = {}) {
    if (!consultationId) return [];
    const forceRefresh = Boolean(options.forceRefresh);
    const preferCache = !forceRefresh && options.preferCache !== false;
    const nowMs = Date.now();
    const hasCached = Object.prototype.hasOwnProperty.call(state.consultationSessionsById, consultationId);
    const cachedAt = Number(state.consultationSessionsFetchedAtById[consultationId] || 0);
    const isCacheFresh = cachedAt > 0 && (nowMs - cachedAt) <= interactionCacheTtlMs;
    if (preferCache && hasCached && isCacheFresh) {
      return state.consultationSessionsById[consultationId] || [];
    }
    const sessions = await api(`/api/v1/consultations/${consultationId}/sessions`).catch(() => []);
    state.consultationSessionsById[consultationId] = sessions;
    state.consultationSessionsFetchedAtById[consultationId] = nowMs;
    return sessions;
  }

  function renderInteractionSessionPicker(consultationId) {
    const select = qs('#interactionSessionId');
    if (!select) return;
    const sessions = state.consultationSessionsById[consultationId] || [];
    if (!sessions.length) {
      select.innerHTML = '';
      state.consultationInteractionContext.sessionId = null;
      return;
    }

    select.innerHTML = sessions
      .map((session) => {
        const callState = ['voice_call', 'video_call'].includes(session.channel)
          ? ` · ${String(session.callState || 'idle').replace(/_/g, ' ')}`
          : '';
        return `<option value="${e(session.id)}">${e(session.channel.replace(/_/g, ' '))} · ${e(session.status)}${e(callState)}</option>`;
      })
      .join('');

    const preferred = sessions.find((item) => item.status === 'active') || sessions[sessions.length - 1];
    const keepCurrent = sessions.find((item) => item.id === state.consultationInteractionContext.sessionId);
    const selected = keepCurrent || preferred;
    state.consultationInteractionContext.sessionId = selected.id;
    select.value = selected.id;
  }

  async function renderInteractionDesk(forceConsultationId = null, options = {}) {
    const consultPicker = qs('#interactionConsultationId');
    if (!consultPicker) return;
    const forceRefresh = Boolean(options.forceRefresh);
    const preferCache = !forceRefresh && (options.preferCache !== false || state.consultationCommsUsePreloadedOnce);

    const consultationOptions = state.consultations
      .map((item) => `<option value="${e(item.id)}">${e(item.consultationNumber)} · ${e(item.status)} · ${e(item.tier)}</option>`)
      .join('');
    consultPicker.innerHTML = consultationOptions;

    if (!state.consultations.length) {
      state.consultationInteractionContext = { consultationId: null, sessionId: null };
      renderInteractionTranscript([]);
      const sessionPicker = qs('#interactionSessionId');
      if (sessionPicker) sessionPicker.innerHTML = '';
      await syncCallDesk?.();
      return;
    }

    const requestedId = forceConsultationId || state.consultationInteractionContext.consultationId;
    const selectedConsultation = state.consultations.find((item) => item.id === requestedId) || state.consultations[0];
    state.consultationInteractionContext.consultationId = selectedConsultation.id;
    consultPicker.value = selectedConsultation.id;
    renderInteractionPresetOptions();
    applyInteractionFilterControls();

    await fetchConsultationSessions(selectedConsultation.id, { preferCache, forceRefresh });
    renderInteractionSessionPicker(selectedConsultation.id);
    renderInteractionTypeControl();

    const sessionId = state.consultationInteractionContext.sessionId;
    if (!sessionId) {
      renderInteractionTranscript([]);
      const message = qs('#interactionMessage');
      if (message) message.value = '';
      await syncCallDesk?.();
      return;
    }

    const draftKey = `${selectedConsultation.id}:${sessionId}`;
    const draft = state.consultationInteractionDraftBySession[draftKey] || {};
    const typeSelect = qs('#interactionType');
    const markerSelect = qs('#interactionMarker');
    const messageInput = qs('#interactionMessage');
    if (typeSelect && draft.type && [...typeSelect.options].some((option) => option.value === draft.type)) {
      typeSelect.value = draft.type;
      renderInteractionTypeControl();
    }
    if (markerSelect && draft.marker && [...markerSelect.options].some((option) => option.value === draft.marker)) {
      markerSelect.value = draft.marker;
    }
    if (messageInput) {
      messageInput.value = draft.message || '';
    }

    const query = interactionQueryString();
    const interactionCacheKey = consultationInteractionCacheKey(selectedConsultation.id, sessionId, query);
    const hasCachedInteractions = Object.prototype.hasOwnProperty.call(
      state.consultationInteractionCacheByQueryKey,
      interactionCacheKey
    );
    const cachedInteractionAt = Number(state.consultationInteractionCacheFetchedAtByQueryKey[interactionCacheKey] || 0);
    const isInteractionCacheFresh = cachedInteractionAt > 0 && (Date.now() - cachedInteractionAt) <= interactionCacheTtlMs;
    const interactions = preferCache && hasCachedInteractions && isInteractionCacheFresh
      ? state.consultationInteractionCacheByQueryKey[interactionCacheKey]
      : await api(
        `/api/v1/consultations/${selectedConsultation.id}/sessions/${sessionId}/interactions${query ? `?${query}` : ''}`
      ).catch(() => []);
    state.consultationInteractionCacheByQueryKey[interactionCacheKey] = interactions;
    state.consultationInteractionCacheFetchedAtByQueryKey[interactionCacheKey] = Date.now();
    state.consultationCommsUsePreloadedOnce = false;

    const latest = interactions[interactions.length - 1]?.createdAt || null;
    const key = `${selectedConsultation.id}:${sessionId}`;
    const priorSeen = state.lastSeenInteractionAtBySession[key] || null;
    state.latestInteractionAtBySession[key] = latest;
    if (latest && priorSeen && timestampMs(latest) > timestampMs(priorSeen)) {
      state.interactionUnreadBySession[key] = true;
    }
    if (latest && !priorSeen) {
      state.lastSeenInteractionAtBySession[key] = latest;
      state.interactionUnreadBySession[key] = false;
    }

    const unreadPill = qs('#interactionUnreadPill');
    if (unreadPill) {
      unreadPill.classList.toggle('hidden', !state.interactionUnreadBySession[key]);
    }

    renderInteractionTranscript(interactions);
    await syncCallDesk?.();
  }

  function hydratePreloadedConsultationComms(preloaded) {
    if (!preloaded || !preloaded.consultationId) return;

    const consultationId = String(preloaded.consultationId);
    const hydratedAt = Date.now();
    const sessions = Array.isArray(preloaded.sessions) ? preloaded.sessions : [];
    state.consultationSessionsById[consultationId] = sessions;
    state.consultationSessionsFetchedAtById[consultationId] = hydratedAt;

    const sessionId = preloaded.sessionId ? String(preloaded.sessionId) : '';
    const interactionQuery = String(preloaded.interactionQuery || '');
    const interactions = Array.isArray(preloaded.interactions) ? preloaded.interactions : [];

    if (sessionId) {
      const cacheKey = consultationInteractionCacheKey(consultationId, sessionId, interactionQuery);
      state.consultationInteractionCacheByQueryKey[cacheKey] = interactions;
      state.consultationInteractionCacheFetchedAtByQueryKey[cacheKey] = hydratedAt;
      const latest = interactions[interactions.length - 1]?.createdAt || null;
      const sessionKey = `${consultationId}:${sessionId}`;
      if (latest) {
        state.latestInteractionAtBySession[sessionKey] = latest;
        if (!state.lastSeenInteractionAtBySession[sessionKey]) {
          state.lastSeenInteractionAtBySession[sessionKey] = latest;
          state.interactionUnreadBySession[sessionKey] = false;
        }
      }
    }

    state.consultationCommsUsePreloadedOnce = true;
  }

  return {
    applyInteractionPreset,
    downloadInteractionTranscriptExport,
    currentInteractionSession,
    renderInteractionTypeControl,
    updateInteractionSubmitState,
    postQuickSessionMarker,
    renderInteractionDesk,
    stopInteractionPolling,
    startInteractionPolling,
    renderInteractionTranscript,
    hydratePreloadedConsultationComms
  };
}
