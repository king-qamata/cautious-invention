import {
  assertProcedureForSpecialty,
  assertConsultationTier,
  assertConsultationTransition,
  assertRole,
  assertTierEscalation,
  canViewConsultation,
  consultationTiers,
  makeId,
  nextConsultationNumber,
  normalizeString,
  now
} from '../domain.js';

const CLAIM_WINDOW_MS = 2 * 60 * 1000;
const DEFAULT_IN_PROGRESS_SLA_MINUTES = 120;
const DEFAULT_CLAIM_CONFLICT_THRESHOLD = 5;
const DEFAULT_TERMINAL_RECONCILIATION_GRACE_MINUTES = 30;

const ALERT_REMEDIATION_HINTS = {
  consultations_stuck_requested:
    'Run POST /api/v1/operations/jobs/release-unclaimed-consultations and verify claim sweep timer is enabled.',
  consultations_stuck_in_progress:
    'Review active sessions and clinician handoff activity, then manually complete/cancel stuck consultations after clinical validation.',
  high_claim_conflict_rate:
    'Review clinician eligibility filters and queue fan-out; increase claim-window staffing or tune broadcast scope.',
  completed_without_captured_hold:
    'Reconcile affected consultation holds immediately and verify completion transition always captures payment holds.',
  cancelled_with_held_hold:
    'Release held payments for cancelled consultations and inspect cancellation flow for release failures.',
  requested_without_held_hold:
    'Investigate consultation creation path to ensure REQUESTED state always creates a consultation_hold payment record.',
  terminal_hold_unreconciled:
    'Run billing reconciliation for terminal holds and update payment reconciliationStatus to reconciled when confirmed.'
};

function ensureCollections(db) {
  db.consultations ||= [];
  db.consultationClaims ||= [];
  db.biometricVerifications ||= [];
  db.consultationSessions ||= [];
  db.consultationInteractions ||= [];
  db.payments ||= [];
  db.notificationLogs ||= [];
  db.auditLogs ||= [];
  db.referrals ||= [];
  db.documents ||= [];
  db.medicalRecords ||= [];
}

const COMMUNICATION_LAYERS = ['voice_text', 'voice_call', 'video_call'];
const CONSULTATION_INTERACTION_TYPES = ['patient_message', 'clinician_message', 'session_marker', 'clinical_note'];
const SESSION_MARKERS = [
  'ringing',
  'connected',
  'in_call',
  'ended',
  'failed',
  'reconnecting',
  'switched',
  'waiting_room',
  'provider_ready',
  'participant_joined',
  'participant_left',
  'offer_sent',
  'answer_sent',
  'authorization_blocked',
  'rate_limited',
  'permission_required',
  'permission_recovered',
  'minimized',
  'pinned',
  'unpinned'
];
const CALL_SESSION_STATES = ['idle', 'waiting_room', 'provider_ready', 'in_call', 'ended', 'failed'];
const CALL_SESSION_STATE_TRANSITIONS = {
  idle: ['waiting_room', 'provider_ready', 'in_call', 'ended', 'failed'],
  waiting_room: ['provider_ready', 'in_call', 'ended', 'failed'],
  provider_ready: ['waiting_room', 'in_call', 'ended', 'failed'],
  in_call: ['waiting_room', 'ended', 'failed'],
  ended: ['waiting_room', 'provider_ready'],
  failed: ['waiting_room', 'provider_ready', 'ended']
};
const CALL_STATE_TO_MARKER = {
  waiting_room: 'waiting_room',
  provider_ready: 'provider_ready',
  in_call: 'in_call',
  ended: 'ended',
  failed: 'failed'
};
const CALL_STATE_FROM_MARKER = {
  waiting_room: 'waiting_room',
  provider_ready: 'provider_ready',
  connected: 'in_call',
  in_call: 'in_call',
  reconnecting: 'waiting_room',
  ended: 'ended',
  failed: 'failed'
};
const CONSULTATION_EVENT_KINDS = ['state_transition', 'claim', 'session', 'interaction', 'payment', 'biometric_hook'];
const CONSULTATION_SORT_MODES = ['recent', 'urgency', 'claim_expiry', 'waiting_time', 'risk_score'];
const CONSULTATION_STATUS_FILTERS = ['REQUESTED', 'DOCTOR_ACCEPTED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'];
const CONSULTATION_TIER_FILTERS = ['normal', 'priority', 'super_priority'];
const RISK_FLAG_LABELS = {
  claim_window_expired: 'Claim window expired',
  claim_window_low: 'Claim window close to expiry',
  in_progress_over_sla: 'In-progress duration exceeded SLA',
  requested_missing_held_payment: 'Requested consultation missing held payment',
  completed_missing_capture: 'Completed consultation missing hold capture',
  cancelled_hold_not_released: 'Cancelled consultation still has held payment',
  verification_failed: 'Latest biometric verification failed',
  verification_pending: 'Verification pending for super-priority consultation',
  missing_active_communication_layer: 'In-progress consultation missing active communication layer',
  claim_conflicts_detected: 'Claim conflicts detected on this consultation'
};

function consultationTierWeight(tier) {
  if (tier === 'super_priority') return 3;
  if (tier === 'priority') return 2;
  return 1;
}

function toTimestamp(value) {
  const ts = new Date(value || 0).getTime();
  return Number.isFinite(ts) ? ts : 0;
}

function normalizedConsultationSortMode(value) {
  const mode = normalizeString(value || 'recent', 40).toLowerCase();
  return CONSULTATION_SORT_MODES.includes(mode) ? mode : 'recent';
}

function normalizedConsultationStatusFilter(value) {
  const raw = normalizeString(value || '', 50).toLowerCase().replace(/[\s-]+/g, '_');
  if (!raw || raw === 'all') return null;
  const aliases = {
    accepted: 'doctor_accepted',
    doctoraccepted: 'doctor_accepted',
    inprogress: 'in_progress'
  };
  const normalized = aliases[raw] || raw;
  const upper = normalized.toUpperCase();
  return CONSULTATION_STATUS_FILTERS.includes(upper) ? upper : null;
}

function normalizedConsultationTierFilter(value) {
  const raw = normalizeString(value || '', 50).toLowerCase().replace(/[\s-]+/g, '_');
  if (!raw || raw === 'all') return null;
  return CONSULTATION_TIER_FILTERS.includes(raw) ? raw : null;
}

function normalizedConsultationSearchFilter(value) {
  const raw = normalizeString(value || '', 120).toLowerCase();
  return raw || null;
}

