export function bindInteractionHandlers(deps) {
  const {
    qs,
    qsa,
    state,
    notice,
    renderInteractionDesk,
    updateInteractionSubmitState,
    renderInteractionTypeControl,
    currentInteractionSession,
    postQuickSessionMarker,
    downloadInteractionTranscriptExport,
    applyInteractionPreset,
    interactionPresetCatalog,
    INTERACTION_PRESET_KEY,
    inferInteractionTypeClient,
    validateInteractionPayloadClient,
    api
  } = deps;

  qs('#refreshInteractionDesk').addEventListener('click', async () => {
    try {
      await renderInteractionDesk(null, { forceRefresh: true });
      const consultationId = state.consultationInteractionContext.consultationId;
      const sessionId = state.consultationInteractionContext.sessionId;
      if (consultationId && sessionId) {
        const key = `${consultationId}:${sessionId}`;
        const latest = state.latestInteractionAtBySession[key] || null;
        if (latest) {
          state.lastSeenInteractionAtBySession[key] = latest;
        }
        state.interactionUnreadBySession[key] = false;
      }
      notice('Communication desk refreshed.');
    } catch (error) {
      notice(error.message, true);
    }
  });

  qs('#interactionConsultationId').addEventListener('change', async (event) => {
    try {
      state.consultationInteractionContext.consultationId = event.target.value || null;
      state.consultationInteractionContext.sessionId = null;
      updateInteractionSubmitState();
      await renderInteractionDesk();
    } catch (error) {
      notice(error.message, true);
    }
  });

  qs('#interactionSessionId').addEventListener('change', async (event) => {
    try {
      state.consultationInteractionContext.sessionId = event.target.value || null;
      const consultationId = state.consultationInteractionContext.consultationId;
      const sessionId = state.consultationInteractionContext.sessionId;
      if (consultationId && sessionId) {
        const key = `${consultationId}:${sessionId}`;
        state.interactionUnreadBySession[key] = false;
      }
      renderInteractionTypeControl();
      updateInteractionSubmitState();
      await renderInteractionDesk();
    } catch (error) {
      notice(error.message, true);
    }
  });

  qsa('[data-quick-marker]').forEach((button) => {
    button.addEventListener('click', async () => {
      try {
        const marker = button.dataset.quickMarker;
        if (!marker) throw new Error('Invalid quick marker action.');
        await postQuickSessionMarker(marker);
        const consultationId = state.consultationInteractionContext.consultationId;
        const sessionId = state.consultationInteractionContext.sessionId;
        if (consultationId && sessionId) {
          const key = `${consultationId}:${sessionId}`;
          state.interactionUnreadBySession[key] = false;
        }
        await renderInteractionDesk(null, { forceRefresh: true });
        notice(`Session marker recorded: ${marker}.`);
      } catch (error) {
        notice(error.message, true);
      }
    });
  });

  qs('#exportInteractionTranscript').addEventListener('click', async () => {
    try {
      const consultationId = state.consultationInteractionContext.consultationId;
      const sessionId = state.consultationInteractionContext.sessionId;
      if (!consultationId || !sessionId) throw new Error('Select a consultation session before exporting transcript.');
      const format = String(qs('#interactionExportFormat')?.value || 'csv').toLowerCase();
      await downloadInteractionTranscriptExport(consultationId, sessionId, format);
      notice(`Transcript exported as ${format.toUpperCase()}.`);
    } catch (error) {
      notice(error.message, true);
    }
  });

  qs('#interactionPreset').addEventListener('change', async (event) => {
    try {
      const presetKey = event.target.value || '';
      if (!presetKey) {
        notice('Communication preset cleared.');
        return;
      }
      const role = state.user?.role || 'coordinator';
      localStorage.setItem(`${INTERACTION_PRESET_KEY}:${role}`, presetKey);
      applyInteractionPreset(presetKey);
      await renderInteractionDesk();
      notice(`Communication preset applied: ${interactionPresetCatalog[presetKey].label}.`);
    } catch (error) {
      notice(error.message, true);
    }
  });

  qs('#interactionType').addEventListener('change', () => {
    renderInteractionTypeControl();
    updateInteractionSubmitState();
  });

  qs('#interactionMarker').addEventListener('change', () => {
    const session = currentInteractionSession();
    if (!session) return;
    const draftKey = `${state.consultationInteractionContext.consultationId || ''}:${session.id}`;
    const currentDraft = state.consultationInteractionDraftBySession[draftKey] || {};
    state.consultationInteractionDraftBySession[draftKey] = {
      ...currentDraft,
      marker: qs('#interactionMarker').value
    };
    updateInteractionSubmitState();
  });

  qs('#interactionMessage').addEventListener('input', () => {
    const session = currentInteractionSession();
    if (!session) return;
    const draftKey = `${state.consultationInteractionContext.consultationId || ''}:${session.id}`;
    const currentDraft = state.consultationInteractionDraftBySession[draftKey] || {};
    state.consultationInteractionDraftBySession[draftKey] = {
      ...currentDraft,
      message: qs('#interactionMessage').value,
      type: qs('#interactionType').value
    };
    updateInteractionSubmitState();
  });

  qs('#interactionFilterType').addEventListener('change', async (event) => {
    try {
      state.consultationInteractionFilters.type = event.target.value || 'all';
      localStorage.setItem('mindset_interaction_filter_type', state.consultationInteractionFilters.type);
      await renderInteractionDesk();
      notice('Transcript type filter updated.');
    } catch (error) {
      notice(error.message, true);
    }
  });

  qs('#interactionFilterActorRole').addEventListener('change', async (event) => {
    try {
      state.consultationInteractionFilters.actorRole = event.target.value || 'all';
      localStorage.setItem('mindset_interaction_filter_actor', state.consultationInteractionFilters.actorRole);
      await renderInteractionDesk();
      notice('Transcript actor filter updated.');
    } catch (error) {
      notice(error.message, true);
    }
  });

  qs('#interactionFilterLimit').addEventListener('change', async (event) => {
    try {
      state.consultationInteractionFilters.limit = event.target.value || '50';
      localStorage.setItem('mindset_interaction_filter_limit', state.consultationInteractionFilters.limit);
      await renderInteractionDesk();
      notice('Transcript row limit updated.');
    } catch (error) {
      notice(error.message, true);
    }
  });

  qs('#consultationInteractionForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const consultationId = state.consultationInteractionContext.consultationId;
      const sessionId = state.consultationInteractionContext.sessionId;
      if (!consultationId || !sessionId) throw new Error('Select a consultation with at least one session.');

      const session = currentInteractionSession();
      const requestedType = qs('#interactionType').value;
      const markerValue = qs('#interactionMarker').value;
      const messageValue = qs('#interactionMessage').value;
      const type = inferInteractionTypeClient(session, state.user, messageValue, markerValue, requestedType);
      const payloadError = validateInteractionPayloadClient(type, messageValue, markerValue);
      if (payloadError) throw new Error(payloadError);
      const payload = { interactionType: type };
      if (type === 'session_marker') {
        payload.marker = markerValue;
      } else {
        payload.message = messageValue;
      }

      await api(`/api/v1/consultations/${consultationId}/sessions/${sessionId}/interactions`, {
        method: 'POST',
        body: JSON.stringify(payload)
      });

      const draftKey = `${consultationId}:${sessionId}`;
      const existingDraft = state.consultationInteractionDraftBySession[draftKey] || {};
      state.consultationInteractionDraftBySession[draftKey] = {
        ...existingDraft,
        message: '',
        type: type,
        marker: payload.marker || existingDraft.marker || 'connected'
      };
      qs('#interactionMessage').value = '';
      updateInteractionSubmitState();
      notice('Interaction recorded.');
      await renderInteractionDesk(null, { forceRefresh: true });
    } catch (error) {
      notice(error.message, true);
    }
  });

  qs('#interactionMessage').addEventListener('keydown', (event) => {
    const isQuickSubmit = (event.ctrlKey || event.metaKey) && event.key === 'Enter';
    if (!isQuickSubmit) return;
    event.preventDefault();
    qs('#consultationInteractionForm').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
  });

  qs('#clearInteractionDraft').addEventListener('click', () => {
    const consultationId = state.consultationInteractionContext.consultationId;
    const sessionId = state.consultationInteractionContext.sessionId;
    if (!consultationId || !sessionId) {
      notice('Select a consultation session before clearing draft.', true);
      return;
    }
    const draftKey = `${consultationId}:${sessionId}`;
    state.consultationInteractionDraftBySession[draftKey] = {};
    qs('#interactionMessage').value = '';
    updateInteractionSubmitState();
    notice('Interaction draft cleared.');
  });
}
