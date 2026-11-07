import { CONSULTATION_QUEUE_PRESET_KEY, inferQueuePresetFromQueueState } from './consultation-workspace-bindings.js';

function consultationTierOptions(selectedTier = 'normal') {
  return [
    ['normal', 'Normal'],
    ['priority', 'Priority'],
    ['super_priority', 'Super Priority']
  ].map(([value, label]) => `<option value="${value}" ${selectedTier === value ? 'selected' : ''}>${label}</option>`).join('');
}

function consultationCommunicationLayers(consultation) {
  if (Array.isArray(consultation.communicationLayers) && consultation.communicationLayers.length) {
    return consultation.communicationLayers;
  }
  return ['voice_text', 'voice_call', 'video_call'];
}

function formatNgn(amount) {
  return new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN', maximumFractionDigits: 0 }).format(Number(amount || 0));
}

function stepState(status, target) {
  const order = ['REQUESTED', 'DOCTOR_ACCEPTED', 'IN_PROGRESS', 'COMPLETED'];
  const current = order.indexOf(status);
  const item = order.indexOf(target);
  if (status === 'CANCELLED') {
    return target === 'REQUESTED' ? 'done' : '';
  }
  if (item < current) return 'done';
  if (item === current) return 'current';
  return '';
}

function renderConsultationStepper(status) {
  return `
    <div class="consult-stepper">
      <div class="consult-step ${stepState(status, 'REQUESTED')}"><span class="bar"></span><span class="dot"></span><span class="lbl">Requested</span></div>
      <div class="consult-step ${stepState(status, 'DOCTOR_ACCEPTED')}"><span class="bar"></span><span class="dot"></span><span class="lbl">Accepted</span></div>
      <div class="consult-step ${stepState(status, 'IN_PROGRESS')}"><span class="bar"></span><span class="dot"></span><span class="lbl">Live</span></div>
      <div class="consult-step ${stepState(status, 'COMPLETED')}"><span class="dot"></span><span class="lbl">Done</span></div>
    </div>
  `;
}

function claimCountdownSummary(consultation) {
  if (consultation.status !== 'REQUESTED' || !consultation.claimWindowEndsAt) return null;
  const remainingMs = new Date(consultation.claimWindowEndsAt).getTime() - Date.now();
  if (!Number.isFinite(remainingMs)) return null;
  if (remainingMs <= 0) return { label: 'expired', expiresAt: consultation.claimWindowEndsAt };
  const minutes = Math.floor(remainingMs / 60000);
  const seconds = Math.floor((remainingMs % 60000) / 1000);
  return {
    label: `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`,
    expiresAt: consultation.claimWindowEndsAt
  };
}

