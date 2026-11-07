function promptRequiredReason(title, defaultValue) {
  const input = window.prompt(title, defaultValue);
  if (input === null) return null;
  const reason = String(input || '').trim();
  if (!reason) {
    throw new Error('A reason is required for this action.');
  }
  return reason;
}

export function createConsultationActionRunner(deps) {
  const {
    api,
    state,
    qs,
    nextCommunicationLayer,
    setConsultationPanel,
    renderInteractionDesk,
    downloadConsultationEventsExport
  } = deps;

  return async function runConsultationAction(action, consultationId) {
    if (action === 'claim') return api(`/api/v1/consultations/${consultationId}/claim`, { method: 'POST' });
    if (action === 'start') return api(`/api/v1/consultations/${consultationId}/start`, { method: 'POST' });
    if (action === 'complete') return api(`/api/v1/consultations/${consultationId}/complete`, { method: 'POST' });
    if (action === 'pay') {
      const checkout = await api(`/api/v1/consultations/${consultationId}/payment/initialize`, { method: 'POST' });
      if (!checkout.authorizationUrl) throw new Error('Paystack did not provide a checkout link.');
      window.location.assign(checkout.authorizationUrl);
      return { redirectingToCheckout: true };
    }
    if (action === 'verify_payment') {
      return api(`/api/v1/consultations/${consultationId}/payment/verify`, { method: 'POST' });
    }
    if (action === 'cancel') {
      const reason = promptRequiredReason('Reason for cancellation', 'Cancelled from dashboard');
      if (reason === null) return { cancelledByUser: true };
      return api(`/api/v1/consultations/${consultationId}/cancel`, { method: 'POST', body: JSON.stringify({ reason }) });
    }
    if (action === 'hook') {
      return api(`/api/v1/consultations/${consultationId}/biometric-hooks`, {
        method: 'POST',
        body: JSON.stringify({ method: 'face', status: 'captured', actorType: 'doctor' })
      });
    }
    if (action === 'escalate') {
      const tierPicker = qs(`[data-escalate-tier="${consultationId}"]`);
      const toTier = tierPicker?.value;
      if (!toTier) throw new Error('This consultation cannot be escalated further.');
      return api(`/api/v1/consultations/${consultationId}/escalate`, {
        method: 'POST',
        body: JSON.stringify({ toTier, reason: 'Escalated via dashboard controls' })
      });
    }
    if (action === 'open_session') {
      const consultation = state.consultations.find((item) => item.id === consultationId);
      if (!consultation) throw new Error('Consultation not found in current view.');
      const picker = qs(`[data-session-channel="${consultationId}"]`);
      const channel = String(picker?.value || consultation.requestedCommunicationMode || consultation.communicationMode || 'voice_text')
        .toLowerCase()
        .replace(/[\s-]+/g, '_');
      const res = await api(`/api/v1/consultations/${consultationId}/sessions/switch`, {
        method: 'POST',
        body: JSON.stringify({
          targetChannel: channel,
          reason: 'open_selected_layer_from_dashboard'
        })
      });
      return res.session || res;
    }
    if (action === 'switch_layer') {
      const consultation = state.consultations.find((item) => item.id === consultationId);
      if (!consultation) throw new Error('Consultation not found in current view.');
      const currentLayer = consultation.activeCommunicationLayer || consultation.requestedCommunicationMode;
      const targetLayer = nextCommunicationLayer(consultation, currentLayer);
      const res = await api(`/api/v1/consultations/${consultationId}/sessions/switch`, {
        method: 'POST',
        body: JSON.stringify({
          targetChannel: targetLayer,
          reason: 'switch_layer_from_dashboard'
        })
      });
      return res.session || res;
    }
    if (action === 'ensure_layer') {
      const res = await api(`/api/v1/consultations/${consultationId}/sessions/ensure-active`, {
        method: 'POST',
        body: JSON.stringify({ metadata: { source: 'dashboard_quick_activate' } })
      });
      return res.session || res;
    }
    if (action === 'close_session') {
      const sessions = await api(`/api/v1/consultations/${consultationId}/sessions`);
      const active = sessions.find((item) => item.status === 'active');
      if (!active) throw new Error('No active consultation communication session to close.');
      const reason = promptRequiredReason('Reason for closing active session', 'Session completed from dashboard');
      if (reason === null) return { cancelledByUser: true };
      return api(`/api/v1/consultations/${consultationId}/sessions/${active.id}/close`, {
        method: 'POST',
        body: JSON.stringify({ reason })
      });
    }
    if (action === 'open_interactions') {
      setConsultationPanel('comms');
      await renderInteractionDesk(consultationId);
      const desk = qs('#consultationInteractionForm');
      if (desk) desk.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return { ok: true };
    }
    if (action === 'refresh_events') {
      return { ok: true, refreshedEvents: true };
    }
    if (action === 'export_events') {
      const consultation = state.consultations.find((item) => item.id === consultationId);
      if (!consultation) throw new Error('Consultation not found for export.');
      await downloadConsultationEventsExport(consultation, 'csv');
      return { ok: true, exportedEvents: true };
    }
    return null;
  };
}
