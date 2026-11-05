export const INTERACTION_PRESET_KEY = 'mindset_interaction_preset';

export const interactionPresetCatalog = {
  triage_live: {
    label: 'Live triage monitoring',
    filters: { type: 'all', actorRole: 'all', limit: '100' },
    draftType: 'clinical_note'
  },
  patient_updates: {
    label: 'Patient updates only',
    filters: { type: 'patient_message', actorRole: 'patient', limit: '100' },
    draftType: 'patient_message'
  },
  clinician_notes: {
    label: 'Clinician notes and messages',
    filters: { type: 'clinician_message', actorRole: 'clinician', limit: '100' },
    draftType: 'clinician_message'
  },
  call_markers: {
    label: 'Voice/Video marker timeline',
    filters: { type: 'session_marker', actorRole: 'all', limit: '200' },
    draftType: 'session_marker',
    marker: 'connected'
  },
  audit_notes: {
    label: 'Audit notes only',
    filters: { type: 'clinical_note', actorRole: 'coordinator', limit: '200' },
    draftType: 'clinical_note'
  }
};

export function interactionPresetsForRole(role) {
  const presetKeys = ['triage_live', 'patient_updates', 'clinician_notes', 'call_markers'];
  if (role === 'coordinator' || role === 'admin') {
    presetKeys.push('audit_notes');
  }
  return presetKeys;
}

export function interactionTypesForChannel(channel) {
  if (channel === 'voice_text') return ['patient_message', 'clinician_message', 'clinical_note'];
  if (channel === 'voice_call' || channel === 'video_call') return ['session_marker', 'clinical_note'];
  return ['clinical_note'];
}

export function normalizeInteractionTypeClient(value) {
  const raw = String(value || '').toLowerCase().trim().replace(/[\s-]+/g, '_');
  const aliases = {
    patient: 'patient_message',
    patient_text: 'patient_message',
    clinician: 'clinician_message',
    clinician_text: 'clinician_message',
    note: 'clinical_note',
    clinical: 'clinical_note',
    marker: 'session_marker',
    session: 'session_marker'
  };
  return aliases[raw] || raw;
}

export function inferInteractionTypeClient(session, user, message, marker, requestedType) {
  const normalizedRequested = normalizeInteractionTypeClient(requestedType);
  const allowed = interactionTypesForChannel(session?.channel);
  if (allowed.includes(normalizedRequested)) {
    return normalizedRequested;
  }

  if (session?.channel === 'voice_text' && String(message || '').trim()) {
    return user?.role === 'patient' ? 'patient_message' : 'clinician_message';
  }
  if ((session?.channel === 'voice_call' || session?.channel === 'video_call') && String(marker || '').trim()) {
    return 'session_marker';
  }
  return 'clinical_note';
}

export function validateInteractionPayloadClient(type, message, marker) {
  const normalizedType = normalizeInteractionTypeClient(type);
  const normalizedMessage = String(message || '').trim();
  const normalizedMarker = String(marker || '').trim();

  if (normalizedType === 'session_marker' && !normalizedMarker) {
    return 'Select a session marker before submitting marker events.';
  }

  if (['patient_message', 'clinician_message', 'clinical_note'].includes(normalizedType) && !normalizedMessage) {
    return 'Message is required for patient, clinician, and clinical note interactions.';
  }

  return null;
}

export function isMessageRequiredInteractionType(type) {
  const normalizedType = normalizeInteractionTypeClient(type);
  return ['patient_message', 'clinician_message', 'clinical_note'].includes(normalizedType);
}