export function createConsultationWorkspaceController(deps) {
  const {
    state,
    qs,
    qsa,
    e,
    api,
    badgeTone,
    renderInteractionDesk,
    renderInteractionTranscript,
    startInteractionPolling,
    stopInteractionPolling
  } = deps;

  state.consultationMedicalRecordsById ||= {};
  state.consultationMedicalRecordErrorById ||= {};
  state.consultationMedicalRecordLoadingById ||= {};
  state.consultationUiState ||= {};
  state.consultationUiState.recordsOpenById ||= {};

  function paymentChip(consultation) {
    const payment = consultation.consultationPayment;
    if (!payment) return '<span class="ledger-chip ledger-unknown">No payment record</span>';
    const byStatus = {
      pending: ['ledger-hold', `Payment due ${formatNgn(payment.amount)}`],
      initializing: ['ledger-hold', 'Checkout initializing'],
      captured: ['ledger-captured', `Paid ${formatNgn(payment.amount)}`],
      voided: ['ledger-released', 'No charge recorded'],
      refund_required: ['ledger-released', `Manual refund required ${formatNgn(payment.amount)}`],
      initialization_failed: ['ledger-unknown', 'Checkout could not be initialized']
    };
    const [klass, text] = byStatus[payment.status] || ['ledger-unknown', `${payment.status || 'unknown'} ${formatNgn(payment.amount)}`];
    return `<span class="ledger-chip ${klass}">${e(text)}</span>`;
  }

  function verificationChip(consultation) {
    const status = consultation.biometricSummary?.latestStatus;
    if (!status) return '<span class="verify-badge">Verification pending (async)</span>';
    if (status === 'matched') return '<span class="verify-badge pass">Verification passed</span>';
    if (status === 'failed') return '<span class="verify-badge fail">Verification failed</span>';
    return `<span class="verify-badge">Verification ${e(status)}</span>`;
  }

  function riskChip(consultation) {
    const summary = consultation.riskSummary;
    if (!summary || typeof summary.score !== 'number') return '';
    const level = String(summary.level || 'stable');
    const label = level === 'critical' ? 'Critical risk' : level === 'warning' ? 'Watch risk' : 'Stable risk';
    return `<span class="risk-chip risk-${e(level)}">${e(label)} · ${e(summary.score)}</span>`;
  }

  function callStateSummaryChips(consultation) {
    const summary = consultation.callStateSummary;
    if (!summary || !summary.totalCallSessions) return '';

    const chips = [`<span class="call-state-chip call-state-total">Call sessions: ${e(summary.totalCallSessions)}</span>`];
    if (summary.waitingRoomActive > 0) {
      chips.push(`<span class="call-state-chip call-state-waiting">Waiting room: ${e(summary.waitingRoomActive)}</span>`);
    }
    if (summary.providerReadyActive > 0) {
      chips.push(`<span class="call-state-chip call-state-ready">Provider ready: ${e(summary.providerReadyActive)}</span>`);
    }
    if (summary.inCallActive > 0) {
      chips.push(`<span class="call-state-chip call-state-live">In call: ${e(summary.inCallActive)}</span>`);
    }
    if (summary.latestCallState) {
      chips.push(`<span class="call-state-chip call-state-latest">Latest: ${e(String(summary.latestCallState).replace(/_/g, ' '))}</span>`);
    }
    return `<div class="call-state-chip-row">${chips.join('')}</div>`;
  }

  function renderRiskFlags(consultation) {
    const topFlags = consultation.riskSummary?.topFlags;
    if (Array.isArray(topFlags) && topFlags.length) {
      return `
      <div class="risk-flags">
        ${topFlags.map((item) => `<span class="risk-flag">${e(item.label)}</span>`).join('')}
      </div>
    `;
    }

    const flags = consultation.riskSummary?.flags;
    if (!Array.isArray(flags) || !flags.length) return '';
    return `
    <div class="risk-flags">
      ${flags.slice(0, 2).map((item) => `<span class="risk-flag">${e(String(item).replace(/_/g, ' '))}</span>`).join('')}
    </div>
  `;
  }

  function canViewPatientMedicalRecords(consultation) {
    if (!state.user || !consultation) return false;
    if (['admin', 'coordinator'].includes(state.user.role)) return true;
    if (state.user.role === 'patient' && consultation.patientId === state.user.patientId) return true;
    if (state.user.role === 'clinician' && consultation.assignedClinicianId === state.user.id) return true;
    return false;
  }

  function renderAssignedClinicianCard(consultation) {
    const clinician = consultation.assignedClinician;
    if (!clinician) {
      if (state.user?.role !== 'patient') return '';
      return '<div class="consult-clinician-card pending">Awaiting clinician claim. Assigned clinician details will appear here once accepted.</div>';
    }

    const clinicianName = String(clinician.fullName || [clinician.firstName, clinician.lastName].filter(Boolean).join(' ') || 'Assigned clinician');
    const facilityName = clinician.provider?.name || 'Independent clinician';
    const location = [clinician.provider?.city, clinician.provider?.state].filter(Boolean).join(', ');
    const specialties = Array.isArray(clinician.specialties) ? clinician.specialties.slice(0, 2) : [];
    const contact = [clinician.email, clinician.phone].filter(Boolean).join(' · ');

    return `
      <div class="consult-clinician-card">
        <strong>${e(clinicianName)}</strong>
        <span>${e(facilityName)}${location ? ` · ${e(location)}` : ''}</span>
        ${specialties.length ? `<span>Specialties: ${e(specialties.join(', '))}</span>` : ''}
        ${contact ? `<span>${e(contact)}</span>` : ''}
      </div>
    `;
  }

  function renderConsultationMedicalRecordsPanel(consultation) {
    const isOpen = Boolean(consultation._recordsOpen);
    const canView = canViewPatientMedicalRecords(consultation);
    if (!canView) return '';

    const payload = state.consultationMedicalRecordsById[consultation.id] || null;
    const records = Array.isArray(payload?.records) ? payload.records : [];
    const linkedDocuments = Array.isArray(payload?.linkedDocuments) ? payload.linkedDocuments : [];
    const isLoading = Boolean(state.consultationMedicalRecordLoadingById[consultation.id]);
    const error = state.consultationMedicalRecordErrorById[consultation.id] || '';

    let body = '<div class="subtle">Open patient records to review medical history and linked referral documents.</div>';
    if (isOpen && isLoading) {
      body = '<div class="subtle">Loading patient medical records...</div>';
    } else if (isOpen && error) {
      body = `<div class="medical-records-error">${e(error)}</div>`;
    } else if (isOpen) {
      const recordItems = records.length
        ? records
          .map((item) => `
            <li>
              <strong>${e(item.title || 'Clinical record')}</strong>
              <span>${e(String(item.recordType || 'general').replace(/_/g, ' '))} · ${e(item.sourceSystem || 'unknown')}</span>
              <span>${e(item.recordedAt ? new Date(item.recordedAt).toLocaleString() : 'Unknown timestamp')}</span>
              ${item.summary ? `<p>${e(item.summary)}</p>` : ''}
            </li>
          `)
          .join('')
        : '<li><span>No patient medical records are currently available.</span></li>';

      const documentItems = linkedDocuments.length
        ? linkedDocuments
          .slice(0, 6)
          .map((doc) => `<li>${e(doc.fileName || 'Unnamed document')} · ${e(doc.referralNumber || 'No referral id')} · ${e(doc.documentType || 'supporting')}</li>`)
          .join('')
        : '<li>No linked referral documents found.</li>';

      body = `
        <div class="medical-records-grid">
          <div>
            <h4>Clinical Records</h4>
            <ul class="medical-records-list">${recordItems}</ul>
          </div>
          <div>
            <h4>Linked Documents</h4>
            <ul class="medical-documents-list">${documentItems}</ul>
          </div>
        </div>
      `;
    }

    return `<section class="consult-medical-records ${isOpen ? 'is-open' : ''}" data-consult-records="${e(consultation.id)}">${body}</section>`;
  }

  function nextCommunicationLayer(consultation, currentLayer) {
    const layers = consultationCommunicationLayers(consultation);
    const normalizedCurrent = String(currentLayer || '').toLowerCase();
    const index = layers.indexOf(normalizedCurrent);
    if (index < 0) return layers[0];
    return layers[(index + 1) % layers.length];
  }

  function applyConsultationUiState(consultations) {
    for (const consultation of consultations) {
      consultation._actionsOpen = Boolean(state.consultationUiState.actionsOpenById[consultation.id]);
      consultation._logOpen = Boolean(state.consultationUiState.logOpenById[consultation.id]);
      consultation._recordsOpen = Boolean(state.consultationUiState.recordsOpenById[consultation.id]);
    }
  }

  async function loadConsultationEventLog(consultationId, options = {}) {
    if (!consultationId) return [];
    const forceRefresh = Boolean(options.forceRefresh);
    const kindFilter = String(state.consultationEventLogKindFilter || 'all');
    if (!forceRefresh && state.consultationEventLogById[consultationId]) {
      return state.consultationEventLogById[consultationId];
    }
    state.consultationEventLogLoadingById[consultationId] = true;
    state.consultationEventLogErrorById[consultationId] = null;
    try {
      const query = new URLSearchParams();
      query.set('limit', '120');
      if (kindFilter && kindFilter !== 'all') {
        query.set('kind', kindFilter);
      }
      const events = await api(`/api/v1/consultations/${consultationId}/events?${query.toString()}`);
      state.consultationEventLogById[consultationId] = events;
      return events;
    } catch (error) {
      state.consultationEventLogErrorById[consultationId] = String(error.message || 'Event log load failed.');
      return state.consultationEventLogById[consultationId] || [];
    } finally {
      state.consultationEventLogLoadingById[consultationId] = false;
    }
  }

  async function downloadConsultationEventsExport(consultation, format = 'csv') {
    const kindFilter = String(state.consultationEventLogKindFilter || 'all');
    const query = new URLSearchParams();
    query.set('format', format);
    query.set('limit', '500');
    if (kindFilter !== 'all') {
      query.set('kind', kindFilter);
    }

    const response = await fetch(`/api/v1/consultations/${consultation.id}/events/export?${query.toString()}`, {
      headers: state.token ? { authorization: `Bearer ${state.token}` } : {}
    });
    if (!response.ok) {
      let message = 'Consultation event export failed.';
      try {
        const payload = await response.json();
        if (payload?.error) message = payload.error;
      } catch {
        // keep fallback message when response is not JSON
      }
      throw new Error(message);
    }

    const blob = await response.blob();
    const disposition = response.headers.get('content-disposition') || '';
    const matched = disposition.match(/filename="?([^";]+)"?/i);
    const fallbackName = `${consultation.consultationNumber || consultation.id}-events.${format}`;
    const fileName = matched?.[1] || fallbackName;
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.click();
    URL.revokeObjectURL(url);
  }

  async function loadConsultationMedicalRecords(consultationId, options = {}) {
    if (!consultationId) return null;
    const forceRefresh = Boolean(options.forceRefresh);
    if (!forceRefresh && state.consultationMedicalRecordsById[consultationId]) {
      return state.consultationMedicalRecordsById[consultationId];
    }

    state.consultationMedicalRecordLoadingById[consultationId] = true;
    state.consultationMedicalRecordErrorById[consultationId] = null;
    try {
      const payload = await api(`/api/v1/consultations/${consultationId}/patient-medical-records?limit=50`);
      state.consultationMedicalRecordsById[consultationId] = payload;
      return payload;
    } catch (error) {
      state.consultationMedicalRecordErrorById[consultationId] = String(error.message || 'Medical records load failed.');
      return state.consultationMedicalRecordsById[consultationId] || null;
    } finally {
      state.consultationMedicalRecordLoadingById[consultationId] = false;
    }
  }

  function renderConsultation(consultation) {
    const procedure = state.catalogue?.procedures?.find((item) => item.id === consultation.procedureId);
    const specialty = state.catalogue?.specialties?.find((item) => item.id === consultation.specialtyId);
    const requestedLayer = String(consultation.requestedCommunicationMode || consultation.communicationMode || 'voice_text').replace(/_/g, ' ');
    const activeLayer = String(consultation.activeCommunicationLayer || consultation.communicationMode || '').replace(/_/g, ' ');
    const communicationLayers = consultationCommunicationLayers(consultation);
    const nextLayer = nextCommunicationLayer(consultation, consultation.activeCommunicationLayer || consultation.requestedCommunicationMode);
    const countdown = claimCountdownSummary(consultation);
    const isOpen = Boolean(consultation._actionsOpen);
    const isLogOpen = Boolean(consultation._logOpen);
    const isRecordsOpen = Boolean(consultation._recordsOpen);
    const logItems = state.consultationEventLogById[consultation.id] || [];
    const logError = state.consultationEventLogErrorById[consultation.id];
    const isLogLoading = Boolean(state.consultationEventLogLoadingById[consultation.id]);

    let logBody = '<li><span>No consultation events yet.</span></li>';
    if (isLogLoading && !logItems.length) {
      logBody = '<li><span>Loading event log...</span></li>';
    } else if (logItems.length) {
      logBody = logItems
        .slice(0, 8)
        .map((event) => `<li><span class="log-time">${e(new Date(event.at).toLocaleTimeString())}</span><span>${e(event.message)}</span></li>`)
        .join('');
    }
    if (logError) {
      logBody += `<li class="log-error">${e(logError)}</li>`;
    }

    return `
    <article class="item consult-card ${consultation.status === 'REQUESTED' ? 'is-open-claim' : ''}">
      <div class="item-row">
        <strong>${e(consultation.consultationNumber)}</strong>
        <span class="badge ${badgeTone(consultation.status)}">${e(consultation.status)}</span>
      </div>
      ${renderConsultationStepper(consultation.status)}
      <div>${e(consultation.requestedNeed || 'No consultation note provided.')}</div>
      <div class="subtle">${e(consultation.patient?.name || 'Unknown patient')} · ${e(specialty?.name || 'General care')} · ${e(procedure?.name || 'No specific procedure')} · ${e(consultation.tier)} · requested: ${e(requestedLayer)}${activeLayer ? ` · active: ${e(activeLayer)}` : ''}</div>
      ${renderAssignedClinicianCard(consultation)}
      <div class="consult-meta-row">
        <span class="tier-chip tier-${e(String(consultation.tier || 'normal').replace('_', '-'))}">${e(String(consultation.tier || 'normal').replace('_', ' '))}</span>
        ${consultation.status === 'IN_PROGRESS' ? (consultation.activeCommunicationLayer ? `<span class="active-layer-chip">Active: ${e(consultation.activeCommunicationLayer.replace(/_/g, ' '))}</span>` : '<span class="badge warn">Comms layer inactive</span>') : ''}
        ${paymentChip(consultation)}
        ${verificationChip(consultation)}
        ${riskChip(consultation)}
      </div>
      ${callStateSummaryChips(consultation)}
      ${renderRiskFlags(consultation)}
      ${countdown ? `<div class="countdown"><span>Broadcast window:</span> <b>${e(countdown.label)}</b> <span class="subtle">expires ${e(new Date(countdown.expiresAt).toLocaleTimeString())}</span></div>` : ''}
      <div class="actions">
        ${state.user?.role === 'clinician' && consultation.status === 'REQUESTED' ? `<button data-consult-action="claim" data-consult-id="${e(consultation.id)}">Claim</button>` : ''}
        ${state.user?.role === 'patient' && consultation.status === 'DOCTOR_ACCEPTED' && !['captured', 'initializing'].includes(consultation.consultationPayment?.status) ? `<button data-consult-action="pay" data-consult-id="${e(consultation.id)}">Pay securely with Paystack</button>` : ''}
        ${state.user?.role === 'patient' && consultation.status === 'DOCTOR_ACCEPTED' && ['pending', 'initializing'].includes(consultation.consultationPayment?.status) ? `<button class="secondary" data-consult-action="verify_payment" data-consult-id="${e(consultation.id)}">Check payment status</button>` : ''}
        ${['clinician', 'coordinator', 'admin'].includes(state.user?.role) && consultation.status === 'DOCTOR_ACCEPTED' && consultation.consultationPayment?.status === 'captured' ? `<button data-consult-action="start" data-consult-id="${e(consultation.id)}">Start</button>` : ''}
        ${consultation.status === 'IN_PROGRESS' && !consultation.activeCommunicationLayer ? `<button data-consult-action="ensure_layer" data-consult-id="${e(consultation.id)}">Activate comms</button>` : ''}
        ${['clinician', 'coordinator', 'admin'].includes(state.user?.role) && consultation.status === 'IN_PROGRESS' ? `<button data-consult-action="complete" data-consult-id="${e(consultation.id)}">Complete</button>` : ''}
        ${consultation.status === 'IN_PROGRESS' ? `<select data-session-channel="${e(consultation.id)}">${communicationLayers.map((channel) => `<option value="${e(channel)}" ${channel === consultation.activeCommunicationLayer || (!consultation.activeCommunicationLayer && channel === consultation.requestedCommunicationMode) ? 'selected' : ''}>${e(channel.replace(/_/g, ' '))}</option>`).join('')}</select>` : ''}
        ${consultation.status === 'IN_PROGRESS' ? `<button data-consult-action="open_session" data-consult-id="${e(consultation.id)}">Open selected layer</button>` : ''}
      </div>
      <div class="more-wrap">
        <button class="secondary" data-consult-toggle="actions" data-consult-id="${e(consultation.id)}">More actions</button>
        <button class="secondary" data-consult-toggle="events" data-consult-id="${e(consultation.id)}">Event log</button>
        ${canViewPatientMedicalRecords(consultation) ? `<button class="secondary" data-consult-toggle="records" data-consult-id="${e(consultation.id)}">${isRecordsOpen ? 'Hide records' : 'Patient records'}</button>` : ''}
        ${isLogOpen ? `<button class="secondary" data-consult-action="refresh_events" data-consult-id="${e(consultation.id)}">Refresh log</button>` : ''}
        ${isLogOpen ? `<button class="secondary" data-consult-action="export_events" data-consult-id="${e(consultation.id)}">Export log CSV</button>` : ''}
      </div>
      <div class="consult-more-actions ${isOpen ? 'is-open' : ''}">
        ${consultation.status === 'IN_PROGRESS' ? `<button class="secondary" data-consult-action="switch_layer" data-consult-id="${e(consultation.id)}">Switch to ${e(nextLayer.replace(/_/g, ' '))}</button>` : ''}
        ${consultation.status === 'IN_PROGRESS' ? `<button class="secondary" data-consult-action="close_session" data-consult-id="${e(consultation.id)}">Close Session</button>` : ''}
        <button class="secondary" data-consult-action="open_interactions" data-consult-id="${e(consultation.id)}">Open interaction desk</button>
        ${consultation.status === 'IN_PROGRESS' && consultation.tier !== 'super_priority' ? '<span class="subtle">Tier changes after payment require a separate billing workflow.</span>' : ''}
        ${['REQUESTED', 'DOCTOR_ACCEPTED', 'IN_PROGRESS'].includes(consultation.status) ? `<button class="secondary" data-consult-action="cancel" data-consult-id="${e(consultation.id)}">Cancel</button>` : ''}
        <button class="secondary" data-consult-action="hook" data-consult-id="${e(consultation.id)}">Biometric Hook</button>
      </div>
      ${renderConsultationMedicalRecordsPanel(consultation)}
      <ul class="consult-event-log ${isLogOpen ? 'is-open' : ''}" data-consult-events="${e(consultation.id)}">
        ${logBody}
      </ul>
    </article>
  `;
  }

  function consultationMatchesUrgentMode(consultation) {
    if (!state.urgentMode) return true;
    return ['priority', 'super_priority'].includes(String(consultation.tier || '').toLowerCase());
  }

  function renderUrgentModeToggleState() {
    qsa('[data-urgent-mode-toggle="true"]').forEach((button) => {
      button.classList.toggle('active', state.urgentMode);
      button.setAttribute('aria-pressed', state.urgentMode ? 'true' : 'false');
      button.textContent = state.urgentMode ? 'Urgent mode: on' : 'Urgent mode';
    });
  }

  function renderConsultationList() {
    const visibleConsultations = state.consultations.filter(consultationMatchesUrgentMode);
    qs('#consultationList').innerHTML = visibleConsultations.length
      ? visibleConsultations.map(renderConsultation).join('')
      : `<div class="empty">${state.urgentMode ? 'No priority or super-priority consultations in queue.' : 'No consultations in your queue.'}</div>`;

    const filterSummary = qs('#consultationFilterSummary');
    if (filterSummary) {
      const status = String(state.consultationQueueFilters?.status || 'all');
      const tier = String(state.consultationQueueFilters?.tier || 'all');
      const search = String(state.consultationQueueFilters?.search || '').trim();
      const active = [];
      if (status !== 'all') active.push(`status: ${status.replace(/_/g, ' ')}`);
      if (tier !== 'all') active.push(`tier: ${tier.replace(/_/g, ' ')}`);
      if (search) active.push(`search: \"${search}\"`);
      const visibleCount = Number(state.consultationQueueMeta?.visibleCount ?? visibleConsultations.length);
      const totalCount = Number(state.consultationQueueMeta?.totalCount ?? state.consultations.length);
      const countSuffix = Number.isFinite(visibleCount) && Number.isFinite(totalCount)
        ? ` · showing ${visibleCount} of ${totalCount}`
        : '';
      filterSummary.textContent = active.length
        ? `Filters active (${active.join(' | ')})${countSuffix}`
        : `Filters active: none${countSuffix}`;
    }
  }

  function renderConsultationOpsSnapshot(snapshot) {
    if (!snapshot) return;
    const manualRefundRate = Number(snapshot.manualRefundRatePercent ?? 0);
    const conflictCount = snapshot.alerts?.claims?.conflictsLast24h ?? snapshot.alerts?.claims?.conflicts ?? 0;
    const risk = snapshot.riskDistribution || { critical: 0, warning: 0, stable: 0 };
    const interactions = snapshot.interactionBreakdownLast24h || {
      patientMessages: 0,
      clinicianMessages: 0,
      sessionMarkers: 0,
      clinicalNotes: 0
    };
    const waitingPressureLevel = String(snapshot.waitingRoomPressureLevel || 'low');
    const waitingPressureClass = waitingPressureLevel === 'high'
      ? 'ops-pressure-high'
      : waitingPressureLevel === 'elevated'
        ? 'ops-pressure-elevated'
        : 'ops-pressure-low';
    qs('#consultationOps').innerHTML = `
      <div class="metric"><span>Requested</span><strong>${e(snapshot.requested)}</strong><div class="subtle">Awaiting doctor claim</div></div>
      <div class="metric"><span>Median Claim Time</span><strong>${e(snapshot.medianClaimTimeSeconds ?? snapshot.averageClaimTimeSeconds)}s</strong><div class="subtle">REQUESTED -> ACCEPTED</div></div>
      <div class="metric"><span>Manual Refund Rate</span><strong>${e(manualRefundRate)}%</strong><div class="subtle">${e(snapshot.refundRequired ?? 0)} refunds require follow-up</div></div>
      <div class="metric"><span>Claim Conflicts / 24h</span><strong>${e(conflictCount)}</strong><div class="subtle">Atomic conflict rejections</div></div>
      <div class="metric ${waitingPressureClass}"><span>Waiting Room Pressure</span><strong>${e(snapshot.waitingRoomPressureScore ?? 0)}</strong><div class="subtle">${e(waitingPressureLevel)} · oldest wait ${e(snapshot.oldestWaitingRoomSeconds ?? 0)}s</div></div>
      <div class="metric"><span>Call Readiness</span><strong>${e(snapshot.callReadinessPercent ?? 0)}%</strong><div class="subtle">ready+live across active calls</div></div>
      <div class="metric"><span>Critical Risk Share</span><strong>${e(snapshot.criticalRiskPercent ?? 0)}%</strong><div class="subtle">C:${e(risk.critical)} · W:${e(risk.warning)} · S:${e(risk.stable)}</div></div>
      <div class="metric"><span>Comms Throughput / 24h</span><strong>${e(snapshot.interactionsLast24h ?? 0)}</strong><div class="subtle">P:${e(interactions.patientMessages)} · C:${e(interactions.clinicianMessages)} · M:${e(interactions.sessionMarkers)} · N:${e(interactions.clinicalNotes)}</div></div>
      <div class="metric"><span>Active Sessions</span><strong>${e(snapshot.activeSessions ?? 0)}</strong><div class="subtle">${e(snapshot.interactionsPerActiveSessionLast24h ?? 0)} interactions/session (24h)</div></div>
      <div class="metric"><span>Active Call Sessions</span><strong>${e(snapshot.activeCallSessions ?? 0)}</strong><div class="subtle">W:${e(snapshot.activeCallStateCounts?.waiting_room ?? 0)} · R:${e(snapshot.activeCallStateCounts?.provider_ready ?? 0)} · L:${e(snapshot.activeCallStateCounts?.in_call ?? 0)}</div></div>
    `;
  }

  function renderConsultationWorkspaceFreshness(timestamp) {
    const node = qs('#consultationWorkspaceUpdatedAt');
    if (!node) return;
    if (!timestamp) {
      node.textContent = 'Last refresh: --';
      return;
    }
    node.textContent = `Last refresh: ${new Date(timestamp).toLocaleTimeString()}`;
  }

  async function setConsultationLogOpen(consultationId, isOpen) {
    state.consultationUiState.logOpenById[consultationId] = isOpen;
    if (isOpen) {
      await loadConsultationEventLog(consultationId);
    }
    renderConsultationList();
  }

  function setConsultationActionsOpen(consultationId, isOpen) {
    state.consultationUiState.actionsOpenById[consultationId] = isOpen;
    renderConsultationList();
  }

  async function setConsultationRecordsOpen(consultationId, isOpen) {
    state.consultationUiState.recordsOpenById[consultationId] = isOpen;
    if (isOpen) {
      await loadConsultationMedicalRecords(consultationId);
    }
    renderConsultationList();
  }

  async function finalizeConsultationWorkspaceRender() {
    applyConsultationUiState(state.consultations);
    const queueSortMode = qs('#consultationSortMode');
    if (queueSortMode) {
      queueSortMode.value = state.consultationQueueSortMode;
    }
    const kindFilter = qs('#eventLogKindFilter');
    if (kindFilter) {
      kindFilter.value = state.consultationEventLogKindFilter;
    }
    const statusValue = String(state.consultationQueueFilters?.status || 'all');
    const tierValue = String(state.consultationQueueFilters?.tier || 'all');
    const searchValue = String(state.consultationQueueFilters?.search || '').trim();
    const statusFilter = qs('#consultationStatusFilter');
    if (statusFilter) {
      statusFilter.value = statusValue;
    }
    const tierFilter = qs('#consultationTierFilter');
    if (tierFilter) {
      tierFilter.value = tierValue;
    }
    const searchFilter = qs('#consultationSearchFilter');
    if (searchFilter) {
      searchFilter.value = searchValue;
    }
    const searchHint = qs('#consultationSearchHint');
    if (searchHint) {
      searchHint.textContent = searchValue
        ? `Search queued: "${searchValue}"`
        : 'Type 3+ chars for live search, or press Enter.';
    }
    const presetFilter = qs('#consultationFilterPreset');
    if (presetFilter) {
      presetFilter.value = String(state.consultationQueuePreset || 'custom');
    }
    qsa('[data-consult-preset-chip]').forEach((button) => {
      const presetKey = String(button.dataset.consultPresetChip || '');
      const isActive = presetKey === String(state.consultationQueuePreset || 'custom');
      button.classList.toggle('active', isActive);
      button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    });
    const openLogIds = state.consultations
      .filter((item) => item._logOpen)
      .map((item) => item.id);
    if (openLogIds.length) {
      await Promise.all(openLogIds.map((id) => loadConsultationEventLog(id)));
    }
    const openMedicalRecordIds = state.consultations
      .filter((item) => item._recordsOpen)
      .map((item) => item.id);
    if (openMedicalRecordIds.length) {
      await Promise.all(openMedicalRecordIds.map((id) => loadConsultationMedicalRecords(id)));
    }
    renderConsultationList();
    renderUrgentModeToggleState();
    await renderInteractionDesk();
    startInteractionPolling();
  }

  async function hydrateConsultationWorkspace(workspace) {
    if (!workspace || !Array.isArray(workspace.consultations)) {
      throw new Error('Consultation workspace payload is missing consultations.');
    }

    const applied = workspace.appliedFilters || null;
    if (applied) {
      state.consultationQueueSortMode = String(applied.sort || state.consultationQueueSortMode || 'recent');
      state.consultationQueueFilters = {
        status: String(applied.status || 'all'),
        tier: String(applied.tier || 'all'),
        search: String(applied.search || '')
      };
      localStorage.setItem('mindset_consultation_sort_mode', state.consultationQueueSortMode);
      localStorage.setItem('mindset_consultation_filter_status', state.consultationQueueFilters.status);
      localStorage.setItem('mindset_consultation_filter_tier', state.consultationQueueFilters.tier);
      localStorage.setItem('mindset_consultation_filter_search', state.consultationQueueFilters.search);
    }
    state.consultationQueuePreset = inferQueuePresetFromQueueState(state);
    localStorage.setItem(CONSULTATION_QUEUE_PRESET_KEY, String(state.consultationQueuePreset || 'custom'));
    state.consultations = workspace.consultations;
    state.consultationQueueMeta = {
      visibleCount: Number(workspace.meta?.visibleCount ?? workspace.consultations.length),
      totalCount: Number(workspace.meta?.totalCount ?? workspace.consultations.length)
    };
    renderConsultationOpsSnapshot(workspace.snapshot || null);
    renderConsultationWorkspaceFreshness(workspace.generatedAt || null);
    await finalizeConsultationWorkspaceRender();
  }

  async function loadConsultations() {
    try {
      const consultationQuery = new URLSearchParams();
      consultationQuery.set('sort', state.consultationQueueSortMode || 'recent');
      const status = String(state.consultationQueueFilters?.status || 'all');
      const tier = String(state.consultationQueueFilters?.tier || 'all');
      const search = String(state.consultationQueueFilters?.search || '').trim();
      if (status !== 'all') consultationQuery.set('status', status);
      if (tier !== 'all') consultationQuery.set('tier', tier);
      if (search) consultationQuery.set('search', search);
      const workspace = await api(`/api/v1/consultations/workspace?${consultationQuery.toString()}`).catch(() => null);
      if (workspace?.consultations && workspace?.snapshot) {
        await hydrateConsultationWorkspace(workspace);
      } else {
        state.consultations = await api(`/api/v1/consultations?${consultationQuery.toString()}`);
        state.consultationQueueMeta = {
          visibleCount: state.consultations.length,
          totalCount: state.consultations.length
        };
        const snapshot = await api('/api/v1/operations/consultation-sla').catch(() => null);
        renderConsultationOpsSnapshot(snapshot);
        renderConsultationWorkspaceFreshness(new Date().toISOString());
        state.consultationQueuePreset = inferQueuePresetFromQueueState(state);
        localStorage.setItem(CONSULTATION_QUEUE_PRESET_KEY, String(state.consultationQueuePreset || 'custom'));
        await finalizeConsultationWorkspaceRender();
      }
    } catch (error) {
      qs('#consultationList').innerHTML = `<div class="empty">${e(error.message)}</div>`;
      renderInteractionTranscript([]);
      stopInteractionPolling();
    }
  }

  return {
    nextCommunicationLayer,
    loadConsultations,
    hydrateConsultationWorkspace,
    loadConsultationEventLog,
    downloadConsultationEventsExport,
    loadConsultationMedicalRecords,
    setConsultationLogOpen,
    setConsultationActionsOpen,
    setConsultationRecordsOpen,
    renderConsultationList,
    renderUrgentModeToggleState
  };
}