function consultationMatchesSearch(db, consultation, search) {
  if (!search) return true;
  const patient = (db.patients || []).find((item) => item.id === consultation.patientId) || null;
  const haystack = [
    consultation.consultationNumber,
    consultation.requestedNeed,
    consultation.status,
    consultation.tier,
    consultation.requestedCommunicationMode,
    patient?.name,
    patient?.phone
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return haystack.includes(search);
}

function compareConsultationsByMode(mode) {
  if (mode === 'urgency') {
    return (a, b) => {
      const tierDiff = consultationTierWeight(b.tier) - consultationTierWeight(a.tier);
      if (tierDiff !== 0) return tierDiff;
      return toTimestamp(b.createdAt) - toTimestamp(a.createdAt);
    };
  }

  if (mode === 'claim_expiry') {
    return (a, b) => {
      const aPending = a.status === 'REQUESTED';
      const bPending = b.status === 'REQUESTED';
      if (aPending !== bPending) return aPending ? -1 : 1;
      if (aPending && bPending) {
        const expiryDiff = toTimestamp(a.claimWindowEndsAt) - toTimestamp(b.claimWindowEndsAt);
        if (expiryDiff !== 0) return expiryDiff;
      }
      const tierDiff = consultationTierWeight(b.tier) - consultationTierWeight(a.tier);
      if (tierDiff !== 0) return tierDiff;
      return toTimestamp(b.createdAt) - toTimestamp(a.createdAt);
    };
  }

  if (mode === 'waiting_time') {
    return (a, b) => toTimestamp(a.createdAt) - toTimestamp(b.createdAt);
  }

  return (a, b) => toTimestamp(b.createdAt) - toTimestamp(a.createdAt);
}

function consultationRiskSummary(db, consultation) {
  let score = 0;
  const flags = [];
  const nowMs = Date.now();
  const hold = activeHoldPayment(db, consultation.id);
  const latestHook = db.biometricVerifications
    .filter((item) => item.consultationId === consultation.id)
    .sort((a, b) => toTimestamp(b.createdAt) - toTimestamp(a.createdAt))[0] || null;

  const tierBase = consultation.tier === 'super_priority' ? 55 : consultation.tier === 'priority' ? 35 : 15;
  score += tierBase;

  if (consultation.status === 'REQUESTED') {
    const expiresAtMs = toTimestamp(consultation.claimWindowEndsAt);
    if (expiresAtMs <= nowMs) {
      score += 45;
      flags.push('claim_window_expired');
    } else {
      const remainingMs = Math.max(0, expiresAtMs - nowMs);
      const urgencyFactor = Math.max(0, Math.min(1, 1 - remainingMs / CLAIM_WINDOW_MS));
      score += Math.round(urgencyFactor * 35);
      if (urgencyFactor >= 0.6) flags.push('claim_window_low');
    }
  }

  if (consultation.status === 'IN_PROGRESS' && consultation.startedAt) {
    const startedMs = toTimestamp(consultation.startedAt);
    const elapsedMinutes = Math.max(0, (nowMs - startedMs) / 60000);
    const slaFactor = Math.max(0, Math.min(1.2, elapsedMinutes / DEFAULT_IN_PROGRESS_SLA_MINUTES));
    score += Math.round(slaFactor * 28);
    if (elapsedMinutes > DEFAULT_IN_PROGRESS_SLA_MINUTES) flags.push('in_progress_over_sla');
  }

  if (consultation.status === 'REQUESTED' && (!hold || hold.status !== 'held')) {
    score += 38;
    flags.push('requested_missing_held_payment');
  }
  if (consultation.status === 'COMPLETED' && (!hold || hold.status !== 'captured')) {
    score += 42;
    flags.push('completed_missing_capture');
  }
  if (consultation.status === 'CANCELLED' && hold?.status === 'held') {
    score += 34;
    flags.push('cancelled_hold_not_released');
  }

  if (latestHook?.status === 'failed') {
    score += 20;
    flags.push('verification_failed');
  }
  if (!latestHook && consultation.tier === 'super_priority') {
    score += 10;
    flags.push('verification_pending');
  }

  if (consultation.status === 'IN_PROGRESS' && !consultation.activeCommunicationLayer) {
    score += 8;
    flags.push('missing_active_communication_layer');
  }

  const conflictAttempts = db.consultationClaims.filter(
    (item) => item.consultationId === consultation.id && item.outcome === 'conflict'
  ).length;
  if (conflictAttempts > 0) {
    score += Math.min(15, conflictAttempts * 5);
    flags.push('claim_conflicts_detected');
  }

  const uniqueFlags = [...new Set(flags)];
  const boundedScore = Math.max(0, Math.min(100, score));
  const level = boundedScore >= 75 ? 'critical' : boundedScore >= 45 ? 'warning' : 'stable';
  return {
    score: boundedScore,
    level,
    flags: uniqueFlags,
    topFlags: uniqueFlags.slice(0, 3).map((code) => ({
      code,
      label: RISK_FLAG_LABELS[code] || code
    }))
  };
}

function quantileFromSorted(sortedValues, quantile) {
  if (!sortedValues.length) return 0;
  if (sortedValues.length === 1) return sortedValues[0];
  const index = (sortedValues.length - 1) * quantile;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sortedValues[lower];
  const weight = index - lower;
  return sortedValues[lower] * (1 - weight) + sortedValues[upper] * weight;
}

function normalizeCommunicationChannel(value) {
  const normalized = normalizeString(value, 50).toLowerCase().replace(/[\s-]+/g, '_');
  return COMMUNICATION_LAYERS.includes(normalized) ? normalized : null;
}

function normalizeCallSessionState(value) {
  const normalized = normalizeString(value, 40).toLowerCase().replace(/[\s-]+/g, '_');
  return CALL_SESSION_STATES.includes(normalized) ? normalized : null;
}

function callStateFromMarker(marker) {
  const normalized = normalizeString(marker, 40).toLowerCase();
  return CALL_STATE_FROM_MARKER[normalized] || null;
}

function ensureSessionCallState(session) {
  if (!session || !['voice_call', 'video_call'].includes(session.channel)) return;
  const timestamp = session.updatedAt || session.startedAt || session.createdAt || now();
  const normalizedState = normalizeCallSessionState(session.callState) || 'idle';
  session.callState = normalizedState;
  session.callStateUpdatedAt = session.callStateUpdatedAt || timestamp;
  session.callStateReason = normalizeString(session.callStateReason, 300) || null;
  if (!Array.isArray(session.callStateHistory)) {
    session.callStateHistory = [];
  }
}

function appendCallStateHistory(session, fromState, toState, changedByUserId, reason = '', metadata = {}) {
  session.callStateHistory.push({
    id: makeId('consultation_call_state'),
    fromState,
    toState,
    changedByUserId,
    reason: normalizeString(reason, 300) || null,
    metadata: metadata && typeof metadata === 'object' ? metadata : {},
    createdAt: now()
  });
}

function applyCallSessionStateTransition(session, toState, changedByUserId, options = {}) {
  ensureSessionCallState(session);
  const fromState = session.callState;
  if (fromState === toState) {
    return { changed: false, fromState, toState };
  }

  const allowed = CALL_SESSION_STATE_TRANSITIONS[fromState] || [];
  if (!allowed.includes(toState)) {
    const error = new Error(`Cannot transition call state from ${fromState} to ${toState}.`);
    error.status = 422;
    throw error;
  }

  const timestamp = now();
  session.callState = toState;
  session.callStateUpdatedAt = timestamp;
  session.callStateReason = normalizeString(options.reason, 300) || null;
  session.updatedAt = timestamp;
  appendCallStateHistory(
    session,
    fromState,
    toState,
    changedByUserId,
    options.reason,
    options.metadata
  );
  return { changed: true, fromState, toState };
}

function consultationPatientUserId(db, consultation) {
  const patient = db.patients.find((item) => item.id === consultation.patientId) || null;
  return patient?.userId || null;
}

function callSessionParticipantUserIds(db, consultation) {
  const participants = [];
  const patientUserId = consultationPatientUserId(db, consultation);
  if (patientUserId) participants.push(patientUserId);
  if (consultation.assignedClinicianId) participants.push(consultation.assignedClinicianId);
  return [...new Set(participants)];
}

function canManageConsultationCallState(db, user, consultation) {
  if (!user || !consultation) return false;
  if (['admin', 'coordinator'].includes(user.role)) return true;
  const participants = callSessionParticipantUserIds(db, consultation);
  return participants.includes(user.id);
}

function pushSessionMarkerInteraction(db, consultation, session, payload = {}) {
  const marker = normalizeString(payload.marker, 40).toLowerCase();
  if (!SESSION_MARKERS.includes(marker)) {
    const error = new Error(`marker must be one of: ${SESSION_MARKERS.join(', ')}.`);
    error.status = 422;
    throw error;
  }

  const interaction = {
    id: makeId('consultation_interaction'),
    consultationId: consultation.id,
    sessionId: session.id,
    channel: session.channel,
    interactionType: 'session_marker',
    marker,
    message: null,
    metadata: payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : {},
    createdByUserId: normalizeString(payload.userId, 120) || 'system',
    createdByRole: normalizeString(payload.role, 30).toLowerCase() || 'system',
    createdAt: now(),
    updatedAt: now()
  };

  db.consultationInteractions.push(interaction);
  return interaction;
}

function communicationChannelForTier(tier) {
  if (tier === 'normal') return 'voice_text';
  if (tier === 'priority') return 'voice_call';
  if (tier === 'super_priority') return 'video_call';
  return 'voice_text';
}

function buildCommunicationPlan(requestedChannel) {
  const preferred = normalizeCommunicationChannel(requestedChannel) || 'voice_text';
  return [preferred, ...COMMUNICATION_LAYERS.filter((channel) => channel !== preferred)];
}

function consultationSessionById(db, sessionId) {
  return db.consultationSessions.find((item) => item.id === sessionId) || null;
}

function consultationInteractionBySession(db, sessionId) {
  return db.consultationInteractions
    .filter((item) => item.sessionId === sessionId)
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
}

function normalizeInteractionType(value) {
  const rawType = normalizeString(value, 80).toLowerCase().replace(/[\s-]+/g, '_');
  const aliases = {
    patient: 'patient_message',
    patient_text: 'patient_message',
    clinician: 'clinician_message',
    clinician_text: 'clinician_message',
    clinical: 'clinical_note',
    note: 'clinical_note',
    marker: 'session_marker',
    session: 'session_marker',
    session_event: 'session_marker'
  };
  const type = aliases[rawType] || rawType;
  if (!CONSULTATION_INTERACTION_TYPES.includes(type)) {
    const error = new Error(
      `interactionType must be one of: ${CONSULTATION_INTERACTION_TYPES.join(', ')}. Received: ${rawType || 'empty'}.`
    );
    error.status = 422;
    throw error;
  }
  return type;
}

function allowedInteractionTypesForChannel(channel) {
  if (channel === 'voice_text') return ['patient_message', 'clinician_message', 'clinical_note'];
  if (channel === 'voice_call') return ['session_marker', 'clinical_note'];
  if (channel === 'video_call') return ['session_marker', 'clinical_note'];
  return ['clinical_note'];
}

function resolveConsultationCarePath(db, payload) {
  const procedureId = payload.procedureId || null;
  const specialtyId = payload.specialtyId || null;
  if (!procedureId && !specialtyId) return { specialtyId: null, procedureId: null };

  if (procedureId && specialtyId) {
    assertProcedureForSpecialty(db, specialtyId, procedureId);
    return { specialtyId, procedureId };
  }

  if (procedureId) {
    const procedure = db.procedures.find((item) => item.id === procedureId);
    if (!procedure) {
      const error = new Error('Consultation procedure was not found.');
      error.status = 422;
      throw error;
    }
    return { specialtyId: procedure.specialtyId, procedureId };
  }

  const specialty = db.specialties.find((item) => item.id === specialtyId);
  if (!specialty) {
    const error = new Error('Consultation specialty was not found.');
    error.status = 422;
    throw error;
  }
  return { specialtyId, procedureId: null };
}

function includesWhenProvided(values, expected) {
  if (expected === null || expected === undefined) return true;
  return Array.isArray(values) && values.length > 0 ? values.includes(expected) : true;
}

function providerCanHandleConsultation(db, clinician, consultation) {
  if (!clinician.providerId) return true;
  const capabilities = db.providerProcedures.filter((item) => item.providerId === clinician.providerId);
  if (!capabilities.length) return false;

  if (consultation.procedureId) {
    const capability = capabilities.find((item) => item.procedureId === consultation.procedureId);
    return Boolean(capability && capability.availability !== 'unavailable');
  }

  if (consultation.specialtyId) {
    return capabilities.some((capability) => {
      if (capability.availability === 'unavailable') return false;
      const procedure = db.procedures.find((item) => item.id === capability.procedureId);
      return procedure?.specialtyId === consultation.specialtyId;
    });
  }

  return true;
}

export function isClinicianEligibleForConsultation(db, clinician, consultation) {
  if (!clinician || clinician.role !== 'clinician') return false;
  if (!consultation) return false;
  if (consultation.assignedClinicianId === clinician.id) return true;
  if (consultation.status !== 'REQUESTED') return false;

  const rules = clinician.consultationAvailability || {};
  if (rules.enabled === false) return false;
  if (!includesWhenProvided(rules.acceptedTiers, consultation.tier)) return false;
  if (!includesWhenProvided(rules.specialtyIds, consultation.specialtyId)) return false;
  if (!includesWhenProvided(rules.procedureIds, consultation.procedureId)) return false;

  return providerCanHandleConsultation(db, clinician, consultation);
}

export function countClinicianEligibleBroadcasts(db, clinician) {
  ensureCollections(db);
  return db.consultations.filter((consultation) => isClinicianEligibleForConsultation(db, clinician, consultation)).length;
}

function audit(db, actorId, action, entityType, entityId, details = {}) {
  db.auditLogs.push({
    id: makeId('audit'),
    actorId,
    action,
    entityType,
    entityId,
    details,
    createdAt: now()
  });
}

function notify(db, consultation, channel, recipient, subject, body, userId = null, metadata = {}) {
  const eventKey = normalizeString(metadata.eventKey, 80) || null;
  const notificationType = normalizeString(metadata.notificationType, 40).toLowerCase() || 'consultation';
  const severity = normalizeString(metadata.severity, 20).toLowerCase() || 'info';

  db.notificationLogs.push({
    id: makeId('notification'),
    referralId: null,
    consultationId: consultation?.id || null,
    userId,
    channel,
    recipient,
    subject,
    body,
    eventKey,
    notificationType,
    severity,
    status: 'sent',
    provider: 'mvp-log',
    providerReference: makeId('delivery'),
    failureReason: null,
    sentAt: now(),
    createdAt: now(),
    updatedAt: now()
  });
}

function consultationRecipient(patient) {
  return patient?.phone || patient?.email || 'unknown';
}

const SUPPORTED_NOTIFICATION_CHANNELS = ['sms', 'email', 'in_app'];

function normalizeChannelList(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const list = [];
  for (const item of value) {
    const channel = normalizeString(item, 30).toLowerCase();
    if (!SUPPORTED_NOTIFICATION_CHANNELS.includes(channel) || seen.has(channel)) continue;
    seen.add(channel);
    list.push(channel);
  }
  return list;
}

function roleChannelPolicy(target, eventKey, consultation) {
  const urgency = consultation?.tier;
  if (target.audience === 'patient') return ['sms', 'email', 'in_app'];

  const staffUrgentEvents = new Set([
    'consultation_request_created',
    'consultation_tier_updated',
    'consultation_cancelled',
    'consultation_claim_window_expired'
  ]);
  if (urgency !== 'normal' && staffUrgentEvents.has(eventKey)) {
    return ['sms', 'in_app', 'email'];
  }

  if (target.audience === 'clinician') return ['in_app', 'sms', 'email'];
  return ['in_app', 'email', 'sms'];
}

function notificationContextForEvent(eventKey, consultation) {
  const key = String(eventKey || '').toLowerCase();
  const tier = String(consultation?.tier || 'normal').toLowerCase();

  let notificationType = 'consultation';
  if (key.includes('call_') || key.includes('communication_')) {
    notificationType = 'communication';
  }

  let severity = 'info';
  if (key === 'consultation_claim_window_expired') {
    severity = 'critical';
  } else if (key === 'consultation_tier_updated') {
    severity = tier === 'super_priority' ? 'critical' : 'warning';
  } else if (key === 'consultation_cancelled') {
    severity = 'warning';
  } else if (key === 'consultation_call_waiting_room') {
    severity = tier === 'super_priority' ? 'warning' : 'info';
  }

  return {
    eventKey: key || null,
    notificationType,
    severity
  };
}

function preferredChannelsForTarget(target) {
  const fromUser = target.user?.notificationPreferences;
  const fromPatient = target.patient?.notificationPreferences;
  const userConsultation = normalizeChannelList(fromUser?.consultations?.preferredChannels);
  if (userConsultation.length) return userConsultation;
  const userDefault = normalizeChannelList(fromUser?.preferredChannels);
  if (userDefault.length) return userDefault;
  const patientConsultation = normalizeChannelList(fromPatient?.consultations?.preferredChannels);
  if (patientConsultation.length) return patientConsultation;
  return normalizeChannelList(fromPatient?.preferredChannels);
}

function emailCopyEnabledForTarget(target) {
  const userFlag = target.user?.notificationPreferences?.consultations?.emailCopyEnabled;
  if (typeof userFlag === 'boolean') return userFlag;
  const patientFlag = target.patient?.notificationPreferences?.consultations?.emailCopyEnabled;
  if (typeof patientFlag === 'boolean') return patientFlag;
  return true;
}

function availableChannelRecipient(target, channel) {
  if (channel === 'sms' && target.phone) return target.phone;
  if (channel === 'email' && target.email) return target.email;
  if (channel === 'in_app' && target.userId) return `user:${target.userId}`;
  return null;
}

function pickNotificationRoute(target, eventKey, consultation) {
  const preferred = preferredChannelsForTarget(target);
  const policy = roleChannelPolicy(target, eventKey, consultation);
  const channels = [...preferred, ...policy.filter((channel) => !preferred.includes(channel))];
  for (const channel of channels) {
    const recipient = availableChannelRecipient(target, channel);
    if (recipient) return { channel, recipient };
  }

  const fallbackRecipient = target.phone || target.email || (target.userId ? `user:${target.userId}` : 'unknown');
  return { channel: 'sms', recipient: fallbackRecipient };
}

function notificationTargetsForAudience(db, consultation, audience) {
  const patient = db.patients.find((item) => item.id === consultation.patientId) || null;
  const patientUser = patient?.userId ? db.users.find((item) => item.id === patient.userId) || null : null;

  if (audience === 'patient') {
    return [
      {
        audience,
        userId: patientUser?.id || null,
        user: patientUser,
        patient,
        phone: patient?.phone || patientUser?.phone || '',
        email: patient?.email || patientUser?.email || ''
      }
    ];
  }

  if (audience === 'clinician') {
    const clinician = consultation.assignedClinicianId
      ? db.users.find((item) => item.id === consultation.assignedClinicianId && item.role === 'clinician') || null
      : null;
    if (!clinician) return [];
    return [
      {
        audience,
        userId: clinician.id,
        user: clinician,
        patient: null,
        phone: clinician.phone || '',
        email: clinician.email || ''
      }
    ];
  }

  if (audience === 'eligible_clinicians') {
    return db.users
      .filter((item) => item.role === 'clinician')
      .filter((item) => isClinicianEligibleForConsultation(db, item, consultation))
      .map((clinician) => ({
        audience,
        userId: clinician.id,
        user: clinician,
        patient: null,
        phone: clinician.phone || '',
        email: clinician.email || ''
      }));
  }

  if (audience === 'coordinator') {
    return db.users
      .filter((item) => item.role === 'coordinator')
      .map((coordinator) => ({
        audience,
        userId: coordinator.id,
        user: coordinator,
        patient: null,
        phone: coordinator.phone || '',
        email: coordinator.email || ''
      }));
  }

  return [];
}

function sendConsultationEventNotifications(db, consultation, config) {
  const notificationContext = notificationContextForEvent(config.eventKey, consultation);
  const targets = [];
  for (const audience of config.audiences) {
    targets.push(...notificationTargetsForAudience(db, consultation, audience));
  }

  const seen = new Set();
  const sentDeliveries = new Set();
  const forcedChannels = normalizeChannelList(config.forceChannels);
  for (const target of targets) {
    if (!target) continue;
    if (config.excludeActorId && target.userId && target.userId === config.excludeActorId) continue;

    const dedupeKey = `${target.audience}:${target.userId || target.email || target.phone || 'unknown'}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const subject = config.subject[target.audience] || config.subject.default;
    const body = config.body[target.audience] || config.body.default;
    if (!subject || !body) continue;

    if (forcedChannels.length) {
      let delivered = 0;
      for (const channel of forcedChannels) {
        const recipient = availableChannelRecipient(target, channel);
        if (!recipient) continue;
        const deliveryKey = `${dedupeKey}:${channel}:${recipient}`;
        if (sentDeliveries.has(deliveryKey)) continue;
        sentDeliveries.add(deliveryKey);
        notify(db, consultation, channel, recipient, subject, body, target.userId || null, notificationContext);
        delivered += 1;
      }

      if (delivered > 0) {
        continue;
      }
    }

    const route = pickNotificationRoute(target, config.eventKey, consultation);
    notify(db, consultation, route.channel, route.recipient, subject, body, target.userId || null, notificationContext);

    // Always send an email copy for app users when an email address exists and primary channel is different.
    if (target.userId && target.email && route.channel !== 'email' && emailCopyEnabledForTarget(target)) {
      notify(db, consultation, 'email', target.email, subject, body, target.userId, notificationContext);
    }
  }
}

function communicationLabel(channel) {
  if (channel === 'voice_text') return 'voice text';
  if (channel === 'voice_call') return 'voice call';
  if (channel === 'video_call') return 'video call';
  return channel;
}

function patientForConsultation(db, user, payload) {
  const patientId = user.role === 'patient' ? user.patientId : payload.patientId;
  const patient = db.patients.find((item) => item.id === patientId);
  if (!patient) {
    const error = new Error('Patient not found for consultation request.');
    error.status = 404;
    throw error;
  }
  return patient;
}

function consultationByNumberOrId(db, key) {
  return db.consultations.find((item) => item.id === key || item.consultationNumber === key) || null;
}

function activeHoldPayment(db, consultationId) {
  return db.payments.find((item) => item.consultationId === consultationId && item.paymentType === 'consultation_hold');
}

function addConsultationStatusHistory(consultation, fromStatus, toStatus, changedByUserId, note = '') {
  consultation.statusHistory ||= [];
  consultation.statusHistory.push({
    id: makeId('consultation_history'),
    fromStatus,
    toStatus,
    changedByUserId,
    note,
    createdAt: now()
  });
}

function transitionConsultation(consultation, fromStatus, toStatus, changedByUserId, note) {
  assertConsultationTransition(fromStatus, toStatus);
  consultation.status = toStatus;
  consultation.updatedAt = now();
  addConsultationStatusHistory(consultation, fromStatus, toStatus, changedByUserId, note);
}

function summarizeConsultationCallStates(db, consultationId) {
  const callSessions = db.consultationSessions.filter(
    (item) => item.consultationId === consultationId && ['voice_call', 'video_call'].includes(item.channel)
  );
  const counts = {
    idle: 0,
    waiting_room: 0,
    provider_ready: 0,
    in_call: 0,
    ended: 0,
    failed: 0,
    unknown: 0
  };
  let latestCallState = null;
  let latestCallStateAt = null;
  let latestCallStateSessionId = null;
  let latestCallStateAtMs = 0;

  for (const session of callSessions) {
    ensureSessionCallState(session);
    const state = String(session.callState || 'idle').toLowerCase();
    if (counts[state] !== undefined) counts[state] += 1;
    else counts.unknown += 1;

    const stateAtMs = new Date(session.callStateUpdatedAt || session.updatedAt || session.startedAt || session.createdAt).getTime();
    if (Number.isFinite(stateAtMs) && stateAtMs >= latestCallStateAtMs) {
      latestCallStateAtMs = stateAtMs;
      latestCallState = state;
      latestCallStateAt = new Date(stateAtMs).toISOString();
      latestCallStateSessionId = session.id;
    }
  }

  const activeCallSessions = callSessions.filter((item) => item.status === 'active');
  const waitingRoomActive = activeCallSessions.filter((item) => String(item.callState || 'idle') === 'waiting_room');
  const providerReadyActive = activeCallSessions.filter((item) => String(item.callState || 'idle') === 'provider_ready');
  const inCallActive = activeCallSessions.filter((item) => String(item.callState || 'idle') === 'in_call');

  const waitingRoomAgesSeconds = waitingRoomActive
    .map((item) => {
      const updatedAtMs = new Date(item.callStateUpdatedAt || item.updatedAt || item.startedAt || item.createdAt).getTime();
      if (!Number.isFinite(updatedAtMs)) return 0;
      return Math.max(0, Math.round((Date.now() - updatedAtMs) / 1000));
    })
    .sort((a, b) => b - a);
  const providerReadyAgesSeconds = providerReadyActive
    .map((item) => {
      const updatedAtMs = new Date(item.callStateUpdatedAt || item.updatedAt || item.startedAt || item.createdAt).getTime();
      if (!Number.isFinite(updatedAtMs)) return 0;
      return Math.max(0, Math.round((Date.now() - updatedAtMs) / 1000));
    })
    .sort((a, b) => b - a);

  const oldestWaitingRoomSeconds = waitingRoomAgesSeconds[0] || 0;
  const oldestProviderReadySeconds = providerReadyAgesSeconds[0] || 0;
  const waitingPressureScore = Math.min(
    100,
    Math.round(
      waitingRoomActive.length * 35 +
        providerReadyActive.length * 15 +
        Math.max(0, oldestWaitingRoomSeconds - 30) / 3
    )
  );
  const waitingPressureLevel = waitingPressureScore >= 70
    ? 'high'
    : waitingPressureScore >= 35
      ? 'elevated'
      : 'low';

  return {
    totalCallSessions: callSessions.length,
    activeCallSessions: activeCallSessions.length,
    waitingRoomSessions: counts.waiting_room,
    providerReadySessions: counts.provider_ready,
    inCallSessions: counts.in_call,
    endedSessions: counts.ended,
    failedSessions: counts.failed,
    idleSessions: counts.idle,
    unknownSessions: counts.unknown,
    waitingRoomActive: waitingRoomActive.length,
    providerReadyActive: providerReadyActive.length,
    inCallActive: inCallActive.length,
    oldestWaitingRoomSeconds,
    oldestProviderReadySeconds,
    waitingPressureScore,
    waitingPressureLevel,
    latestCallState,
    latestCallStateAt,
    latestCallStateSessionId
  };
}

function expandAssignedClinicianProfile(db, clinician) {
  if (!clinician) return null;
  const availability = clinician.consultationAvailability || {};
  const specialtyNames = (availability.specialtyIds || [])
    .map((specialtyId) => (db.specialties || []).find((item) => item.id === specialtyId)?.name || null)
    .filter(Boolean);
  const procedureNames = (availability.procedureIds || [])
    .map((procedureId) => (db.procedures || []).find((item) => item.id === procedureId)?.name || null)
    .filter(Boolean);
  const provider = clinician.providerId
    ? (db.providers || []).find((item) => item.id === clinician.providerId) || null
    : null;

  return {
    id: clinician.id,
    email: clinician.email,
    phone: clinician.phone || '',
    firstName: clinician.firstName,
    lastName: clinician.lastName,
    fullName: `${clinician.firstName || ''} ${clinician.lastName || ''}`.trim() || 'Assigned clinician',
    role: clinician.role,
    providerId: clinician.providerId || null,
    acceptedTiers: Array.isArray(availability.acceptedTiers) ? availability.acceptedTiers : [],
    specialties: specialtyNames,
    procedures: procedureNames,
    provider: provider
      ? {
          id: provider.id,
          name: provider.name,
          city: provider.city || '',
          state: provider.state || '',
          country: provider.country || '',
          rating: Number(provider.rating || 0),
          onboardingStatus: provider.onboardingStatus || ''
        }
      : null
  };
}

function expandConsultation(db, consultation) {
  if (!consultation) return null;
  const patient = db.patients.find((item) => item.id === consultation.patientId) || null;
  const assignedClinician = db.users.find((item) => item.id === consultation.assignedClinicianId) || null;
  const holdPayment = activeHoldPayment(db, consultation.id) || null;
  const hooks = db.biometricVerifications
    .filter((item) => item.consultationId === consultation.id)
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  const latestHook = hooks[hooks.length - 1] || null;
  const riskSummary = consultationRiskSummary(db, consultation);
  const callStateSummary = summarizeConsultationCallStates(db, consultation.id);
  return {
    ...consultation,
    patient,
    assignedClinician: expandAssignedClinicianProfile(db, assignedClinician),
    holdPayment,
    biometricSummary: {
      total: hooks.length,
      latestStatus: latestHook?.status || null,
      latestMethod: latestHook?.method || null,
      latestAt: latestHook?.createdAt || null
    },
    riskSummary,
    callStateSummary
  };
}

function buildConsultationEventLog(db, consultation) {
  const consultationId = consultation.id;
  const timeline = [];

  for (const item of consultation.statusHistory || []) {
    timeline.push({
      id: item.id,
      kind: 'state_transition',
      at: item.createdAt,
      message: `${item.fromStatus || 'NONE'} -> ${item.toStatus}`,
      actorId: item.changedByUserId || null,
      details: {
        fromStatus: item.fromStatus || null,
        toStatus: item.toStatus,
        note: item.note || ''
      }
    });
  }

  for (const claim of db.consultationClaims.filter((item) => item.consultationId === consultationId)) {
    timeline.push({
      id: claim.id,
      kind: 'claim',
      at: claim.createdAt,
      message: `Claim ${claim.outcome}${claim.reason ? ` (${claim.reason})` : ''}`,
      actorId: claim.clinicianId || null,
      details: {
        outcome: claim.outcome,
        reason: claim.reason || null
      }
    });
  }

  for (const session of db.consultationSessions.filter((item) => item.consultationId === consultationId)) {
    ensureSessionCallState(session);
    timeline.push({
      id: session.id,
      kind: 'session',
      at: session.startedAt || session.createdAt,
      message: `Session ${session.channel} opened`,
      actorId: session.startedByUserId || null,
      details: {
        channel: session.channel,
        status: session.status,
        callState: session.callState || 'idle'
      }
    });

    for (const stateChange of session.callStateHistory || []) {
      timeline.push({
        id: stateChange.id,
        kind: 'session',
        at: stateChange.createdAt,
        message: `Call state ${stateChange.fromState || 'none'} -> ${stateChange.toState}`,
        actorId: stateChange.changedByUserId || null,
        details: {
          channel: session.channel,
          sessionId: session.id,
          callState: stateChange.toState,
          reason: stateChange.reason || null,
          metadata: stateChange.metadata || {}
        }
      });
    }

    if (session.endedAt) {
      timeline.push({
        id: `${session.id}_closed`,
        kind: 'session',
        at: session.endedAt,
        message: `Session ${session.channel} closed (${session.endReason || 'session_complete'})`,
        actorId: session.endedByUserId || null,
        details: {
          channel: session.channel,
          status: session.status,
          endReason: session.endReason || null
        }
      });
    }
  }

  for (const interaction of db.consultationInteractions.filter((item) => item.consultationId === consultationId)) {
    timeline.push({
      id: interaction.id,
      kind: 'interaction',
      at: interaction.createdAt,
      message: `Interaction ${interaction.interactionType}${interaction.marker ? ` (${interaction.marker})` : ''}`,
      actorId: interaction.createdByUserId || null,
      details: {
        sessionId: interaction.sessionId,
        channel: interaction.channel,
        interactionType: interaction.interactionType,
        marker: interaction.marker || null,
          message: interaction.message || null,
          metadata: interaction.metadata || {}
      }
    });
  }

  for (const payment of db.payments.filter((item) => item.consultationId === consultationId && item.paymentType === 'consultation_hold')) {
    timeline.push({
      id: payment.id,
      kind: 'payment',
      at: payment.updatedAt || payment.createdAt,
      message: `Hold payment ${payment.status} (NGN ${payment.amount})`,
      actorId: null,
      details: {
        status: payment.status,
        amount: payment.amount,
        reconciliationStatus: payment.reconciliationStatus || null
      }
    });
  }

  for (const hook of db.biometricVerifications.filter((item) => item.consultationId === consultationId)) {
    timeline.push({
      id: hook.id,
      kind: 'biometric_hook',
      at: hook.createdAt,
      message: `Biometric ${hook.method} ${hook.status}`,
      actorId: hook.createdByUserId || null,
      details: {
        method: hook.method,
        status: hook.status,
        actorType: hook.actorType,
        enforced: Boolean(hook.enforced)
      }
    });
  }

  return timeline.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
}

export function listConsultations(db, user) {
  return listConsultationsWithOptions(db, user, {});
}

export function listConsultationsWithOptions(db, user, options = {}) {
  ensureCollections(db);
  const sortMode = normalizedConsultationSortMode(options.sort);
  const statusFilter = normalizedConsultationStatusFilter(options.status);
  const tierFilter = normalizedConsultationTierFilter(options.tier);
  const searchFilter = normalizedConsultationSearchFilter(options.search);
  const fallbackComparator = compareConsultationsByMode(sortMode);
  const rows = db.consultations.filter((consultation) => {
    if (!canViewConsultation(user, consultation)) return false;
    if (user.role !== 'clinician' || consultation.status !== 'REQUESTED') return true;
    return isClinicianEligibleForConsultation(db, user, consultation);
  });

  const filteredRows = rows.filter((consultation) => {
    if (statusFilter && consultation.status !== statusFilter) return false;
    if (tierFilter && consultation.tier !== tierFilter) return false;
    return consultationMatchesSearch(db, consultation, searchFilter);
  });

  return filteredRows
    .slice()
    .sort((a, b) => {
      if (sortMode === 'risk_score') {
        const aRisk = consultationRiskSummary(db, a).score;
        const bRisk = consultationRiskSummary(db, b).score;
        if (bRisk !== aRisk) return bRisk - aRisk;
      }
      return fallbackComparator(a, b);
    })
    .map((consultation) => expandConsultation(db, consultation));
}

export function consultationWorkspaceOverview(db, user, options = {}) {
  ensureCollections(db);
  const sortMode = normalizedConsultationSortMode(options.sort);
  const statusFilter = normalizedConsultationStatusFilter(options.status);
  const tierFilter = normalizedConsultationTierFilter(options.tier);
  const searchFilter = normalizedConsultationSearchFilter(options.search);
  const allVisibleConsultations = listConsultationsWithOptions(db, user, {
    sort: sortMode
  });
  const consultations = listConsultationsWithOptions(db, user, {
    sort: sortMode,
    status: statusFilter,
    tier: tierFilter,
    search: searchFilter
  });
  return {
    consultations,
    snapshot: {
      ...consultationOperationalSnapshot(db),
      alerts: consultationOperationalAlerts(db)
    },
    appliedFilters: {
      sort: sortMode,
      status: statusFilter || 'all',
      tier: tierFilter || 'all',
      search: searchFilter || ''
    },
    meta: {
      visibleCount: consultations.length,
      totalCount: allVisibleConsultations.length
    },
    generatedAt: now()
  };
}

export function createConsultation(db, user, payload) {
  ensureCollections(db);
  assertRole(user, ['patient', 'admin', 'coordinator']);
  const tierName = payload.tier || 'normal';
  const tier = assertConsultationTier(tierName);
  const requestedCommunicationMode =
    normalizeCommunicationChannel(payload.requestedCommunicationMode) ||
    communicationChannelForTier(tierName);
  const carePath = resolveConsultationCarePath(db, payload);
  const patient = patientForConsultation(db, user, payload);
  const timestamp = now();
  const consultation = {
    id: makeId('consultation'),
    consultationNumber: nextConsultationNumber(db),
    patientId: patient.id,
    requestedByUserId: user.id,
    assignedClinicianId: null,
    specialtyId: carePath.specialtyId,
    procedureId: carePath.procedureId,
    tier: tierName,
    communicationMode: requestedCommunicationMode,
    requestedCommunicationMode,
    communicationLayers: buildCommunicationPlan(requestedCommunicationMode),
    activeCommunicationLayer: null,
    amountNgn: tier.price,
    status: 'REQUESTED',
    requestedNeed: normalizeString(payload.requestedNeed, 2000),
    claimWindowEndsAt: new Date(Date.now() + CLAIM_WINDOW_MS).toISOString(),
    acceptedAt: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    cancelReason: null,
    escalationHistory: [],
    statusHistory: [],
    createdAt: timestamp,
    updatedAt: timestamp
  };
  addConsultationStatusHistory(consultation, null, 'REQUESTED', user.id, 'Consultation requested.');
  db.consultations.push(consultation);

  db.payments.push({
    id: makeId('payment'),
    referralId: null,
    consultationId: consultation.id,
    patientId: patient.id,
    amount: tier.price,
    currency: 'NGN',
    paymentType: 'consultation_hold',
    status: 'held',
    paymentMethod: normalizeString(payload.paymentMethod || 'card', 50),
    transactionReference: normalizeString(payload.transactionReference || makeId('txn_hold'), 255),
    providerPayoutAmount: null,
    reconciliationStatus: 'unreconciled',
    paidAt: null,
    createdAt: timestamp,
    updatedAt: timestamp
  });

  sendConsultationEventNotifications(db, consultation, {
    eventKey: 'consultation_request_created',
    audiences: ['patient', 'eligible_clinicians', 'coordinator'],
    subject: {
      patient: 'Consultation request created',
      eligible_clinicians: 'New consultation request available',
      coordinator: 'New consultation request submitted'
    },
    body: {
      patient: `${consultation.consultationNumber} is now broadcasting to available doctors.`,
      eligible_clinicians: `${consultation.consultationNumber} is available to claim in your queue.`,
      coordinator: `${consultation.consultationNumber} was submitted and is broadcasting to eligible clinicians.`
    }
  });
  audit(db, user.id, 'created', 'consultation', consultation.id, { tier: consultation.tier, amountNgn: consultation.amountNgn });

  return expandConsultation(db, consultation);
}

export function claimConsultation(db, user, consultationId) {
  ensureCollections(db);
  assertRole(user, ['clinician']);
  const consultation = consultationByNumberOrId(db, consultationId);
  if (!consultation) {
    const error = new Error('Consultation not found.');
    error.status = 404;
    throw error;
  }

  const timestamp = now();
  if (consultation.status !== 'REQUESTED') {
    db.consultationClaims.push({
      id: makeId('consultation_claim'),
      consultationId: consultation.id,
      clinicianId: user.id,
      outcome: 'conflict',
      reason: `Consultation is already ${consultation.status}.`,
      createdAt: timestamp
    });
    const error = new Error('Consultation already claimed or no longer claimable.');
    error.status = 409;
    throw error;
  }

  if (!isClinicianEligibleForConsultation(db, user, consultation)) {
    db.consultationClaims.push({
      id: makeId('consultation_claim'),
      consultationId: consultation.id,
      clinicianId: user.id,
      outcome: 'ineligible',
      reason: 'Clinician is not eligible for this specialty/procedure broadcast.',
      createdAt: timestamp
    });
    const error = new Error('You are not eligible to claim this consultation based on your availability rules.');
    error.status = 403;
    throw error;
  }

  if (new Date(consultation.claimWindowEndsAt).getTime() <= Date.now()) {
    db.consultationClaims.push({
      id: makeId('consultation_claim'),
      consultationId: consultation.id,
      clinicianId: user.id,
      outcome: 'expired',
      reason: 'Claim window expired.',
      createdAt: timestamp
    });
    transitionConsultation(consultation, 'REQUESTED', 'CANCELLED', user.id, 'Claim window elapsed before acceptance.');
    consultation.cancelledAt = now();
    consultation.cancelReason = 'unclaimed_timeout';
    releaseConsultationHold(db, consultation, 'unclaimed_timeout');
    const error = new Error('Claim window expired for this consultation.');
    error.status = 409;
    throw error;
  }

  consultation.assignedClinicianId = user.id;
  consultation.acceptedAt = timestamp;
  consultation.communicationLayers = buildCommunicationPlan(
    consultation.requestedCommunicationMode || consultation.communicationMode
  );
  transitionConsultation(consultation, 'REQUESTED', 'DOCTOR_ACCEPTED', user.id, 'Doctor claimed consultation.');

  db.consultationClaims.push({
    id: makeId('consultation_claim'),
    consultationId: consultation.id,
    clinicianId: user.id,
    outcome: 'accepted',
    reason: null,
    createdAt: timestamp
  });

  const patient = db.patients.find((item) => item.id === consultation.patientId);
  sendConsultationEventNotifications(db, consultation, {
    eventKey: 'consultation_claimed',
    audiences: ['patient', 'clinician', 'coordinator'],
    subject: {
      patient: 'Doctor accepted your request',
      clinician: 'Consultation claim confirmed',
      coordinator: 'Consultation claimed by clinician'
    },
    body: {
      patient: `${consultation.consultationNumber} has been accepted by a doctor.`,
      clinician: `You successfully claimed ${consultation.consultationNumber}.`,
      coordinator: `${consultation.consultationNumber} was claimed and is ready for consultation start.`
    }
  });
  audit(db, user.id, 'claimed', 'consultation', consultation.id);

  return expandConsultation(db, consultation);
}

export function startConsultation(db, user, consultationId, payload = {}) {
  ensureCollections(db);
  const consultation = consultationByNumberOrId(db, consultationId);
  if (!consultation) {
    const error = new Error('Consultation not found.');
    error.status = 404;
    throw error;
  }

  if (!['admin', 'coordinator'].includes(user.role) && consultation.assignedClinicianId !== user.id) {
    const error = new Error('Only the assigned clinician can start this consultation.');
    error.status = 403;
    throw error;
  }

  if (consultation.status !== 'DOCTOR_ACCEPTED') {
    const error = new Error('Consultation must be doctor-accepted before it can start.');
    error.status = 422;
    throw error;
  }

  transitionConsultation(consultation, 'DOCTOR_ACCEPTED', 'IN_PROGRESS', user.id, 'Consultation started.');
  consultation.startedAt = now();

  if (payload.autoOpenSession === true || payload.channel) {
    ensureActiveCommunicationLayer(db, user, consultation.id, { channel: payload.channel });
  }

  const patient = db.patients.find((item) => item.id === consultation.patientId);
  sendConsultationEventNotifications(db, consultation, {
    eventKey: 'consultation_started',
    audiences: ['patient', 'clinician', 'coordinator'],
    excludeActorId: user.id,
    subject: {
      patient: 'Consultation started',
      clinician: 'Consultation session started',
      coordinator: 'Consultation started'
    },
    body: {
      patient: `${consultation.consultationNumber} is now in progress.`,
      clinician: `${consultation.consultationNumber} is now marked in progress.`,
      coordinator: `${consultation.consultationNumber} has moved to in progress.`
    }
  });

  audit(db, user.id, 'started', 'consultation', consultation.id);
  return expandConsultation(db, consultation);
}

export function escalateConsultationTier(db, user, consultationId, payload) {
  ensureCollections(db);
  const consultation = consultationByNumberOrId(db, consultationId);
  if (!consultation) {
    const error = new Error('Consultation not found.');
    error.status = 404;
    throw error;
  }

  if (!['admin', 'coordinator'].includes(user.role) && consultation.assignedClinicianId !== user.id) {
    const error = new Error('Only the assigned clinician can escalate this consultation.');
    error.status = 403;
    throw error;
  }
  if (consultation.status !== 'IN_PROGRESS') {
    const error = new Error('Consultation can only be escalated while in progress.');
    error.status = 422;
    throw error;
  }

  const nextTier = payload.toTier;
  assertTierEscalation(consultation.tier, nextTier);
  const currentTier = assertConsultationTier(consultation.tier);
  const targetTier = assertConsultationTier(nextTier);
  const timestamp = now();

  consultation.escalationHistory.push({
    id: makeId('consultation_escalation'),
    fromTier: consultation.tier,
    toTier: nextTier,
    changedByUserId: user.id,
    reason: normalizeString(payload.reason, 500),
    createdAt: timestamp
  });
  consultation.tier = nextTier;
  consultation.amountNgn = targetTier.price;
  consultation.updatedAt = timestamp;

  const hold = activeHoldPayment(db, consultation.id);
  if (hold && hold.status === 'held') {
    hold.amount = targetTier.price;
    hold.updatedAt = timestamp;
  }

  const patient = db.patients.find((item) => item.id === consultation.patientId);
  sendConsultationEventNotifications(db, consultation, {
    eventKey: 'consultation_tier_updated',
    audiences: ['patient', 'clinician', 'coordinator'],
    excludeActorId: user.id,
    subject: {
      patient: 'Consultation tier updated',
      clinician: 'Consultation tier updated',
      coordinator: 'Consultation tier escalated'
    },
    body: {
      patient: `${consultation.consultationNumber} moved from ${currentTier.label} to ${targetTier.label}.`,
      clinician: `${consultation.consultationNumber} was escalated from ${currentTier.label} to ${targetTier.label}.`,
      coordinator: `${consultation.consultationNumber} escalated from ${currentTier.label} to ${targetTier.label}.`
    }
  });

  audit(db, user.id, 'escalated_tier', 'consultation', consultation.id, {
    fromTier: currentTier.label,
    toTier: targetTier.label,
    deltaAmountNgn: targetTier.price - currentTier.price
  });

  return expandConsultation(db, consultation);
}

export function completeConsultation(db, user, consultationId) {
  ensureCollections(db);
  const consultation = consultationByNumberOrId(db, consultationId);
  if (!consultation) {
    const error = new Error('Consultation not found.');
    error.status = 404;
    throw error;
  }

  if (!['admin', 'coordinator'].includes(user.role) && consultation.assignedClinicianId !== user.id) {
    const error = new Error('Only the assigned clinician can complete this consultation.');
    error.status = 403;
    throw error;
  }

  if (consultation.status !== 'IN_PROGRESS') {
    const error = new Error('Consultation must be in progress before completion.');
    error.status = 422;
    throw error;
  }

  transitionConsultation(consultation, 'IN_PROGRESS', 'COMPLETED', user.id, 'Consultation completed.');
  consultation.completedAt = now();

  const hold = activeHoldPayment(db, consultation.id);
  if (hold && hold.status === 'held') {
    hold.status = 'captured';
    hold.paidAt = consultation.completedAt;
    hold.updatedAt = consultation.completedAt;
  }

  const patient = db.patients.find((item) => item.id === consultation.patientId);
  sendConsultationEventNotifications(db, consultation, {
    eventKey: 'consultation_completed',
    audiences: ['patient', 'clinician', 'coordinator'],
    excludeActorId: user.id,
    subject: {
      patient: 'Consultation completed',
      clinician: 'Consultation completed',
      coordinator: 'Consultation completed'
    },
    body: {
      patient: `${consultation.consultationNumber} is completed and your payment hold has been captured.`,
      clinician: `${consultation.consultationNumber} has been completed successfully.`,
      coordinator: `${consultation.consultationNumber} has completed and billing hold is finalized.`
    }
  });

  audit(db, user.id, 'completed', 'consultation', consultation.id);
  return expandConsultation(db, consultation);
}

export function cancelConsultation(db, user, consultationId, payload = {}) {
  ensureCollections(db);
  const consultation = consultationByNumberOrId(db, consultationId);
  if (!consultation) {
    const error = new Error('Consultation not found.');
    error.status = 404;
    throw error;
  }

  const canCancel =
    ['admin', 'coordinator'].includes(user.role) ||
    consultation.assignedClinicianId === user.id ||
    (user.role === 'patient' && consultation.patientId === user.patientId);
  if (!canCancel) {
    const error = new Error('You do not have permission to cancel this consultation.');
    error.status = 403;
    throw error;
  }

  const cancelReason = normalizeString(payload.reason, 500);
  if (!cancelReason) {
    const error = new Error('Cancellation reason is required.');
    error.status = 422;
    throw error;
  }

  transitionConsultation(consultation, consultation.status, 'CANCELLED', user.id, 'Consultation cancelled.');
  consultation.cancelledAt = now();
  consultation.cancelReason = cancelReason;
  releaseConsultationHold(db, consultation, consultation.cancelReason || 'cancelled');

  const patient = db.patients.find((item) => item.id === consultation.patientId);
  sendConsultationEventNotifications(db, consultation, {
    eventKey: 'consultation_cancelled',
    audiences: ['patient', 'clinician', 'coordinator'],
    excludeActorId: user.id,
    subject: {
      patient: 'Consultation cancelled',
      clinician: 'Consultation cancelled',
      coordinator: 'Consultation cancelled'
    },
    body: {
      patient: `${consultation.consultationNumber} was cancelled and your payment hold has been released.`,
      clinician: `${consultation.consultationNumber} was cancelled and removed from active workflow.`,
      coordinator: `${consultation.consultationNumber} was cancelled and hold release has been recorded.`
    }
  });
  audit(db, user.id, 'cancelled', 'consultation', consultation.id, { reason: consultation.cancelReason || null });
  return expandConsultation(db, consultation);
}

function releaseConsultationHold(db, consultation, reason) {
  const hold = activeHoldPayment(db, consultation.id);
  const timestamp = now();
  if (hold && hold.status === 'held') {
    hold.status = 'released';
    hold.updatedAt = timestamp;
    hold.releasedAt = timestamp;
    hold.releaseReason = reason;
  }
}

export function triggerClaimWindowSweep(db, actorId) {
  ensureCollections(db);
  const expired = db.consultations.filter(
    (consultation) => consultation.status === 'REQUESTED' && new Date(consultation.claimWindowEndsAt).getTime() <= Date.now()
  );

  for (const consultation of expired) {
    transitionConsultation(consultation, 'REQUESTED', 'CANCELLED', actorId, 'Claim window elapsed before acceptance.');
    consultation.cancelledAt = now();
    consultation.cancelReason = 'unclaimed_timeout';
    releaseConsultationHold(db, consultation, 'unclaimed_timeout');
    db.consultationClaims.push({
      id: makeId('consultation_claim'),
      consultationId: consultation.id,
      clinicianId: null,
      outcome: 'expired',
      reason: 'Claim window expired before acceptance.',
      createdAt: now()
    });

    const patient = db.patients.find((item) => item.id === consultation.patientId);
    sendConsultationEventNotifications(db, consultation, {
      eventKey: 'consultation_claim_window_expired',
      audiences: ['patient', 'coordinator'],
      subject: {
        patient: 'Consultation cancelled',
        coordinator: 'Consultation expired without claim'
      },
      body: {
        patient: `${consultation.consultationNumber} was cancelled because no clinician accepted it in time.`,
        coordinator: `${consultation.consultationNumber} expired without a clinician claim and was auto-cancelled.`
      }
    });

    audit(db, actorId, 'claim_window_expired', 'consultation', consultation.id);
  }

  return { released: expired.length };
}

export function recordBiometricHook(db, user, consultationId, payload) {
  ensureCollections(db);
  const consultation = consultationByNumberOrId(db, consultationId);
  if (!consultation) {
    const error = new Error('Consultation not found.');
    error.status = 404;
    throw error;
  }

  const canRecordBiometrics =
    ['admin', 'coordinator'].includes(user.role) ||
    consultation.assignedClinicianId === user.id;
  if (!canRecordBiometrics) {
    const error = new Error('Only the assigned clinician or operations staff can record biometric hooks.');
    error.status = 403;
    throw error;
  }

  const method = normalizeString(payload.method || 'face', 50).toLowerCase();
  const status = normalizeString(payload.status || 'captured', 50).toLowerCase();
  if (!['face', 'speaker'].includes(method)) {
    const error = new Error('Biometric method must be face or speaker.');
    error.status = 422;
    throw error;
  }
  if (!['captured', 'matched', 'failed'].includes(status)) {
    const error = new Error('Biometric status must be captured, matched, or failed.');
    error.status = 422;
    throw error;
  }

  const hook = {
    id: makeId('biometric'),
    consultationId: consultation.id,
    actorType: normalizeString(payload.actorType || 'doctor', 30).toLowerCase(),
    actorId: normalizeString(payload.actorId || user.id, 100),
    method,
    status,
    verificationMode: normalizeString(payload.verificationMode || 'hook_only', 30).toLowerCase(),
    enforced: false,
    metadata: payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : {},
    createdByUserId: user.id,
    createdAt: now(),
    updatedAt: now()
  };

  db.biometricVerifications.push(hook);
  audit(db, user.id, 'biometric_hook_recorded', 'consultation', consultation.id, { method, status, enforced: false });
  return hook;
}

export function listConsultationSessions(db, user, consultationId) {
  ensureCollections(db);
  const consultation = consultationByNumberOrId(db, consultationId);
  if (!consultation || !canViewConsultation(user, consultation)) {
    const error = new Error('Consultation not found.');
    error.status = 404;
    throw error;
  }
  return db.consultationSessions
    .filter((item) => item.consultationId === consultation.id)
    .map((session) => {
      ensureSessionCallState(session);
      return session;
    });
}

export function getConsultationCallSessionContext(db, user, consultationId, sessionId) {
  ensureCollections(db);
  const consultation = consultationByNumberOrId(db, consultationId);
  if (!consultation || !canViewConsultation(user, consultation)) {
    const error = new Error('Consultation not found.');
    error.status = 404;
    throw error;
  }

  const session = consultationSessionById(db, sessionId);
  if (!session || session.consultationId !== consultation.id) {
    const error = new Error('Consultation session not found.');
    error.status = 404;
    throw error;
  }

  if (!['voice_call', 'video_call'].includes(session.channel)) {
    const error = new Error('Call transport is only available for voice_call and video_call sessions.');
    error.status = 422;
    throw error;
  }

  if (session.status !== 'active') {
    const error = new Error('Call transport is only available for active communication sessions.');
    error.status = 409;
    throw error;
  }

  ensureSessionCallState(session);

  return { consultation, session };
}

export function transitionConsultationCallSessionState(db, user, consultationId, sessionId, payload = {}) {
  ensureCollections(db);
  const { consultation, session } = getConsultationCallSessionContext(db, user, consultationId, sessionId);

  if (!canManageConsultationCallState(db, user, consultation)) {
    const error = new Error('You do not have permission to update call state for this consultation session.');
    error.status = 403;
    throw error;
  }

  const nextState =
    normalizeCallSessionState(payload.state) ||
    callStateFromMarker(payload.marker);
  if (!nextState) {
    const error = new Error(`state must be one of: ${CALL_SESSION_STATES.join(', ')}.`);
    error.status = 422;
    throw error;
  }

  if (nextState === 'provider_ready' && !['clinician', 'coordinator', 'admin'].includes(user.role)) {
    const error = new Error('Only clinicians or operations staff can mark provider_ready state.');
    error.status = 403;
    throw error;
  }

  const transition = applyCallSessionStateTransition(session, nextState, user.id, {
    reason: payload.reason,
    metadata: payload.metadata
  });
  const marker = CALL_STATE_TO_MARKER[nextState] || null;

  if (transition.changed && marker) {
    pushSessionMarkerInteraction(db, consultation, session, {
      marker,
      metadata: {
        source: 'call_state_transition',
        reason: normalizeString(payload.reason, 300) || null,
        ...(payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : {})
      },
      userId: user.id,
      role: user.role
    });
  }

  const actorLabel =
    user.role === 'patient'
      ? 'Patient'
      : user.role === 'clinician'
        ? 'Provider'
        : 'Care operations';

  if (transition.changed && nextState === 'waiting_room') {
    sendConsultationEventNotifications(db, consultation, {
      eventKey: 'consultation_call_waiting_room',
      forceChannels: ['in_app', 'sms', 'email'],
      audiences: ['patient', 'clinician', 'coordinator'],
      excludeActorId: user.id,
      subject: {
        default: 'Consultation call waiting room update'
      },
      body: {
        default: `${consultation.consultationNumber} ${actorLabel.toLowerCase()} is waiting in the ${communicationLabel(session.channel)} room.`
      }
    });
  }

  if (transition.changed && nextState === 'provider_ready') {
    sendConsultationEventNotifications(db, consultation, {
      eventKey: 'consultation_call_provider_ready',
      forceChannels: ['in_app', 'sms', 'email'],
      audiences: ['patient', 'clinician', 'coordinator'],
      excludeActorId: user.id,
      subject: {
        default: 'Consultation provider is ready'
      },
      body: {
        default: `${consultation.consultationNumber} provider is ready to begin the ${communicationLabel(session.channel)} session.`
      }
    });
  }

  audit(db, user.id, 'updated_consultation_call_state', 'consultation', consultation.id, {
    sessionId: session.id,
    channel: session.channel,
    previousState: transition.fromState,
    state: nextState,
    reason: normalizeString(payload.reason, 300) || null
  });

  return {
    session,
    state: session.callState,
    previousState: transition.fromState,
    changed: transition.changed,
    updatedAt: session.callStateUpdatedAt
  };
}

export function authorizeConsultationCallSignal(db, payload = {}) {
  ensureCollections(db);
  const consultation = consultationByNumberOrId(db, payload.consultationId);
  if (!consultation) {
    return { ok: false, status: 404, error: 'Consultation not found.' };
  }

  const session = consultationSessionById(db, payload.sessionId);
  if (!session || session.consultationId !== consultation.id) {
    return { ok: false, status: 404, error: 'Consultation session not found.' };
  }

  if (!['voice_call', 'video_call'].includes(session.channel)) {
    return { ok: false, status: 422, error: 'Call signaling is only available for voice_call and video_call sessions.' };
  }

  if (session.status !== 'active') {
    return { ok: false, status: 409, error: 'Consultation session is not active.' };
  }

  const signalType = normalizeString(payload.signalType, 40).toLowerCase();
  const senderUserId = normalizeString(payload.fromUserId, 120);
  const senderRole = normalizeString(payload.fromRole, 40).toLowerCase();
  const targetUserId = normalizeString(payload.targetUserId, 120) || null;

  const sender = db.users.find((item) => item.id === senderUserId) || null;
  if (!sender || (senderRole && sender.role !== senderRole)) {
    return { ok: false, status: 403, error: 'Signal sender is not authorized for this call session.' };
  }

  const participantUserIds = callSessionParticipantUserIds(db, consultation);
  const senderIsOperations = ['admin', 'coordinator'].includes(sender.role);
  const senderIsParticipant = participantUserIds.includes(sender.id);
  if (!senderIsParticipant && !senderIsOperations) {
    return { ok: false, status: 403, error: 'Only consultation participants can send call signaling events.' };
  }

  const directSignalTypes = new Set(['offer', 'answer', 'ice_candidate', 'hangup', 'media_state']);
  if (directSignalTypes.has(signalType) && !targetUserId) {
    return { ok: false, status: 422, error: `targetUserId is required for ${signalType} signals.` };
  }

  if (targetUserId) {
    if (targetUserId === senderUserId) {
      return { ok: false, status: 422, error: 'targetUserId cannot match sender user id.' };
    }
    if (!participantUserIds.includes(targetUserId)) {
      return { ok: false, status: 403, error: 'Signal target must be a participant in this consultation session.' };
    }
  }

  return {
    ok: true,
    senderRole: sender.role,
    targetUserId,
    participantUserIds,
    consultationId: consultation.id,
    sessionId: session.id
  };
}

export function recordConsultationCallAuditEvent(db, payload = {}) {
  ensureCollections(db);
  const consultation = consultationByNumberOrId(db, payload.consultationId);
  if (!consultation) return null;

  const session = consultationSessionById(db, payload.sessionId);
  if (!session || session.consultationId !== consultation.id) return null;
  if (!['voice_call', 'video_call'].includes(session.channel)) return null;

  ensureSessionCallState(session);
  const marker = normalizeString(payload.marker, 40).toLowerCase();
  if (!SESSION_MARKERS.includes(marker)) return null;

  const interaction = pushSessionMarkerInteraction(db, consultation, session, {
    marker,
    metadata: payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : {},
    userId: normalizeString(payload.userId, 120) || 'system_signaling',
    role: normalizeString(payload.role, 30).toLowerCase() || 'system'
  });

  const nextState = callStateFromMarker(marker);
  if (nextState) {
    try {
      applyCallSessionStateTransition(session, nextState, interaction.createdByUserId, {
        reason: normalizeString(payload.reason, 300) || marker,
        metadata: {
          source: 'signaling_audit',
          ...(payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : {})
        }
      });
    } catch {
      // Keep marker audit events even when state transition edge-cases are not applicable.
    }
  }

  audit(db, interaction.createdByUserId, 'consultation_call_audit_event', 'consultation', consultation.id, {
    sessionId: session.id,
    marker,
    reason: normalizeString(payload.reason, 300) || null
  });

  return interaction;
}

export function listConsultationInteractions(db, user, consultationId, sessionId) {
  return listConsultationInteractionsWithOptions(db, user, consultationId, sessionId, {});
}

export function listConsultationInteractionsWithOptions(db, user, consultationId, sessionId, options = {}) {
  ensureCollections(db);
  const consultation = consultationByNumberOrId(db, consultationId);
  if (!consultation || !canViewConsultation(user, consultation)) {
    const error = new Error('Consultation not found.');
    error.status = 404;
    throw error;
  }

  const session = consultationSessionById(db, sessionId);
  if (!session || session.consultationId !== consultation.id) {
    const error = new Error('Consultation session not found.');
    error.status = 404;
    throw error;
  }

  const rawType = normalizeString(options.type || '', 50).toLowerCase();
  const type = rawType ? rawType.replace(/[-\s]+/g, '_') : '';
  if (type && !CONSULTATION_INTERACTION_TYPES.includes(type)) {
    const error = new Error(`type must be one of: ${CONSULTATION_INTERACTION_TYPES.join(', ')}.`);
    error.status = 422;
    throw error;
  }

  const rawActorRole = normalizeString(options.actorRole || '', 30).toLowerCase();
  const actorRole = rawActorRole ? rawActorRole.replace(/[-\s]+/g, '_') : '';

  const numericLimit = Number(options.limit);
  const limit = Number.isFinite(numericLimit) && numericLimit > 0
    ? Math.min(Math.floor(numericLimit), 200)
    : null;

  let interactions = consultationInteractionBySession(db, session.id);
  if (type) {
    interactions = interactions.filter((item) => item.interactionType === type);
  }
  if (actorRole) {
    interactions = interactions.filter((item) => item.createdByRole === actorRole);
  }
  if (limit !== null) {
    interactions = interactions.slice(0, limit);
  }

  return interactions;
}

export function recordConsultationInteraction(db, user, consultationId, sessionId, payload = {}) {
  ensureCollections(db);
  const consultation = consultationByNumberOrId(db, consultationId);
  if (!consultation) {
    const error = new Error('Consultation not found.');
    error.status = 404;
    throw error;
  }

  const session = consultationSessionById(db, sessionId);
  if (!session || session.consultationId !== consultation.id) {
    const error = new Error('Consultation session not found.');
    error.status = 404;
    throw error;
  }

  const canContribute =
    ['admin', 'coordinator'].includes(user.role) ||
    consultation.assignedClinicianId === user.id ||
    (user.role === 'patient' && consultation.patientId === user.patientId);
  if (!canContribute) {
    const error = new Error('You do not have permission to add consultation interactions.');
    error.status = 403;
    throw error;
  }

  const normalizedMessage = normalizeString(payload.message, 4000);
  const normalizedMarker = normalizeString(payload.marker, 40).toLowerCase();

  let requestedType = payload.interactionType;
  if (!normalizeString(requestedType, 80)) {
    if (session.channel === 'voice_text' && normalizedMessage) {
      requestedType = user.role === 'patient' ? 'patient_message' : 'clinician_message';
    } else if (['voice_call', 'video_call'].includes(session.channel) && normalizedMarker) {
      requestedType = 'session_marker';
    } else {
      requestedType = 'clinical_note';
    }
  }

  const interactionType = normalizeInteractionType(requestedType);
  const messageRequiredTypes = ['patient_message', 'clinician_message', 'clinical_note'];
  const fallbackMarkerTypeAllowed =
    messageRequiredTypes.includes(interactionType) &&
    !normalizedMessage &&
    ['voice_call', 'video_call'].includes(session.channel) &&
    SESSION_MARKERS.includes(normalizedMarker);
  const resolvedInteractionType = fallbackMarkerTypeAllowed ? 'session_marker' : interactionType;
  const allowedTypes = allowedInteractionTypesForChannel(session.channel);
  if (!allowedTypes.includes(resolvedInteractionType)) {
    const error = new Error(`Interaction type ${resolvedInteractionType} is not allowed for ${session.channel} sessions.`);
    error.status = 422;
    throw error;
  }

  if (session.status !== 'active' && resolvedInteractionType !== 'clinical_note') {
    const error = new Error('Only clinical_note interactions can be added after a session is closed.');
    error.status = 409;
    throw error;
  }

  if (resolvedInteractionType === 'patient_message' && user.role !== 'patient') {
    const error = new Error('patient_message interactions must be created by the patient participant.');
    error.status = 403;
    throw error;
  }
  if (resolvedInteractionType === 'clinician_message' && !['clinician', 'admin', 'coordinator'].includes(user.role)) {
    const error = new Error('clinician_message interactions must be created by clinical staff.');
    error.status = 403;
    throw error;
  }

  const message = normalizedMessage;
  const marker = normalizedMarker;
  if (['patient_message', 'clinician_message', 'clinical_note'].includes(resolvedInteractionType) && !message) {
    const error = new Error('message is required for patient_message, clinician_message, and clinical_note interactions.');
    error.status = 422;
    throw error;
  }
  if (resolvedInteractionType === 'session_marker' && !SESSION_MARKERS.includes(marker)) {
    const error = new Error(`marker must be one of: ${SESSION_MARKERS.join(', ')}.`);
    error.status = 422;
    throw error;
  }

  const timestamp = now();
  const interaction = {
    id: makeId('consultation_interaction'),
    consultationId: consultation.id,
    sessionId: session.id,
    channel: session.channel,
    interactionType: resolvedInteractionType,
    marker: resolvedInteractionType === 'session_marker' ? marker : null,
    message: message || null,
    metadata: payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : {},
    createdByUserId: user.id,
    createdByRole: user.role,
    createdAt: timestamp,
    updatedAt: timestamp
  };

  db.consultationInteractions.push(interaction);

  if (resolvedInteractionType === 'session_marker') {
    ensureSessionCallState(session);
    const inferredCallState = callStateFromMarker(marker);
    if (inferredCallState) {
      try {
        applyCallSessionStateTransition(session, inferredCallState, user.id, {
          reason: marker,
          metadata: {
            source: 'interaction_marker',
            interactionId: interaction.id
          }
        });
      } catch {
        // Session marker persistence should not fail due to non-critical state transition edge cases.
      }
    }
  }

  audit(db, user.id, 'consultation_interaction_recorded', 'consultation', consultation.id, {
    sessionId: session.id,
    interactionType: resolvedInteractionType,
    channel: session.channel
  });

  return interaction;
}

export function openConsultationSession(db, user, consultationId, payload = {}) {
  ensureCollections(db);
  const consultation = consultationByNumberOrId(db, consultationId);
  if (!consultation) {
    const error = new Error('Consultation not found.');
    error.status = 404;
    throw error;
  }
  if (consultation.status !== 'IN_PROGRESS') {
    const error = new Error('Consultation communication can only start while in progress.');
    error.status = 422;
    throw error;
  }

  const canOpen =
    ['admin', 'coordinator'].includes(user.role) ||
    consultation.assignedClinicianId === user.id ||
    (user.role === 'patient' && consultation.patientId === user.patientId);
  if (!canOpen) {
    const error = new Error('You do not have permission to start this consultation communication session.');
    error.status = 403;
    throw error;
  }

  const channel =
    normalizeCommunicationChannel(payload.channel) ||
    normalizeCommunicationChannel(consultation.activeCommunicationLayer) ||
    normalizeCommunicationChannel(consultation.requestedCommunicationMode) ||
    normalizeCommunicationChannel(consultation.communicationMode) ||
    communicationChannelForTier(consultation.tier);
  const allowed = consultation.communicationLayers?.length ? consultation.communicationLayers : COMMUNICATION_LAYERS;
  if (!allowed.includes(channel)) {
    const error = new Error(`Requested communication layers allow: ${allowed.join(', ')}.`);
    error.status = 422;
    throw error;
  }

  const activeSession = db.consultationSessions.find(
    (item) => item.consultationId === consultation.id && item.status === 'active'
  );
  if (activeSession) {
    if (activeSession.channel === channel) {
      if (consultation.activeCommunicationLayer !== channel) {
        consultation.activeCommunicationLayer = channel;
        consultation.communicationMode = channel;
        consultation.updatedAt = now();
      }
      return activeSession;
    }
    const error = new Error('An active communication session already exists for this consultation.');
    error.status = 409;
    throw error;
  }

  const timestamp = now();
  const previousLayer =
    normalizeCommunicationChannel(consultation.activeCommunicationLayer) ||
    normalizeCommunicationChannel(consultation.communicationMode);
  const session = {
    id: makeId('consultation_session'),
    consultationId: consultation.id,
    channel,
    status: 'active',
    startedByUserId: user.id,
    endedByUserId: null,
    participantRoles: ['patient', 'clinician'],
    metadata: payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : {},
    startedAt: timestamp,
    endedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp
  };
  if (['voice_call', 'video_call'].includes(channel)) {
    session.callState = 'idle';
    session.callStateReason = null;
    session.callStateUpdatedAt = timestamp;
    session.callStateHistory = [];
  }
  db.consultationSessions.push(session);
  consultation.activeCommunicationLayer = channel;
  consultation.communicationMode = channel;
  consultation.updatedAt = timestamp;

  const patient = db.patients.find((item) => item.id === consultation.patientId);
  sendConsultationEventNotifications(db, consultation, {
    eventKey: previousLayer && previousLayer !== channel ? 'consultation_communication_switched' : 'consultation_communication_opened',
    audiences: ['patient', 'clinician', 'coordinator'],
    excludeActorId: user.id,
    subject: {
      default: previousLayer && previousLayer !== channel ? 'Consultation communication switched' : 'Consultation communication opened'
    },
    body: {
      default:
        previousLayer && previousLayer !== channel
          ? `${consultation.consultationNumber} switched from ${communicationLabel(previousLayer)} to ${communicationLabel(channel)}.`
          : `${consultation.consultationNumber} started a ${communicationLabel(channel)} session.`
    }
  });

  audit(db, user.id, 'opened_consultation_session', 'consultation', consultation.id, {
    sessionId: session.id,
    channel
  });
  return session;
}

export function closeConsultationSession(db, user, consultationId, sessionId, payload = {}) {
  ensureCollections(db);
  const consultation = consultationByNumberOrId(db, consultationId);
  if (!consultation || !canViewConsultation(user, consultation)) {
    const error = new Error('Consultation not found.');
    error.status = 404;
    throw error;
  }

  const session = consultationSessionById(db, sessionId);
  if (!session || session.consultationId !== consultation.id) {
    const error = new Error('Consultation session not found.');
    error.status = 404;
    throw error;
  }
  if (session.status !== 'active') {
    const error = new Error('Consultation session is already closed.');
    error.status = 409;
    throw error;
  }

  const canClose =
    ['admin', 'coordinator'].includes(user.role) ||
    consultation.assignedClinicianId === user.id ||
    (user.role === 'patient' && consultation.patientId === user.patientId);
  if (!canClose) {
    const error = new Error('You do not have permission to close this consultation communication session.');
    error.status = 403;
    throw error;
  }

  const closeReason = normalizeString(payload.reason, 100);
  if (!closeReason) {
    const error = new Error('Session close reason is required.');
    error.status = 422;
    throw error;
  }

  const timestamp = now();
  session.status = 'completed';
  session.endedByUserId = user.id;
  session.endReason = closeReason;
  session.endedAt = timestamp;
  session.updatedAt = timestamp;
  if (consultation.activeCommunicationLayer === session.channel) {
    consultation.activeCommunicationLayer = null;
    consultation.updatedAt = timestamp;
  }

  const patient = db.patients.find((item) => item.id === consultation.patientId);
  sendConsultationEventNotifications(db, consultation, {
    eventKey: 'consultation_communication_closed',
    audiences: ['patient', 'clinician', 'coordinator'],
    excludeActorId: user.id,
    subject: {
      default: 'Consultation communication closed'
    },
    body: {
      default: `${consultation.consultationNumber} ${communicationLabel(session.channel)} session ended (${session.endReason}).`
    }
  });

  audit(db, user.id, 'closed_consultation_session', 'consultation', consultation.id, {
    sessionId: session.id,
    reason: session.endReason
  });
  return session;
}

export function ensureActiveCommunicationLayer(db, user, consultationId, payload = {}) {
  ensureCollections(db);
  const consultation = consultationByNumberOrId(db, consultationId);
  if (!consultation || !canViewConsultation(user, consultation)) {
    const error = new Error('Consultation not found.');
    error.status = 404;
    throw error;
  }

  if (consultation.status !== 'IN_PROGRESS') {
    const error = new Error('Active communication layer can only be ensured for in-progress consultations.');
    error.status = 422;
    throw error;
  }

  const activeSession = db.consultationSessions.find(
    (item) => item.consultationId === consultation.id && item.status === 'active'
  );
  if (activeSession) {
    if (consultation.activeCommunicationLayer !== activeSession.channel) {
      consultation.activeCommunicationLayer = activeSession.channel;
      consultation.communicationMode = activeSession.channel;
      consultation.updatedAt = now();
    }
    return {
      consultation: expandConsultation(db, consultation),
      session: activeSession,
      autoProvisioned: false
    };
  }

  const requestedChannel =
    normalizeCommunicationChannel(payload.channel) ||
    normalizeCommunicationChannel(consultation.requestedCommunicationMode) ||
    normalizeCommunicationChannel(consultation.communicationMode) ||
    consultation.communicationLayers?.[0] ||
    'voice_text';

  const session = openConsultationSession(db, user, consultation.id, {
    channel: requestedChannel,
    metadata: {
      source: 'ensure_active_communication_layer',
      ...(payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : {})
    }
  });

  return {
    consultation: expandConsultation(db, consultation),
    session,
    autoProvisioned: true
  };
}

export function switchConsultationCommunicationLayer(db, user, consultationId, payload = {}) {
  ensureCollections(db);
  const consultation = consultationByNumberOrId(db, consultationId);
  if (!consultation || !canViewConsultation(user, consultation)) {
    const error = new Error('Consultation not found.');
    error.status = 404;
    throw error;
  }

  if (consultation.status !== 'IN_PROGRESS') {
    const error = new Error('Communication layer can only be switched for in-progress consultations.');
    error.status = 422;
    throw error;
  }

  const canSwitch =
    ['admin', 'coordinator'].includes(user.role) ||
    consultation.assignedClinicianId === user.id ||
    (user.role === 'patient' && consultation.patientId === user.patientId);
  if (!canSwitch) {
    const error = new Error('You do not have permission to switch communication layers for this consultation.');
    error.status = 403;
    throw error;
  }

  const targetChannel =
    normalizeCommunicationChannel(payload.targetChannel || payload.channel) ||
    normalizeCommunicationChannel(consultation.requestedCommunicationMode) ||
    'voice_text';

  const allowed = consultation.communicationLayers?.length ? consultation.communicationLayers : COMMUNICATION_LAYERS;
  if (!allowed.includes(targetChannel)) {
    const error = new Error(`Requested communication layers allow: ${allowed.join(', ')}.`);
    error.status = 422;
    throw error;
  }

  const activeSession = db.consultationSessions.find(
    (item) => item.consultationId === consultation.id && item.status === 'active'
  );

  if (activeSession && activeSession.channel === targetChannel) {
    if (consultation.activeCommunicationLayer !== targetChannel) {
      consultation.activeCommunicationLayer = targetChannel;
      consultation.communicationMode = targetChannel;
      consultation.updatedAt = now();
    }
    return {
      consultation: expandConsultation(db, consultation),
      session: activeSession,
      switched: false
    };
  }

  const timestamp = now();
  const previousLayer =
    activeSession?.channel ||
    normalizeCommunicationChannel(consultation.activeCommunicationLayer) ||
    normalizeCommunicationChannel(consultation.communicationMode);

  if (activeSession) {
    activeSession.status = 'completed';
    activeSession.endedByUserId = user.id;
    activeSession.endReason = normalizeString(payload.reason, 100) || 'switched_communication_layer';
    activeSession.endedAt = timestamp;
    activeSession.updatedAt = timestamp;
  }

  const newSession = {
    id: makeId('consultation_session'),
    consultationId: consultation.id,
    channel: targetChannel,
    status: 'active',
    startedByUserId: user.id,
    endedByUserId: null,
    participantRoles: ['patient', 'clinician'],
    metadata: {
      source: 'switch_communication_layer',
      handoffFrom: previousLayer || null,
      ...(payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : {})
    },
    startedAt: timestamp,
    endedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp
  };
  if (['voice_call', 'video_call'].includes(targetChannel)) {
    newSession.callState = 'idle';
    newSession.callStateReason = null;
    newSession.callStateUpdatedAt = timestamp;
    newSession.callStateHistory = [];
  }

  db.consultationSessions.push(newSession);
  consultation.activeCommunicationLayer = targetChannel;
  consultation.communicationMode = targetChannel;
  consultation.updatedAt = timestamp;

  sendConsultationEventNotifications(db, consultation, {
    eventKey: 'consultation_communication_switched',
    audiences: ['patient', 'clinician', 'coordinator'],
    excludeActorId: user.id,
    subject: {
      default: 'Consultation communication switched'
    },
    body: {
      default: previousLayer && previousLayer !== targetChannel
        ? `${consultation.consultationNumber} switched from ${communicationLabel(previousLayer)} to ${communicationLabel(targetChannel)}.`
        : `${consultation.consultationNumber} started a ${communicationLabel(targetChannel)} session.`
    }
  });

  audit(db, user.id, 'switched_consultation_communication_layer', 'consultation', consultation.id, {
    sessionId: newSession.id,
    fromChannel: previousLayer || null,
    toChannel: targetChannel
  });

  return {
    consultation: expandConsultation(db, consultation),
    session: newSession,
    switched: true,
    previousLayer: previousLayer || null
  };
}

function normalizeMedicalRecordLimit(limit) {
  if (limit === undefined || limit === null || limit === '') return 50;
  const parsed = Number.parseInt(String(limit), 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 200) {
    const error = new Error('limit must be between 1 and 200.');
    error.status = 422;
    throw error;
  }
  return parsed;
}

function canViewConsultationPatientMedicalRecords(user, consultation) {
  if (!user || !consultation) return false;
  if (['admin', 'coordinator'].includes(user.role)) return true;
  if (user.role === 'patient' && consultation.patientId === user.patientId) return true;
  if (user.role === 'clinician' && consultation.assignedClinicianId === user.id) return true;
  return false;
}

function patientReferralDocuments(db, patientId) {
  const referrals = (db.referrals || []).filter((item) => item.patientId === patientId);
  const referralIds = new Set(referrals.map((item) => item.id));
  const referralNumberById = new Map(referrals.map((item) => [item.id, item.referralNumber || item.id]));
  return (db.documents || [])
    .filter((item) => referralIds.has(item.referralId))
    .slice()
    .sort((a, b) => toTimestamp(b.createdAt) - toTimestamp(a.createdAt))
    .map((item) => ({
      id: item.id,
      referralId: item.referralId,
      referralNumber: referralNumberById.get(item.referralId) || null,
      fileName: item.fileName || '',
      documentType: item.documentType || 'supporting',
      mimeType: item.mimeType || '',
      uploadedAt: item.createdAt || null,
      storageDisk: item.storageDisk || null
    }));
}

export function listConsultationPatientMedicalRecords(db, user, consultationId, options = {}) {
  ensureCollections(db);
  const consultation = consultationByNumberOrId(db, consultationId);
  if (!consultation) {
    const error = new Error('Consultation not found.');
    error.status = 404;
    throw error;
  }
  if (!canViewConsultationPatientMedicalRecords(user, consultation)) {
    const error = new Error('Only the assigned clinician, operations staff, or the patient can view these medical records.');
    error.status = 403;
    throw error;
  }

  const patient = db.patients.find((item) => item.id === consultation.patientId) || null;
  if (!patient) {
    const error = new Error('Patient record not found for this consultation.');
    error.status = 404;
    throw error;
  }

  const assignedClinician = consultation.assignedClinicianId
    ? db.users.find((item) => item.id === consultation.assignedClinicianId && item.role === 'clinician') || null
    : null;
  const limit = normalizeMedicalRecordLimit(options.limit);

  const persistedRecords = (db.medicalRecords || [])
    .filter((item) => item.patientId === patient.id)
    .map((item) => ({
      id: item.id,
      patientId: item.patientId,
      consultationId: item.consultationId || null,
      sourceSystem: item.sourceSystem || 'openemr_compatible',
      externalRecordId: item.externalRecordId || null,
      recordType: item.recordType || 'general',
      title: item.title || 'Clinical record',
      summary: item.summary || '',
      status: item.status || 'active',
      recordedAt: item.recordedAt || item.createdAt || item.updatedAt || null,
      updatedAt: item.updatedAt || item.recordedAt || item.createdAt || null,
      coding: item.coding && typeof item.coding === 'object' ? item.coding : null
    }));

  const consultationNotes = (db.consultationInteractions || [])
    .filter((item) => item.consultationId === consultation.id && item.interactionType === 'clinical_note')
    .filter((item) => normalizeString(item.message, 2000))
    .map((item) => ({
      id: `note_${item.id}`,
      patientId: patient.id,
      consultationId: consultation.id,
      sourceSystem: 'mindset_consultation',
      externalRecordId: item.id,
      recordType: 'clinical_note',
      title: 'Consultation clinical note',
      summary: item.message,
      status: 'active',
      recordedAt: item.createdAt || null,
      updatedAt: item.updatedAt || item.createdAt || null,
      coding: null
    }));

  const records = [...persistedRecords, ...consultationNotes]
    .sort((a, b) => toTimestamp(b.recordedAt || b.updatedAt) - toTimestamp(a.recordedAt || a.updatedAt))
    .slice(0, limit);

  return {
    consultationId: consultation.id,
    consultationNumber: consultation.consultationNumber,
    patient: {
      id: patient.id,
      userId: patient.userId || null,
      name: patient.name || '',
      email: patient.email || '',
      phone: patient.phone || '',
      city: patient.city || '',
      state: patient.state || '',
      country: patient.country || ''
    },
    assignedClinician: expandAssignedClinicianProfile(db, assignedClinician),
    records,
    linkedDocuments: patientReferralDocuments(db, patient.id).slice(0, 20),
    integration: {
      adapter: 'openemr-compatible',
      upstream: 'https://github.com/openemr/openemr'
    }
  };
}

export function listBiometricHooks(db, user, consultationId) {
  ensureCollections(db);
  const consultation = consultationByNumberOrId(db, consultationId);
  if (!consultation || !canViewConsultation(user, consultation)) {
    const error = new Error('Consultation not found.');
    error.status = 404;
    throw error;
  }
  return db.biometricVerifications.filter((item) => item.consultationId === consultation.id);
}

export function consultationOperationalSnapshot(db) {
  ensureCollections(db);
  const all = db.consultations;
  const nowMs = Date.now();
  const dayAgoMs = nowMs - 24 * 60 * 60 * 1000;
  const riskDistribution = all.reduce(
    (acc, consultation) => {
      const level = consultationRiskSummary(db, consultation).level;
      if (level === 'critical') acc.critical += 1;
      else if (level === 'warning') acc.warning += 1;
      else acc.stable += 1;
      return acc;
    },
    { critical: 0, warning: 0, stable: 0 }
  );
  const claimed = all.filter((item) => item.status !== 'REQUESTED');
  const elapsedClaimTimesMs = claimed
    .filter((item) => item.acceptedAt)
    .map((item) => new Date(item.acceptedAt).getTime() - new Date(item.createdAt).getTime())
    .filter((item) => Number.isFinite(item) && item >= 0);
  const averageClaimTimeSeconds = elapsedClaimTimesMs.length
    ? Math.round((elapsedClaimTimesMs.reduce((sum, ms) => sum + ms, 0) / elapsedClaimTimesMs.length / 1000) * 10) / 10
    : 0;
  const sortedClaimTimesMs = elapsedClaimTimesMs.slice().sort((a, b) => a - b);
  const medianClaimTimeSeconds = sortedClaimTimesMs.length
    ? Math.round((quantileFromSorted(sortedClaimTimesMs, 0.5) / 1000) * 10) / 10
    : 0;
  const p90ClaimTimeSeconds = sortedClaimTimesMs.length
    ? Math.round((quantileFromSorted(sortedClaimTimesMs, 0.9) / 1000) * 10) / 10
    : 0;

  const withinWindowCount = claimed.filter((item) => {
    if (!item.acceptedAt) return false;
    return new Date(item.acceptedAt).getTime() - new Date(item.createdAt).getTime() <= CLAIM_WINDOW_MS;
  }).length;

  const holdCaptured = db.payments.filter(
    (item) => item.consultationId && item.paymentType === 'consultation_hold' && item.status === 'captured'
  ).length;
  const holdReleased = db.payments.filter(
    (item) => item.consultationId && item.paymentType === 'consultation_hold' && item.status === 'released'
  ).length;
  const holdTotalResolved = holdCaptured + holdReleased;

  const interactionsLast24h = db.consultationInteractions.filter((item) => {
    const createdAtMs = new Date(item.createdAt).getTime();
    return Number.isFinite(createdAtMs) && createdAtMs >= dayAgoMs;
  });
  const interactionBreakdownLast24h = interactionsLast24h.reduce(
    (acc, item) => {
      if (item.interactionType === 'patient_message') acc.patientMessages += 1;
      else if (item.interactionType === 'clinician_message') acc.clinicianMessages += 1;
      else if (item.interactionType === 'session_marker') acc.sessionMarkers += 1;
      else if (item.interactionType === 'clinical_note') acc.clinicalNotes += 1;
      return acc;
    },
    { patientMessages: 0, clinicianMessages: 0, sessionMarkers: 0, clinicalNotes: 0 }
  );
  const activeSessions = db.consultationSessions.filter((item) => item.status === 'active').length;
  const interactionsPerActiveSessionLast24h = activeSessions
    ? Math.round((interactionsLast24h.length / activeSessions) * 10) / 10
    : 0;

  const callSessions = db.consultationSessions.filter((item) => ['voice_call', 'video_call'].includes(item.channel));
  const activeCallSessions = callSessions.filter((item) => item.status === 'active');
  const callStateCounts = {
    idle: 0,
    waiting_room: 0,
    provider_ready: 0,
    in_call: 0,
    ended: 0,
    failed: 0,
    unknown: 0
  };
  const activeCallStateCounts = {
    idle: 0,
    waiting_room: 0,
    provider_ready: 0,
    in_call: 0,
    ended: 0,
    failed: 0,
    unknown: 0
  };
  const waitingConsultationIds = new Set();
  const providerReadyConsultationIds = new Set();
  const inCallConsultationIds = new Set();
  let oldestWaitingRoomSeconds = 0;
  let oldestProviderReadySeconds = 0;

  for (const session of callSessions) {
    ensureSessionCallState(session);
    const state = String(session.callState || 'idle').toLowerCase();
    if (callStateCounts[state] !== undefined) callStateCounts[state] += 1;
    else callStateCounts.unknown += 1;
  }

  for (const session of activeCallSessions) {
    const state = String(session.callState || 'idle').toLowerCase();
    if (activeCallStateCounts[state] !== undefined) activeCallStateCounts[state] += 1;
    else activeCallStateCounts.unknown += 1;

    const stateAtMs = new Date(session.callStateUpdatedAt || session.updatedAt || session.startedAt || session.createdAt).getTime();
    const ageSeconds = Number.isFinite(stateAtMs)
      ? Math.max(0, Math.round((Date.now() - stateAtMs) / 1000))
      : 0;

    if (state === 'waiting_room') {
      waitingConsultationIds.add(session.consultationId);
      oldestWaitingRoomSeconds = Math.max(oldestWaitingRoomSeconds, ageSeconds);
    }
    if (state === 'provider_ready') {
      providerReadyConsultationIds.add(session.consultationId);
      oldestProviderReadySeconds = Math.max(oldestProviderReadySeconds, ageSeconds);
    }
    if (state === 'in_call') {
      inCallConsultationIds.add(session.consultationId);
    }
  }

  const waitingRoomPressureScore = Math.min(
    100,
    Math.round(
      activeCallStateCounts.waiting_room * 35 +
        activeCallStateCounts.provider_ready * 15 +
        Math.max(0, oldestWaitingRoomSeconds - 30) / 3
    )
  );
  const waitingRoomPressureLevel = waitingRoomPressureScore >= 70
    ? 'high'
    : waitingRoomPressureScore >= 35
      ? 'elevated'
      : 'low';
  const callReadinessPercent = activeCallSessions.length
    ? Math.round(((activeCallStateCounts.provider_ready + activeCallStateCounts.in_call) / activeCallSessions.length) * 1000) / 10
    : 0;

  return {
    totalConsultations: all.length,
    requested: all.filter((item) => item.status === 'REQUESTED').length,
    inProgress: all.filter((item) => item.status === 'IN_PROGRESS').length,
    completed: all.filter((item) => item.status === 'COMPLETED').length,
    cancelled: all.filter((item) => item.status === 'CANCELLED').length,
    acceptanceWindowSeconds: CLAIM_WINDOW_MS / 1000,
    averageClaimTimeSeconds,
    medianClaimTimeSeconds,
    p90ClaimTimeSeconds,
    claimFillRatePercent: all.length ? Math.round((withinWindowCount / all.length) * 1000) / 10 : 0,
    holdCaptured,
    holdReleased,
    holdReleaseRatePercent: holdTotalResolved
      ? Math.round((holdReleased / holdTotalResolved) * 1000) / 10
      : 0,
    riskDistribution,
    criticalRiskPercent: all.length ? Math.round((riskDistribution.critical / all.length) * 1000) / 10 : 0,
    interactionsLast24h: interactionsLast24h.length,
    interactionBreakdownLast24h,
    activeSessions,
    interactionsPerActiveSessionLast24h,
    totalCallSessions: callSessions.length,
    activeCallSessions: activeCallSessions.length,
    callStateCounts,
    activeCallStateCounts,
    consultationsWaitingRoomActive: waitingConsultationIds.size,
    consultationsProviderReadyActive: providerReadyConsultationIds.size,
    consultationsInCallActive: inCallConsultationIds.size,
    oldestWaitingRoomSeconds,
    oldestProviderReadySeconds,
    waitingRoomPressureScore,
    waitingRoomPressureLevel,
    callReadinessPercent
  };
}

export function consultationOperationalAlerts(db, options = {}) {
  ensureCollections(db);
  const nowMs = Date.now();
  const maxInProgressMinutes = Number.isFinite(Number(options.maxInProgressMinutes))
    ? Number(options.maxInProgressMinutes)
    : DEFAULT_IN_PROGRESS_SLA_MINUTES;
  const claimConflictThreshold = Number.isFinite(Number(options.claimConflictThreshold))
    ? Number(options.claimConflictThreshold)
    : DEFAULT_CLAIM_CONFLICT_THRESHOLD;
  const terminalHoldReconciliationGraceMinutes = Number.isFinite(Number(options.terminalHoldReconciliationGraceMinutes))
    ? Number(options.terminalHoldReconciliationGraceMinutes)
    : DEFAULT_TERMINAL_RECONCILIATION_GRACE_MINUTES;

  const requestedPastWindow = db.consultations.filter((consultation) => {
    if (consultation.status !== 'REQUESTED') return false;
    const endsAtMs = new Date(consultation.claimWindowEndsAt).getTime();
    return Number.isFinite(endsAtMs) && endsAtMs <= nowMs;
  }).length;

  const inProgressOverSla = db.consultations.filter((consultation) => {
    if (consultation.status !== 'IN_PROGRESS' || !consultation.startedAt) return false;
    const startedAtMs = new Date(consultation.startedAt).getTime();
    if (!Number.isFinite(startedAtMs)) return false;
    return (nowMs - startedAtMs) / 60000 > maxInProgressMinutes;
  }).length;

  const claimConflicts = db.consultationClaims.filter((item) => item.outcome === 'conflict').length;
  const claimIneligible = db.consultationClaims.filter((item) => item.outcome === 'ineligible').length;
  const dayAgoMs = nowMs - 24 * 60 * 60 * 1000;
  const claimConflictsLast24h = db.consultationClaims.filter((item) => {
    if (item.outcome !== 'conflict') return false;
    const eventMs = new Date(item.createdAt).getTime();
    return Number.isFinite(eventMs) && eventMs >= dayAgoMs;
  }).length;

  const completedWithoutCapturedHold = db.consultations.filter((consultation) => {
    if (consultation.status !== 'COMPLETED') return false;
    const hold = activeHoldPayment(db, consultation.id);
    return !hold || hold.status !== 'captured';
  }).length;

  const cancelledWithHeldHold = db.consultations.filter((consultation) => {
    if (consultation.status !== 'CANCELLED') return false;
    const hold = activeHoldPayment(db, consultation.id);
    return Boolean(hold && hold.status === 'held');
  }).length;

  const requestedWithoutHeldHold = db.consultations.filter((consultation) => {
    if (consultation.status !== 'REQUESTED') return false;
    const hold = activeHoldPayment(db, consultation.id);
    return !hold || hold.status !== 'held';
  }).length;

  const unreconciledTerminalHolds = db.payments.filter((payment) => {
    if (!payment.consultationId || payment.paymentType !== 'consultation_hold') return false;
    if (!['captured', 'released'].includes(payment.status)) return false;
    if (payment.reconciliationStatus === 'reconciled') return false;
    const terminalAtMs = new Date(payment.updatedAt || payment.paidAt || payment.releasedAt || payment.createdAt).getTime();
    if (!Number.isFinite(terminalAtMs)) return false;
    return (nowMs - terminalAtMs) / 60000 > terminalHoldReconciliationGraceMinutes;
  }).length;

  const alerts = [];
  const alertDetails = [];

  const addAlert = (code, severity, count, message) => {
    if (count <= 0) return;
    alerts.push(code);
    alertDetails.push({
      code,
      severity,
      count,
      message,
      remediation: ALERT_REMEDIATION_HINTS[code] || 'Review operational logs and resolve the underlying workflow inconsistency.'
    });
  };

  addAlert('consultations_stuck_requested', 'warning', requestedPastWindow, 'Requested consultations are past claim window and still open.');
  addAlert('consultations_stuck_in_progress', 'critical', inProgressOverSla, 'In-progress consultations exceeded configured SLA duration.');
  addAlert('high_claim_conflict_rate', 'warning', claimConflicts > claimConflictThreshold ? claimConflicts : 0, 'Claim conflict attempts exceeded threshold.');
  addAlert('completed_without_captured_hold', 'critical', completedWithoutCapturedHold, 'Completed consultations are missing captured hold payments.');
  addAlert('cancelled_with_held_hold', 'critical', cancelledWithHeldHold, 'Cancelled consultations still have held payment status.');
  addAlert('requested_without_held_hold', 'critical', requestedWithoutHeldHold, 'Requested consultations are missing held payment records.');
  addAlert('terminal_hold_unreconciled', 'warning', unreconciledTerminalHolds, 'Terminal hold payments remain unreconciled beyond grace period.');

  const highestSeverity = alertDetails.some((item) => item.severity === 'critical')
    ? 'critical'
    : alertDetails.some((item) => item.severity === 'warning')
      ? 'warning'
      : 'ok';

  return {
    status: alerts.length ? 'warning' : 'ok',
    highestSeverity,
    thresholds: {
      maxInProgressMinutes,
      claimConflictThreshold,
      terminalHoldReconciliationGraceMinutes
    },
    stuck: {
      requestedPastWindow,
      inProgressOverSla
    },
    claims: {
      conflicts: claimConflicts,
      ineligible: claimIneligible,
      conflictsLast24h: claimConflictsLast24h
    },
    payments: {
      completedWithoutCapturedHold,
      cancelledWithHeldHold,
      requestedWithoutHeldHold,
      unreconciledTerminalHolds
    },
    alerts,
    alertDetails
  };
}

export function listConsultationClaims(db, user, consultationId) {
  ensureCollections(db);
  const consultation = consultationByNumberOrId(db, consultationId);
  if (!consultation || !canViewConsultation(user, consultation)) {
    const error = new Error('Consultation not found.');
    error.status = 404;
    throw error;
  }
  return db.consultationClaims.filter((item) => item.consultationId === consultation.id);
}

export function listConsultationEvents(db, user, consultationId) {
  return listConsultationEventsWithOptions(db, user, consultationId, {});
}

export function listConsultationEventsWithOptions(db, user, consultationId, options = {}) {
  ensureCollections(db);
  const consultation = consultationByNumberOrId(db, consultationId);
  if (!consultation || !canViewConsultation(user, consultation)) {
    const error = new Error('Consultation not found.');
    error.status = 404;
    throw error;
  }

  const rawKind = normalizeString(options.kind || '', 50).toLowerCase();
  const kind = rawKind ? rawKind.replace(/[\s-]+/g, '_') : '';
  if (kind && !CONSULTATION_EVENT_KINDS.includes(kind)) {
    const error = new Error(`kind must be one of: ${CONSULTATION_EVENT_KINDS.join(', ')}.`);
    error.status = 422;
    throw error;
  }

  const numericLimit = Number(options.limit);
  const limit = Number.isFinite(numericLimit) && numericLimit > 0 ? Math.min(Math.floor(numericLimit), 200) : null;

  let events = buildConsultationEventLog(db, consultation);
  if (kind) {
    events = events.filter((item) => item.kind === kind);
  }
  if (limit !== null) {
    events = events.slice(0, limit);
  }
  return events;
}

export function ensureConsultationCollections(db) {
  ensureCollections(db);
}
