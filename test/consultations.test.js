import assert from 'node:assert/strict';
import test from 'node:test';

import { seedDatabase } from '../src/domain.js';
import {
  cancelConsultation,
  claimConsultation,
  closeConsultationSession,
  completeConsultation,
  consultationOperationalSnapshot,
  consultationOperationalAlerts,
  createConsultation,
  authorizeConsultationCallSignal,
  consultationWorkspaceOverview,
  ensureActiveCommunicationLayer,
  escalateConsultationTier,
  listConsultations,
  listConsultationEvents,
  listConsultationEventsWithOptions,
  listConsultationInteractions,
  listConsultationInteractionsWithOptions,
  listConsultationPatientMedicalRecords,
  listConsultationsWithOptions,
  openConsultationSession,
  recordConsultationInteraction,
  recordConsultationCallAuditEvent,
  recordBiometricHook,
  startConsultation,
  switchConsultationCommunicationLayer,
  transitionConsultationCallSessionState,
  triggerClaimWindowSweep
} from '../src/services/consultations.js';
import {
  accountUseCases,
  changeOwnPassword,
  getOwnNotificationInbox,
  getOwnNotificationPreferences,
  getOwnNotificationSummary,
  markOwnNotificationsRead,
  updateOwnNotificationPreferences,
  updateOwnProfile
} from '../src/services/accounts.js';

function getUser(db, role) {
  const user = db.users.find((item) => item.role === role);
  assert.ok(user, `expected ${role} user in seed`);
  return user;
}

test('consultation request creates a payment hold and starts in REQUESTED', () => {
  const db = seedDatabase();
  const patient = getUser(db, 'patient');

  const consultation = createConsultation(db, patient, {
    tier: 'priority',
    requestedNeed: 'Recurring chest pain and anxiety concerns',
    paymentMethod: 'card'
  });

  assert.equal(consultation.status, 'REQUESTED');
  assert.equal(consultation.tier, 'priority');
  assert.equal(consultation.holdPayment.status, 'held');
  assert.equal(consultation.holdPayment.amount, 5000);
});

test('consultation workspace overview returns consultations with snapshot and timestamp', () => {
  const db = seedDatabase();
  const patient = getUser(db, 'patient');
  const coordinator = getUser(db, 'coordinator');

  createConsultation(db, patient, {
    requestedNeed: 'Workspace overview contract test',
    tier: 'priority'
  });

  const overview = consultationWorkspaceOverview(db, coordinator, { sort: 'risk_score' });
  assert.ok(Array.isArray(overview.consultations));
  assert.ok(overview.consultations.length >= 1);
  assert.ok(typeof overview.generatedAt === 'string');
  assert.ok(overview.snapshot);
  assert.ok(overview.appliedFilters);
  assert.equal(overview.appliedFilters.sort, 'risk_score');
  assert.equal(overview.appliedFilters.status, 'all');
  assert.equal(overview.appliedFilters.tier, 'all');
  assert.equal(overview.appliedFilters.search, '');
  assert.ok(overview.meta);
  assert.equal(typeof overview.meta.visibleCount, 'number');
  assert.equal(typeof overview.meta.totalCount, 'number');
  assert.ok(overview.meta.totalCount >= overview.meta.visibleCount);
  assert.ok(typeof overview.snapshot.requested === 'number');
  assert.ok(typeof overview.snapshot.interactionsLast24h === 'number');
  assert.ok(overview.snapshot.alerts);
  assert.ok(Array.isArray(overview.snapshot.alerts.alerts));
});
test('first clinician claim wins and second attempt conflicts', () => {
  const db = seedDatabase();
  const patient = getUser(db, 'patient');
  const clinician = getUser(db, 'clinician');
  const secondClinician = {
    ...clinician,
    id: 'user_second',
    email: 'second-clinician@mindset.local'
  };

  const consultation = createConsultation(db, patient, {
    tier: 'normal',
    requestedNeed: 'General non-urgent check-in'
  });

  const claimed = claimConsultation(db, clinician, consultation.id);
  assert.equal(claimed.status, 'DOCTOR_ACCEPTED');
  assert.equal(claimed.assignedClinicianId, clinician.id);

  assert.throws(() => claimConsultation(db, secondClinician, consultation.id), /already claimed|no longer claimable/);
});

test('patient consultation view includes claimed clinician details', () => {
  const db = seedDatabase();
  const patient = getUser(db, 'patient');
  const clinician = getUser(db, 'clinician');

  const consultation = createConsultation(db, patient, {
    tier: 'priority',
    requestedNeed: 'Need assigned doctor profile visibility'
  });
  claimConsultation(db, clinician, consultation.id);

  const visible = listConsultations(db, patient).find((item) => item.id === consultation.id);
  assert.ok(visible?.assignedClinician);
  assert.equal(visible.assignedClinician.fullName, 'Demo Clinician');
  assert.equal(visible.assignedClinician.provider?.name, 'Lagoon Specialist Hospital');
  assert.ok(Array.isArray(visible.assignedClinician.specialties));
});

test('assigned clinician can access patient medical records while non-assigned clinicians are blocked', () => {
  const db = seedDatabase();
  const patient = getUser(db, 'patient');
  const clinician = getUser(db, 'clinician');

  const consultation = createConsultation(db, patient, {
    tier: 'priority',
    requestedNeed: 'Medical records access validation'
  });
  claimConsultation(db, clinician, consultation.id);

  db.referrals.push({
    id: 'ref_med_1',
    referralNumber: 'REF-TEST-MED-0001',
    patientId: patient.patientId,
    specialtyId: db.specialties[0].id,
    procedureId: db.procedures[0].id,
    status: 'submitted',
    assignedProviderId: null,
    createdAt: '2026-01-01T10:00:00.000Z',
    updatedAt: '2026-01-01T10:00:00.000Z'
  });
  db.documents.push({
    id: 'doc_med_1',
    referralId: 'ref_med_1',
    documentType: 'supporting',
    fileName: 'ecg-summary.pdf',
    mimeType: 'application/pdf',
    storageDisk: 'private-local',
    createdAt: '2026-01-01T10:05:00.000Z',
    updatedAt: '2026-01-01T10:05:00.000Z'
  });

  const records = listConsultationPatientMedicalRecords(db, clinician, consultation.id, { limit: '20' });
  assert.equal(records.patient.id, patient.patientId);
  assert.ok(records.records.length >= 1);
  assert.ok(records.linkedDocuments.some((item) => item.id === 'doc_med_1'));

  const nonAssignedClinician = {
    ...clinician,
    id: 'user_not_assigned',
    email: 'other-clinician@mindset.local'
  };
  assert.throws(
    () => listConsultationPatientMedicalRecords(db, nonAssignedClinician, consultation.id),
    /assigned clinician, operations staff, or the patient/
  );
});

test('in-progress consultation can escalate tier and capture hold on completion', () => {
  const db = seedDatabase();
  const patient = getUser(db, 'patient');
  const clinician = getUser(db, 'clinician');

  const consultation = createConsultation(db, patient, {
    tier: 'normal',
    requestedNeed: 'Needs follow-up after blood pressure spike'
  });

  claimConsultation(db, clinician, consultation.id);
  startConsultation(db, clinician, consultation.id);
  const escalated = escalateConsultationTier(db, clinician, consultation.id, {
    toTier: 'super_priority',
    reason: 'Video assessment required for complex presentation'
  });

  assert.equal(escalated.tier, 'super_priority');
  assert.equal(escalated.holdPayment.amount, 10000);

  const completed = completeConsultation(db, clinician, consultation.id);
  assert.equal(completed.status, 'COMPLETED');
  assert.equal(completed.holdPayment.status, 'captured');
});

test('claim window sweep cancels stale requests and releases hold', () => {
  const db = seedDatabase();
  const patient = getUser(db, 'patient');
  const coordinator = getUser(db, 'coordinator');

  const consultation = createConsultation(db, patient, {
    tier: 'normal',
    requestedNeed: 'Stale request for sweep validation'
  });
  const row = db.consultations.find((item) => item.id === consultation.id);
  row.claimWindowEndsAt = new Date(Date.now() - 1000).toISOString();

  const result = triggerClaimWindowSweep(db, coordinator.id);
  assert.equal(result.released, 1);

  const updated = listConsultations(db, coordinator).find((item) => item.id === consultation.id);
  assert.equal(updated.status, 'CANCELLED');
  assert.equal(updated.holdPayment.status, 'released');
});

test('manual cancellation releases hold without duplicating status history', () => {
  const db = seedDatabase();
  const patient = getUser(db, 'patient');

  const consultation = createConsultation(db, patient, {
    tier: 'normal',
    requestedNeed: 'Cancel flow verification'
  });
  const cancelled = cancelConsultation(db, patient, consultation.id, { reason: 'No longer needed' });

  assert.equal(cancelled.status, 'CANCELLED');
  assert.equal(cancelled.holdPayment.status, 'released');
  assert.equal(cancelled.statusHistory.filter((item) => item.toStatus === 'CANCELLED').length, 1);
});

test('consultation cannot start before doctor acceptance', () => {
  const db = seedDatabase();
  const patient = getUser(db, 'patient');
  const coordinator = getUser(db, 'coordinator');

  const consultation = createConsultation(db, patient, {
    tier: 'normal',
    requestedNeed: 'Pre-start guard validation'
  });

  assert.throws(() => startConsultation(db, coordinator, consultation.id), /doctor-accepted/);
});

test('consultation cannot complete before in-progress state', () => {
  const db = seedDatabase();
  const patient = getUser(db, 'patient');
  const clinician = getUser(db, 'clinician');

  const consultation = createConsultation(db, patient, {
    tier: 'priority',
    requestedNeed: 'Pre-complete guard validation'
  });
  claimConsultation(db, clinician, consultation.id);

  assert.throws(() => completeConsultation(db, clinician, consultation.id), /in progress/);
});

test('only assigned clinician or operations staff can write biometric hooks', () => {
  const db = seedDatabase();
  const patient = getUser(db, 'patient');
  const clinician = getUser(db, 'clinician');

  const consultation = createConsultation(db, patient, {
    tier: 'normal',
    requestedNeed: 'Biometric authorization validation'
  });
  claimConsultation(db, clinician, consultation.id);

  assert.throws(
    () => recordBiometricHook(db, patient, consultation.id, { method: 'face', status: 'captured' }),
    /assigned clinician or operations staff/
  );

  const hook = recordBiometricHook(db, clinician, consultation.id, { method: 'face', status: 'captured' });
  assert.equal(hook.method, 'face');
});

test('account profile updates and password rotation work for the signed-in user', () => {
  const db = seedDatabase();
  const patient = getUser(db, 'patient');

  const profile = updateOwnProfile(db, patient.id, {
    firstName: 'Updated',
    lastName: 'Patient',
    city: 'Abuja',
    state: 'FCT'
  });

  assert.equal(profile.firstName, 'Updated');
  const dashboard = accountUseCases(db, patient);
  assert.ok(dashboard.allowedActions.includes('update_profile'));

  const changed = changeOwnPassword(db, patient.id, {
    currentPassword: 'password',
    newPassword: 'new-password-123'
  });
  assert.equal(changed.ok, true);
});

test('profile update rejects malformed emails', () => {
  const db = seedDatabase();
  const patient = getUser(db, 'patient');

  assert.throws(() => updateOwnProfile(db, patient.id, { email: 'not-an-email' }), /valid email address/);
});

test('account notification preferences can be read and updated with validation', () => {
  const db = seedDatabase();
  const patient = getUser(db, 'patient');

  const current = getOwnNotificationPreferences(db, patient.id);
  assert.deepEqual(current.consultations.preferredChannels, ['sms', 'email']);
  assert.equal(current.consultations.emailCopyEnabled, true);

  const updated = updateOwnNotificationPreferences(db, patient.id, {
    consultations: { preferredChannels: ['in_app', 'email'], emailCopyEnabled: false }
  });
  assert.deepEqual(updated.consultations.preferredChannels, ['in_app', 'email']);
  assert.equal(updated.consultations.emailCopyEnabled, false);

  assert.throws(
    () => updateOwnNotificationPreferences(db, patient.id, { consultations: { preferredChannels: ['pager'] } }),
    /Unsupported notification channel/
  );
  assert.throws(
    () => updateOwnNotificationPreferences(db, patient.id, { consultations: { preferredChannels: [] } }),
    /At least one preferred notification channel/
  );
  assert.throws(
    () => updateOwnNotificationPreferences(db, patient.id, { consultations: { preferredChannels: ['email'], emailCopyEnabled: 'yes' } }),
    /emailCopyEnabled must be a boolean/
  );
});

test('account notification inbox lists user-scoped events and supports read actions', () => {
  const db = seedDatabase();
  const patient = getUser(db, 'patient');
  const clinician = getUser(db, 'clinician');

  db.notificationLogs.push(
    {
      id: 'notification_old_unread',
      referralId: null,
      consultationId: 'consult_alpha',
      userId: patient.id,
      channel: 'in_app',
      notificationType: 'communication',
      severity: 'warning',
      eventKey: 'consultation_call_waiting_room',
      recipient: `user:${patient.id}`,
      subject: 'Waiting room update',
      body: 'Provider is waiting in room.',
      status: 'sent',
      createdAt: '2026-01-01T10:00:00.000Z',
      sentAt: '2026-01-01T10:00:00.000Z',
      updatedAt: '2026-01-01T10:00:00.000Z'
    },
    {
      id: 'notification_new_unread',
      referralId: null,
      consultationId: 'consult_beta',
      userId: patient.id,
      channel: 'sms',
      notificationType: 'consultation',
      severity: 'critical',
      eventKey: 'consultation_claim_window_expired',
      recipient: '+2347000000000',
      subject: 'Consultation started',
      body: 'Your consultation is now in progress.',
      status: 'sent',
      createdAt: '2026-01-01T11:00:00.000Z',
      sentAt: '2026-01-01T11:00:00.000Z',
      updatedAt: '2026-01-01T11:00:00.000Z'
    },
    {
      id: 'notification_read',
      referralId: null,
      consultationId: 'consult_gamma',
      userId: patient.id,
      channel: 'email',
      notificationType: 'consultation',
      severity: 'info',
      eventKey: 'consultation_completed',
      recipient: 'patient@mindset.local',
      subject: 'Call ended',
      body: 'Your call ended successfully.',
      status: 'sent',
      readAt: '2026-01-01T11:30:00.000Z',
      createdAt: '2026-01-01T11:20:00.000Z',
      sentAt: '2026-01-01T11:20:00.000Z',
      updatedAt: '2026-01-01T11:30:00.000Z'
    },
    {
      id: 'notification_other_user',
      referralId: null,
      consultationId: 'consult_other',
      userId: clinician.id,
      channel: 'in_app',
      recipient: `user:${clinician.id}`,
      subject: 'Clinician only',
      body: 'Not visible to patient inbox.',
      status: 'sent',
      createdAt: '2026-01-01T12:00:00.000Z',
      sentAt: '2026-01-01T12:00:00.000Z',
      updatedAt: '2026-01-01T12:00:00.000Z'
    }
  );

  const inbox = getOwnNotificationInbox(db, patient.id, { limit: '10' });
  assert.equal(inbox.meta.totalCount, 3);
  assert.equal(inbox.meta.unreadCount, 2);
  assert.equal(inbox.meta.visibleUnreadCount, 2);
  assert.equal(inbox.items[0].id, 'notification_read');
  assert.equal(inbox.meta.visibleBySeverity.critical, 1);
  assert.equal(inbox.meta.visibleBySeverity.warning, 1);
  assert.equal(inbox.meta.visibleByType.communication, 1);
  assert.equal(inbox.meta.visibleByType.consultation, 2);

  const summaryBefore = getOwnNotificationSummary(db, patient.id);
  assert.equal(summaryBefore.totalCount, 3);
  assert.equal(summaryBefore.unreadCount, 2);
  assert.equal(summaryBefore.hasUnread, true);
  assert.equal(summaryBefore.latestCreatedAt, '2026-01-01T11:20:00.000Z');
  assert.equal(summaryBefore.latestUnreadCreatedAt, '2026-01-01T11:00:00.000Z');
  assert.equal(summaryBefore.unreadBySeverity.critical, 1);
  assert.equal(summaryBefore.unreadBySeverity.warning, 1);
  assert.equal(summaryBefore.unreadBySeverity.info, 0);

  const unreadOnly = getOwnNotificationInbox(db, patient.id, { unreadOnly: true, channel: 'all', limit: '10' });
  assert.equal(unreadOnly.items.length, 2);
  assert.ok(unreadOnly.items.every((item) => !item.readAt));

  const criticalOnly = getOwnNotificationInbox(db, patient.id, {
    unreadOnly: true,
    channel: 'all',
    severity: 'critical',
    type: 'consultation',
    limit: '10'
  });
  assert.equal(criticalOnly.items.length, 1);
  assert.equal(criticalOnly.items[0].id, 'notification_new_unread');

  const filteredRead = markOwnNotificationsRead(db, patient.id, {
    markFiltered: true,
    filters: {
      channel: 'all',
      type: 'communication',
      severity: 'warning',
      unreadOnly: true
    }
  });
  assert.equal(filteredRead.updatedCount, 1);
  assert.equal(filteredRead.unreadCount, 1);
  assert.equal(filteredRead.appliedFilters.type, 'communication');

  const singleRead = markOwnNotificationsRead(db, patient.id, { notificationId: 'notification_new_unread' });
  assert.equal(singleRead.updatedCount, 1);
  assert.equal(singleRead.unreadCount, 0);

  const markAll = markOwnNotificationsRead(db, patient.id, { markAll: true });
  assert.equal(markAll.updatedCount, 0);
  assert.equal(markAll.unreadCount, 0);

  const summaryAfter = getOwnNotificationSummary(db, patient.id);
  assert.equal(summaryAfter.unreadCount, 0);
  assert.equal(summaryAfter.hasUnread, false);
  assert.equal(summaryAfter.latestUnreadCreatedAt, null);
  assert.equal(summaryAfter.unreadBySeverity.critical, 0);
  assert.equal(summaryAfter.unreadBySeverity.warning, 0);

  assert.throws(
    () => markOwnNotificationsRead(db, patient.id, {}),
    /Provide notificationId, notificationIds, markFiltered=true, or markAll=true/
  );
  assert.throws(
    () => getOwnNotificationInbox(db, patient.id, { channel: 'pager' }),
    /Unsupported notification channel filter/
  );
  assert.throws(
    () => getOwnNotificationInbox(db, patient.id, { type: 'pager' }),
    /Unsupported notification type filter/
  );
  assert.throws(
    () => getOwnNotificationInbox(db, patient.id, { severity: 'urgent' }),
    /Unsupported notification severity filter/
  );
});

test('consultation sessions follow requested communication layers and enforce active-session exclusivity', () => {
  const db = seedDatabase();
  const patient = getUser(db, 'patient');
  const clinician = getUser(db, 'clinician');

  const consultation = createConsultation(db, patient, {
    tier: 'super_priority',
    requestedNeed: 'High urgency video consultation',
    requestedCommunicationMode: 'video_call'
  });

  claimConsultation(db, clinician, consultation.id);
  startConsultation(db, clinician, consultation.id);

  const opened = openConsultationSession(db, clinician, consultation.id, { channel: 'voice_call' });
  assert.equal(opened.status, 'active');
  assert.equal(opened.channel, 'voice_call');

  const row = db.consultations.find((item) => item.id === consultation.id);
  assert.equal(row.activeCommunicationLayer, 'voice_call');

  assert.throws(
    () => openConsultationSession(db, clinician, consultation.id, { channel: 'video_call' }),
    /already exists/
  );

  const closed = closeConsultationSession(db, clinician, consultation.id, opened.id, { reason: 'done' });
  assert.equal(closed.status, 'completed');
});

test('consultation cancel and session close require explicit reasons', () => {
  const db = seedDatabase();
  const patient = getUser(db, 'patient');
  const clinician = getUser(db, 'clinician');

  const cancellation = createConsultation(db, patient, {
    tier: 'normal',
    requestedNeed: 'Cancellation reason validation'
  });

  assert.throws(
    () => cancelConsultation(db, patient, cancellation.id, { reason: '   ' }),
    /Cancellation reason is required/
  );

  const sessionConsultation = createConsultation(db, patient, {
    tier: 'priority',
    requestedNeed: 'Session close reason validation'
  });
  claimConsultation(db, clinician, sessionConsultation.id);
  startConsultation(db, clinician, sessionConsultation.id);
  const session = openConsultationSession(db, clinician, sessionConsultation.id, { channel: 'voice_call' });

  assert.throws(
    () => closeConsultationSession(db, clinician, sessionConsultation.id, session.id, { reason: '' }),
    /Session close reason is required/
  );
});

test('consultation uses patient-requested communication layers after clinician claim', () => {
  const db = seedDatabase();
  const patient = getUser(db, 'patient');
  const clinician = getUser(db, 'clinician');

  const consultation = createConsultation(db, patient, {
    tier: 'normal',
    requestedNeed: 'I need a video layer if possible for better context',
    requestedCommunicationMode: 'video_call'
  });

  assert.equal(consultation.requestedCommunicationMode, 'video_call');
  assert.equal(consultation.communicationLayers[0], 'video_call');

  claimConsultation(db, clinician, consultation.id);
  startConsultation(db, clinician, consultation.id);

  const opened = openConsultationSession(db, clinician, consultation.id, { channel: 'video_call' });
  assert.equal(opened.channel, 'video_call');

  const row = db.consultations.find((item) => item.id === consultation.id);
  assert.equal(row.activeCommunicationLayer, 'video_call');
  assert.equal(row.communicationMode, 'video_call');
});

test('consultation communication plan keeps patient-preferred layer first with all three layers available', () => {
  const db = seedDatabase();
  const patient = getUser(db, 'patient');

  const consultation = createConsultation(db, patient, {
    tier: 'priority',
    requestedNeed: 'Prefer voice call but keep alternatives ready',
    requestedCommunicationMode: 'voice_call'
  });

  assert.deepEqual(consultation.communicationLayers, ['voice_call', 'voice_text', 'video_call']);
});

test('consultation normalizes requested communication values from display labels', () => {
  const db = seedDatabase();
  const patient = getUser(db, 'patient');
  const clinician = getUser(db, 'clinician');

  const consultation = createConsultation(db, patient, {
    tier: 'normal',
    requestedNeed: 'Patient entered label format',
    requestedCommunicationMode: 'Voice call'
  });

  claimConsultation(db, clinician, consultation.id);
  startConsultation(db, clinician, consultation.id);
  const session = openConsultationSession(db, clinician, consultation.id);
  assert.equal(session.channel, 'voice_call');
});

test('consultation lifecycle emits patient notifications for start, escalation, completion and timeout cancellation', () => {
  const db = seedDatabase();
  const patient = getUser(db, 'patient');
  const clinician = getUser(db, 'clinician');
  const coordinator = getUser(db, 'coordinator');

  const consultation = createConsultation(db, patient, {
    tier: 'normal',
    requestedNeed: 'Lifecycle notification coverage check'
  });

  claimConsultation(db, clinician, consultation.id);
  startConsultation(db, clinician, consultation.id);
  escalateConsultationTier(db, clinician, consultation.id, {
    toTier: 'priority',
    reason: 'Needs voice call support'
  });
  completeConsultation(db, clinician, consultation.id);

  const stale = createConsultation(db, patient, {
    tier: 'normal',
    requestedNeed: 'Timeout cancellation notification check'
  });
  const staleRow = db.consultations.find((item) => item.id === stale.id);
  staleRow.claimWindowEndsAt = new Date(Date.now() - 1000).toISOString();
  triggerClaimWindowSweep(db, coordinator.id);

  const subjects = db.notificationLogs
    .filter((item) => item.consultationId === consultation.id || item.consultationId === stale.id)
    .map((item) => item.subject);

  assert.ok(subjects.includes('Consultation started'));
  assert.ok(subjects.includes('Consultation tier updated'));
  assert.ok(subjects.includes('Consultation completed'));
  assert.ok(subjects.includes('Consultation cancelled'));
});

test('consultation session notifications include open, switch and close states', () => {
  const db = seedDatabase();
  const patient = getUser(db, 'patient');
  const clinician = getUser(db, 'clinician');

  const consultation = createConsultation(db, patient, {
    tier: 'priority',
    requestedNeed: 'Session state notification coverage check',
    requestedCommunicationMode: 'voice_call'
  });

  claimConsultation(db, clinician, consultation.id);
  startConsultation(db, clinician, consultation.id);

  const firstSession = openConsultationSession(db, clinician, consultation.id, { channel: 'voice_call' });
  const firstClosed = closeConsultationSession(db, clinician, consultation.id, firstSession.id, { reason: 'switch_channel' });
  assert.equal(firstClosed.status, 'completed');

  const secondSession = openConsultationSession(db, clinician, consultation.id, { channel: 'video_call' });
  const secondClosed = closeConsultationSession(db, clinician, consultation.id, secondSession.id, { reason: 'finished' });
  assert.equal(secondClosed.status, 'completed');

  const row = db.consultations.find((item) => item.id === consultation.id);
  assert.equal(row.activeCommunicationLayer, null);

  const subjects = db.notificationLogs
    .filter((item) => item.consultationId === consultation.id)
    .map((item) => item.subject);

  assert.ok(subjects.includes('Consultation communication opened'));
  assert.ok(subjects.includes('Consultation communication switched'));
  assert.ok(subjects.includes('Consultation communication closed'));
});

test('call-state transitions support waiting_room and provider_ready with multi-channel notifications', () => {
  const db = seedDatabase();
  const patient = getUser(db, 'patient');
  const clinician = getUser(db, 'clinician');

  const consultation = createConsultation(db, patient, {
    tier: 'priority',
    requestedNeed: 'Call-state transition coverage',
    requestedCommunicationMode: 'voice_call'
  });

  claimConsultation(db, clinician, consultation.id);
  startConsultation(db, clinician, consultation.id);
  const session = openConsultationSession(db, clinician, consultation.id, { channel: 'voice_call' });

  const waiting = transitionConsultationCallSessionState(db, clinician, consultation.id, session.id, {
    state: 'waiting_room',
    reason: 'provider_joined_first'
  });
  assert.equal(waiting.state, 'waiting_room');

  const ready = transitionConsultationCallSessionState(db, clinician, consultation.id, session.id, {
    state: 'provider_ready',
    reason: 'provider_confirmed_ready'
  });
  assert.equal(ready.state, 'provider_ready');

  const refreshed = db.consultationSessions.find((item) => item.id === session.id);
  assert.equal(refreshed.callState, 'provider_ready');
  assert.ok(Array.isArray(refreshed.callStateHistory));
  assert.equal(refreshed.callStateHistory.length >= 2, true);

  const waitingNotifications = db.notificationLogs.filter(
    (item) =>
      item.consultationId === consultation.id &&
      item.subject === 'Consultation call waiting room update'
  );
  const providerReadyNotifications = db.notificationLogs.filter(
    (item) =>
      item.consultationId === consultation.id &&
      item.subject === 'Consultation provider is ready'
  );

  assert.ok(waitingNotifications.some((item) => item.channel === 'in_app'));
  assert.ok(waitingNotifications.some((item) => item.channel === 'sms'));
  assert.ok(waitingNotifications.some((item) => item.channel === 'email'));
  assert.ok(providerReadyNotifications.some((item) => item.channel === 'in_app'));
  assert.ok(providerReadyNotifications.some((item) => item.channel === 'sms'));
  assert.ok(providerReadyNotifications.some((item) => item.channel === 'email'));
});

test('provider_ready transition is restricted to clinician or operations roles', () => {
  const db = seedDatabase();
  const patient = getUser(db, 'patient');
  const clinician = getUser(db, 'clinician');

  const consultation = createConsultation(db, patient, {
    tier: 'priority',
    requestedNeed: 'Provider-ready authorization check',
    requestedCommunicationMode: 'voice_call'
  });

  claimConsultation(db, clinician, consultation.id);
  startConsultation(db, clinician, consultation.id);
  const session = openConsultationSession(db, clinician, consultation.id, { channel: 'voice_call' });

  assert.throws(
    () =>
      transitionConsultationCallSessionState(db, patient, consultation.id, session.id, {
        state: 'provider_ready',
        reason: 'patient_attempt'
      }),
    /Only clinicians or operations staff/
  );
});

test('call signaling authorization validates sender and target participation', () => {
  const db = seedDatabase();
  const patient = getUser(db, 'patient');
  const clinician = getUser(db, 'clinician');
  const coordinator = getUser(db, 'coordinator');

  const stranger = {
    id: 'user_stranger',
    role: 'clinician',
    email: 'stranger@mindset.local'
  };
  db.users.push(stranger);

  const consultation = createConsultation(db, patient, {
    tier: 'priority',
    requestedNeed: 'Authorization policy coverage',
    requestedCommunicationMode: 'voice_call'
  });

  claimConsultation(db, clinician, consultation.id);
  startConsultation(db, clinician, consultation.id);
  const session = openConsultationSession(db, clinician, consultation.id, { channel: 'voice_call' });

  const patientUserId = patient.id;
  const clinicianUserId = clinician.id;

  const allowed = authorizeConsultationCallSignal(db, {
    consultationId: consultation.id,
    sessionId: session.id,
    fromUserId: clinicianUserId,
    fromRole: 'clinician',
    targetUserId: patientUserId,
    signalType: 'offer'
  });
  assert.equal(allowed.ok, true);

  const blockedSender = authorizeConsultationCallSignal(db, {
    consultationId: consultation.id,
    sessionId: session.id,
    fromUserId: stranger.id,
    fromRole: 'clinician',
    targetUserId: patientUserId,
    signalType: 'offer'
  });
  assert.equal(blockedSender.ok, false);

  const blockedTarget = authorizeConsultationCallSignal(db, {
    consultationId: consultation.id,
    sessionId: session.id,
    fromUserId: clinicianUserId,
    fromRole: 'clinician',
    targetUserId: stranger.id,
    signalType: 'offer'
  });
  assert.equal(blockedTarget.ok, false);

  const coordinatorAllowed = authorizeConsultationCallSignal(db, {
    consultationId: consultation.id,
    sessionId: session.id,
    fromUserId: coordinator.id,
    fromRole: 'coordinator',
    targetUserId: patientUserId,
    signalType: 'hangup'
  });
  assert.equal(coordinatorAllowed.ok, true);
});

test('call audit event recorder appends marker interaction and updates call state when applicable', () => {
  const db = seedDatabase();
  const patient = getUser(db, 'patient');
  const clinician = getUser(db, 'clinician');

  const consultation = createConsultation(db, patient, {
    tier: 'priority',
    requestedNeed: 'Signaling audit marker coverage',
    requestedCommunicationMode: 'voice_call'
  });

  claimConsultation(db, clinician, consultation.id);
  startConsultation(db, clinician, consultation.id);
  const session = openConsultationSession(db, clinician, consultation.id, { channel: 'voice_call' });

  const recorded = recordConsultationCallAuditEvent(db, {
    consultationId: consultation.id,
    sessionId: session.id,
    marker: 'participant_joined',
    userId: clinician.id,
    role: clinician.role,
    reason: 'socket_connected'
  });
  assert.ok(recorded);

  recordConsultationCallAuditEvent(db, {
    consultationId: consultation.id,
    sessionId: session.id,
    marker: 'connected',
    userId: clinician.id,
    role: clinician.role,
    reason: 'peer_connection_connected'
  });

  const refreshed = db.consultationSessions.find((item) => item.id === session.id);
  assert.equal(refreshed.callState, 'in_call');
});

test('consultation interactions support voice_text, voice_call, and video_call session use cases', () => {
  const db = seedDatabase();
  const patient = getUser(db, 'patient');
  const clinician = getUser(db, 'clinician');

  const consultation = createConsultation(db, patient, {
    tier: 'super_priority',
    requestedNeed: 'Multi-channel communication interaction test'
  });
  claimConsultation(db, clinician, consultation.id);
  startConsultation(db, clinician, consultation.id);

  const voiceTextSession = openConsultationSession(db, clinician, consultation.id, { channel: 'voice_text' });
  const patientMessage = recordConsultationInteraction(db, patient, consultation.id, voiceTextSession.id, {
    interactionType: 'patient_message',
    message: 'I can describe my symptoms here before switching channels.'
  });
  const clinicianMessage = recordConsultationInteraction(db, clinician, consultation.id, voiceTextSession.id, {
    interactionType: 'clinician_message',
    message: 'Received. I will now move this to a live call for faster triage.'
  });
  assert.equal(patientMessage.channel, 'voice_text');
  assert.equal(clinicianMessage.channel, 'voice_text');
  closeConsultationSession(db, clinician, consultation.id, voiceTextSession.id, { reason: 'switch_channel' });

  const voiceCallSession = openConsultationSession(db, clinician, consultation.id, { channel: 'voice_call' });
  const callConnected = recordConsultationInteraction(db, clinician, consultation.id, voiceCallSession.id, {
    interactionType: 'session_marker',
    marker: 'connected'
  });
  const callNote = recordConsultationInteraction(db, clinician, consultation.id, voiceCallSession.id, {
    interactionType: 'clinical_note',
    message: 'Voice call confirmed moderate urgency; preparing video escalation check.'
  });
  assert.equal(callConnected.marker, 'connected');
  assert.equal(callNote.interactionType, 'clinical_note');
  closeConsultationSession(db, clinician, consultation.id, voiceCallSession.id, { reason: 'switch_channel' });

  const videoSession = openConsultationSession(db, clinician, consultation.id, { channel: 'video_call' });
  const videoConnected = recordConsultationInteraction(db, clinician, consultation.id, videoSession.id, {
    interactionType: 'session_marker',
    marker: 'connected'
  });
  assert.equal(videoConnected.channel, 'video_call');

  assert.throws(
    () => recordConsultationInteraction(db, patient, consultation.id, videoSession.id, {
      interactionType: 'patient_message',
      message: 'Trying text event in video call'
    }),
    /not allowed for video_call/
  );

  closeConsultationSession(db, clinician, consultation.id, videoSession.id, { reason: 'finished' });
  const postCloseNote = recordConsultationInteraction(db, clinician, consultation.id, videoSession.id, {
    interactionType: 'clinical_note',
    message: 'Video session closed with treatment guidance shared.'
  });
  assert.equal(postCloseNote.interactionType, 'clinical_note');

  const interactions = listConsultationInteractions(db, clinician, consultation.id, videoSession.id);
  assert.ok(interactions.length >= 2);
});

test('consultation interactions support filtering by type, actor role, and limit', () => {
  const db = seedDatabase();
  const patient = getUser(db, 'patient');
  const clinician = getUser(db, 'clinician');
  const coordinator = getUser(db, 'coordinator');

  const consultation = createConsultation(db, patient, {
    tier: 'normal',
    requestedNeed: 'Interaction filtering coverage'
  });
  claimConsultation(db, clinician, consultation.id);
  startConsultation(db, clinician, consultation.id);
  const session = openConsultationSession(db, clinician, consultation.id, { channel: 'voice_text' });

  recordConsultationInteraction(db, patient, consultation.id, session.id, {
    interactionType: 'patient_message',
    message: 'Patient opening message'
  });
  recordConsultationInteraction(db, clinician, consultation.id, session.id, {
    interactionType: 'clinician_message',
    message: 'Clinician response'
  });
  recordConsultationInteraction(db, coordinator, consultation.id, session.id, {
    interactionType: 'clinical_note',
    message: 'Coordinator note for routing quality.'
  });

  const byType = listConsultationInteractionsWithOptions(db, clinician, consultation.id, session.id, {
    type: 'clinician_message'
  });
  assert.equal(byType.length, 1);
  assert.equal(byType[0].interactionType, 'clinician_message');

  const byRole = listConsultationInteractionsWithOptions(db, clinician, consultation.id, session.id, {
    actorRole: 'coordinator'
  });
  assert.equal(byRole.length, 1);
  assert.equal(byRole[0].createdByRole, 'coordinator');

  const limited = listConsultationInteractionsWithOptions(db, clinician, consultation.id, session.id, {
    limit: 2
  });
  assert.equal(limited.length, 2);

  assert.throws(
    () => listConsultationInteractionsWithOptions(db, clinician, consultation.id, session.id, { type: 'invalid_type' }),
    /type must be one of/
  );
});

test('consultation interactions normalize label variants and infer missing interactionType', () => {
  const db = seedDatabase();
  const patient = getUser(db, 'patient');
  const clinician = getUser(db, 'clinician');

  const consultation = createConsultation(db, patient, {
    tier: 'priority',
    requestedNeed: 'Interaction type normalization and inference'
  });
  claimConsultation(db, clinician, consultation.id);
  startConsultation(db, clinician, consultation.id);

  const callSession = openConsultationSession(db, clinician, consultation.id, { channel: 'voice_call' });
  const marker = recordConsultationInteraction(db, clinician, consultation.id, callSession.id, {
    interactionType: 'Session Marker',
    marker: 'connected'
  });
  assert.equal(marker.interactionType, 'session_marker');

  closeConsultationSession(db, clinician, consultation.id, callSession.id, { reason: 'switch_channel' });
  const textSession = openConsultationSession(db, clinician, consultation.id, { channel: 'voice_text' });

  const inferredPatient = recordConsultationInteraction(db, patient, consultation.id, textSession.id, {
    message: 'Patient sent this without explicit interaction type'
  });
  assert.equal(inferredPatient.interactionType, 'patient_message');

  const inferredClinician = recordConsultationInteraction(db, clinician, consultation.id, textSession.id, {
    message: 'Clinician sent this without explicit interaction type'
  });
  assert.equal(inferredClinician.interactionType, 'clinician_message');
});

test('consultation interactions fallback to session_marker for call/video payloads without message', () => {
  const db = seedDatabase();
  const patient = getUser(db, 'patient');
  const clinician = getUser(db, 'clinician');

  const consultation = createConsultation(db, patient, {
    tier: 'priority',
    requestedNeed: 'Marker fallback validation'
  });
  claimConsultation(db, clinician, consultation.id);
  startConsultation(db, clinician, consultation.id);

  const session = openConsultationSession(db, clinician, consultation.id, { channel: 'voice_call' });
  const interaction = recordConsultationInteraction(db, clinician, consultation.id, session.id, {
    interactionType: 'clinical_note',
    marker: 'connected',
    message: '   '
  });

  assert.equal(interaction.interactionType, 'session_marker');
  assert.equal(interaction.marker, 'connected');
  assert.equal(interaction.message, null);
});

test('consultation notifications target patient, clinician, and coordinator audiences', () => {
  const db = seedDatabase();
  const patient = getUser(db, 'patient');
  const clinician = getUser(db, 'clinician');

  const consultation = createConsultation(db, patient, {
    tier: 'priority',
    requestedNeed: 'Audience targeting verification',
    specialtyId: null,
    procedureId: null
  });

  claimConsultation(db, clinician, consultation.id);

  const events = db.notificationLogs.filter((item) => item.consultationId === consultation.id);
  const hasPatientMessage = events.some((item) => item.subject === 'Doctor accepted your request');
  const hasClinicianMessage = events.some((item) => item.subject === 'Consultation claim confirmed');
  const hasCoordinatorMessage = events.some((item) => item.subject === 'Consultation claimed by clinician');

  assert.equal(hasPatientMessage, true);
  assert.equal(hasClinicianMessage, true);
  assert.equal(hasCoordinatorMessage, true);
});

test('consultation notifications apply channel preference and fallback policy', () => {
  const db = seedDatabase();
  const patient = getUser(db, 'patient');
  const clinician = getUser(db, 'clinician');
  const coordinator = getUser(db, 'coordinator');

  patient.notificationPreferences = { consultations: { preferredChannels: ['email'] } };
  clinician.notificationPreferences = { consultations: { preferredChannels: ['in_app'] } };
  coordinator.notificationPreferences = { consultations: { preferredChannels: ['email'] } };

  const consultation = createConsultation(db, patient, {
    tier: 'normal',
    requestedNeed: 'Channel routing policy verification'
  });

  claimConsultation(db, clinician, consultation.id);

  const events = db.notificationLogs.filter((item) => item.consultationId === consultation.id);
  const patientClaim = events.find((item) => item.subject === 'Doctor accepted your request');
  const clinicianClaim = events.find((item) => item.subject === 'Consultation claim confirmed');
  const coordinatorClaim = events.find((item) => item.subject === 'Consultation claimed by clinician');
  const clinicianClaimEmailCopy = events.find(
    (item) => item.subject === 'Consultation claim confirmed' && item.channel === 'email' && item.recipient === clinician.email
  );
  const patientClaimEmailCopy = events.find(
    (item) => item.subject === 'Doctor accepted your request' && item.channel === 'email' && item.recipient === patient.email
  );

  assert.equal(patientClaim.channel, 'email');
  assert.equal(clinicianClaim.channel, 'in_app');
  assert.equal(clinicianClaim.recipient, `user:${clinician.id}`);
  assert.equal(coordinatorClaim.channel, 'email');
  assert.ok(clinicianClaimEmailCopy);
  assert.ok(patientClaimEmailCopy);

  patient.notificationPreferences = { consultations: { preferredChannels: ['in_app'] } };
  const patientRecord = db.patients.find((item) => item.id === patient.patientId);
  patientRecord.userId = null;
  const second = createConsultation(db, patient, {
    tier: 'normal',
    requestedNeed: 'Fallback route check'
  });

  const secondEvents = db.notificationLogs.filter((item) => item.consultationId === second.id);
  const patientCreated = secondEvents.find((item) => item.subject === 'Consultation request created');
  const clinicianCreatedEmailCopy = secondEvents.find(
    (item) => item.subject === 'New consultation request available' && item.channel === 'email' && item.recipient === clinician.email
  );
  assert.equal(patientCreated.channel, 'sms');
  assert.ok(clinicianCreatedEmailCopy);

  clinician.notificationPreferences = { consultations: { preferredChannels: ['in_app'], emailCopyEnabled: false } };
  const third = createConsultation(db, patient, {
    tier: 'normal',
    requestedNeed: 'No email copy for clinician'
  });
  const thirdEvents = db.notificationLogs.filter((item) => item.consultationId === third.id);
  const clinicianCreatedEmailCopyDisabled = thirdEvents.find(
    (item) => item.subject === 'New consultation request available' && item.channel === 'email' && item.recipient === clinician.email
  );
  assert.equal(clinicianCreatedEmailCopyDisabled, undefined);
});

test('consultation operational alerts surface stuck states and payment integrity mismatches', () => {
  const db = seedDatabase();
  const patient = getUser(db, 'patient');
  const clinician = getUser(db, 'clinician');

  const staleRequested = createConsultation(db, patient, {
    tier: 'normal',
    requestedNeed: 'Stale requested state alert test'
  });
  const staleRequestedRow = db.consultations.find((item) => item.id === staleRequested.id);
  staleRequestedRow.claimWindowEndsAt = new Date(Date.now() - 1000).toISOString();

  const stuckInProgress = createConsultation(db, patient, {
    tier: 'priority',
    requestedNeed: 'Stale in-progress alert test'
  });
  claimConsultation(db, clinician, stuckInProgress.id);
  startConsultation(db, clinician, stuckInProgress.id);
  const stuckRow = db.consultations.find((item) => item.id === stuckInProgress.id);
  stuckRow.startedAt = new Date(Date.now() - 181 * 60 * 1000).toISOString();

  const badCompleted = createConsultation(db, patient, {
    tier: 'normal',
    requestedNeed: 'Completed payment mismatch alert test'
  });
  claimConsultation(db, clinician, badCompleted.id);
  startConsultation(db, clinician, badCompleted.id);
  completeConsultation(db, clinician, badCompleted.id);
  const badCompletedHold = db.payments.find((item) => item.consultationId === badCompleted.id && item.paymentType === 'consultation_hold');
  badCompletedHold.status = 'held';

  const terminalUnreconciled = createConsultation(db, patient, {
    tier: 'normal',
    requestedNeed: 'Terminal unreconciled hold alert test'
  });
  claimConsultation(db, clinician, terminalUnreconciled.id);
  startConsultation(db, clinician, terminalUnreconciled.id);
  completeConsultation(db, clinician, terminalUnreconciled.id);
  const terminalHold = db.payments.find(
    (item) => item.consultationId === terminalUnreconciled.id && item.paymentType === 'consultation_hold'
  );
  terminalHold.reconciliationStatus = 'unreconciled';
  terminalHold.updatedAt = new Date(Date.now() - 61 * 60 * 1000).toISOString();

  const alerts = consultationOperationalAlerts(db, {
    maxInProgressMinutes: 120,
    claimConflictThreshold: 0,
    terminalHoldReconciliationGraceMinutes: 30
  });
  assert.equal(alerts.status, 'warning');
  assert.equal(alerts.highestSeverity, 'critical');
  assert.ok(alerts.alerts.includes('consultations_stuck_requested'));
  assert.ok(alerts.alerts.includes('consultations_stuck_in_progress'));
  assert.ok(alerts.alerts.includes('completed_without_captured_hold'));
  assert.ok(alerts.alerts.includes('terminal_hold_unreconciled'));
  assert.equal(alerts.stuck.requestedPastWindow, 1);
  assert.equal(alerts.stuck.inProgressOverSla, 1);
  assert.ok(typeof alerts.claims.conflictsLast24h === 'number');
  assert.equal(alerts.payments.completedWithoutCapturedHold, 1);
  assert.equal(alerts.payments.unreconciledTerminalHolds, 1);
  const completedMismatchDetail = alerts.alertDetails.find((item) => item.code === 'completed_without_captured_hold');
  assert.equal(completedMismatchDetail.severity, 'critical');
  assert.ok(completedMismatchDetail.remediation.includes('Reconcile'));
});

test('consultation operational snapshot exposes median and hold release rate metrics', () => {
  const db = seedDatabase();
  const patient = getUser(db, 'patient');
  const clinician = getUser(db, 'clinician');

  const first = createConsultation(db, patient, {
    tier: 'normal',
    requestedNeed: 'Snapshot metrics consultation #1'
  });
  const second = createConsultation(db, patient, {
    tier: 'normal',
    requestedNeed: 'Snapshot metrics consultation #2'
  });

  const firstRow = db.consultations.find((item) => item.id === first.id);
  const secondRow = db.consultations.find((item) => item.id === second.id);
  firstRow.createdAt = new Date(Date.now() - 120000).toISOString();
  secondRow.createdAt = new Date(Date.now() - 30000).toISOString();

  claimConsultation(db, clinician, first.id);
  claimConsultation(db, clinician, second.id);
  cancelConsultation(db, patient, second.id, { reason: 'Patient cancelled during claim window' });

  const snapshot = consultationOperationalSnapshot(db);
  assert.ok(snapshot.averageClaimTimeSeconds > 0);
  assert.ok(snapshot.medianClaimTimeSeconds > 0);
  assert.ok(snapshot.p90ClaimTimeSeconds >= snapshot.medianClaimTimeSeconds);
  assert.ok(typeof snapshot.holdReleaseRatePercent === 'number');
  assert.ok(snapshot.riskDistribution);
  assert.ok(typeof snapshot.riskDistribution.critical === 'number');
  assert.ok(typeof snapshot.riskDistribution.warning === 'number');
  assert.ok(typeof snapshot.riskDistribution.stable === 'number');
  assert.ok(typeof snapshot.criticalRiskPercent === 'number');
  assert.ok(typeof snapshot.interactionsLast24h === 'number');
  assert.ok(snapshot.interactionBreakdownLast24h);
  assert.ok(typeof snapshot.interactionBreakdownLast24h.patientMessages === 'number');
  assert.ok(typeof snapshot.interactionBreakdownLast24h.clinicianMessages === 'number');
  assert.ok(typeof snapshot.interactionBreakdownLast24h.sessionMarkers === 'number');
  assert.ok(typeof snapshot.interactionBreakdownLast24h.clinicalNotes === 'number');
  assert.ok(typeof snapshot.activeSessions === 'number');
  assert.ok(typeof snapshot.interactionsPerActiveSessionLast24h === 'number');
  assert.ok(typeof snapshot.totalCallSessions === 'number');
  assert.ok(typeof snapshot.activeCallSessions === 'number');
  assert.ok(snapshot.callStateCounts);
  assert.ok(snapshot.activeCallStateCounts);
  assert.ok(typeof snapshot.waitingRoomPressureScore === 'number');
  assert.ok(['low', 'elevated', 'high'].includes(snapshot.waitingRoomPressureLevel));
  assert.ok(typeof snapshot.callReadinessPercent === 'number');
  assert.ok(typeof snapshot.consultationsWaitingRoomActive === 'number');
  assert.ok(typeof snapshot.oldestWaitingRoomSeconds === 'number');
  assert.ok(typeof snapshot.oldestProviderReadySeconds === 'number');
});

test('consultation list entries include call-state summary for waiting-room triage', () => {
  const db = seedDatabase();
  const patient = getUser(db, 'patient');
  const clinician = getUser(db, 'clinician');
  const coordinator = getUser(db, 'coordinator');

  const consultation = createConsultation(db, patient, {
    tier: 'priority',
    requestedNeed: 'Call-state summary projection test',
    requestedCommunicationMode: 'voice_call'
  });

  claimConsultation(db, clinician, consultation.id);
  startConsultation(db, clinician, consultation.id);
  const session = openConsultationSession(db, clinician, consultation.id, { channel: 'voice_call' });
  transitionConsultationCallSessionState(db, clinician, consultation.id, session.id, {
    state: 'waiting_room',
    reason: 'Awaiting provider audio check'
  });

  const list = listConsultations(db, coordinator);
  const row = list.find((item) => item.id === consultation.id);
  assert.ok(row);
  assert.ok(row.callStateSummary);
  assert.equal(row.callStateSummary.waitingRoomActive, 1);
  assert.equal(row.callStateSummary.waitingPressureLevel, 'elevated');
  assert.ok(typeof row.callStateSummary.oldestWaitingRoomSeconds === 'number');
});

test('consultation event timeline aggregates state, claims, sessions, interactions, payment and biometrics', () => {
  const db = seedDatabase();
  const patient = getUser(db, 'patient');
  const clinician = getUser(db, 'clinician');

  const consultation = createConsultation(db, patient, {
    tier: 'priority',
    requestedNeed: 'Timeline test consultation'
  });
  claimConsultation(db, clinician, consultation.id);
  startConsultation(db, clinician, consultation.id);
  const session = openConsultationSession(db, clinician, consultation.id, { channel: 'voice_call' });
  recordConsultationInteraction(db, clinician, consultation.id, session.id, {
    interactionType: 'session_marker',
    marker: 'connected'
  });
  recordBiometricHook(db, clinician, consultation.id, { method: 'face', status: 'matched' });
  closeConsultationSession(db, clinician, consultation.id, session.id, { reason: 'finished' });
  completeConsultation(db, clinician, consultation.id);

  const events = listConsultationEvents(db, clinician, consultation.id);
  assert.ok(events.length > 0);
  assert.ok(events.some((item) => item.kind === 'state_transition'));
  assert.ok(events.some((item) => item.kind === 'claim'));
  assert.ok(events.some((item) => item.kind === 'session'));
  assert.ok(events.some((item) => item.kind === 'interaction'));
  assert.ok(events.some((item) => item.kind === 'payment'));
  assert.ok(events.some((item) => item.kind === 'biometric_hook'));
});

test('consultation event timeline supports kind filter and limit options', () => {
  const db = seedDatabase();
  const patient = getUser(db, 'patient');
  const clinician = getUser(db, 'clinician');

  const consultation = createConsultation(db, patient, {
    tier: 'priority',
    requestedNeed: 'Timeline filter test consultation'
  });
  claimConsultation(db, clinician, consultation.id);
  startConsultation(db, clinician, consultation.id);
  const session = openConsultationSession(db, clinician, consultation.id, { channel: 'voice_call' });
  recordConsultationInteraction(db, clinician, consultation.id, session.id, {
    interactionType: 'session_marker',
    marker: 'connected'
  });

  const interactionOnly = listConsultationEventsWithOptions(db, clinician, consultation.id, {
    kind: 'interaction'
  });
  assert.ok(interactionOnly.length >= 1);
  assert.ok(interactionOnly.every((item) => item.kind === 'interaction'));

  const limited = listConsultationEventsWithOptions(db, clinician, consultation.id, {
    limit: 2
  });
  assert.equal(limited.length, 2);
});

test('consultation list supports urgency and waiting-time sort modes', () => {
  const db = seedDatabase();
  const patient = getUser(db, 'patient');
  const coordinator = getUser(db, 'coordinator');

  const normal = createConsultation(db, patient, {
    tier: 'normal',
    requestedNeed: 'Sort baseline normal consultation'
  });
  const priority = createConsultation(db, patient, {
    tier: 'priority',
    requestedNeed: 'Sort baseline priority consultation'
  });
  const superPriority = createConsultation(db, patient, {
    tier: 'super_priority',
    requestedNeed: 'Sort baseline super priority consultation'
  });

  const normalRow = db.consultations.find((item) => item.id === normal.id);
  const priorityRow = db.consultations.find((item) => item.id === priority.id);
  const superPriorityRow = db.consultations.find((item) => item.id === superPriority.id);
  normalRow.createdAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  priorityRow.createdAt = new Date(Date.now() - 3 * 60 * 1000).toISOString();
  superPriorityRow.createdAt = new Date(Date.now() - 1 * 60 * 1000).toISOString();

  const byUrgency = listConsultationsWithOptions(db, coordinator, { sort: 'urgency' });
  assert.equal(byUrgency[0].tier, 'super_priority');
  assert.equal(byUrgency[1].tier, 'priority');

  const byWaitingTime = listConsultationsWithOptions(db, coordinator, { sort: 'waiting_time' });
  assert.equal(byWaitingTime[0].id, normal.id);
  assert.equal(byWaitingTime[byWaitingTime.length - 1].id, superPriority.id);
});

test('consultation list supports status, tier, and search filters', () => {
  const db = seedDatabase();
  const patient = getUser(db, 'patient');
  const coordinator = getUser(db, 'coordinator');
  const clinician = getUser(db, 'clinician');

  createConsultation(db, patient, {
    tier: 'normal',
    requestedNeed: 'General wellness follow-up token-alpha'
  });
  const filteredCandidate = createConsultation(db, patient, {
    tier: 'priority',
    requestedNeed: 'Neurology urgent review token-bravo'
  });

  claimConsultation(db, clinician, filteredCandidate.id);
  startConsultation(db, clinician, filteredCandidate.id);

  const filtered = listConsultationsWithOptions(db, coordinator, {
    sort: 'recent',
    status: 'IN_PROGRESS',
    tier: 'priority',
    search: 'token-bravo'
  });

  assert.ok(filtered.length >= 1);
  assert.ok(filtered.every((item) => item.status === 'IN_PROGRESS'));
  assert.ok(filtered.every((item) => item.tier === 'priority'));
  assert.ok(filtered.every((item) => item.requestedNeed.toLowerCase().includes('token-bravo')));
});

test('consultation list claim-expiry sort prioritizes requested consultations nearing expiry', () => {
  const db = seedDatabase();
  const patient = getUser(db, 'patient');
  const clinician = getUser(db, 'clinician');

  const first = createConsultation(db, patient, {
    tier: 'normal',
    requestedNeed: 'Claim expiry sort first'
  });
  const second = createConsultation(db, patient, {
    tier: 'super_priority',
    requestedNeed: 'Claim expiry sort second'
  });

  const firstRow = db.consultations.find((item) => item.id === first.id);
  const secondRow = db.consultations.find((item) => item.id === second.id);
  firstRow.claimWindowEndsAt = new Date(Date.now() + 20000).toISOString();
  secondRow.claimWindowEndsAt = new Date(Date.now() + 60000).toISOString();

  claimConsultation(db, clinician, second.id);

  const ordered = listConsultationsWithOptions(db, getUser(db, 'coordinator'), { sort: 'claim_expiry' });
  assert.equal(ordered[0].id, first.id);
});

test('consultation expansion includes risk summary metadata', () => {
  const db = seedDatabase();
  const patient = getUser(db, 'patient');
  const coordinator = getUser(db, 'coordinator');

  createConsultation(db, patient, {
    tier: 'super_priority',
    requestedNeed: 'Risk summary payload test'
  });

  const consultations = listConsultationsWithOptions(db, coordinator, { sort: 'recent' });
  assert.ok(consultations.length >= 1);
  assert.ok(typeof consultations[0].riskSummary?.score === 'number');
  assert.ok(['stable', 'warning', 'critical'].includes(consultations[0].riskSummary?.level));
  assert.ok(Array.isArray(consultations[0].riskSummary?.flags));
  assert.ok(Array.isArray(consultations[0].riskSummary?.topFlags));
});

test('consultation list risk-score sort prioritizes highest operational risk', () => {
  const db = seedDatabase();
  const patient = getUser(db, 'patient');
  const coordinator = getUser(db, 'coordinator');

  const baseline = createConsultation(db, patient, {
    tier: 'super_priority',
    requestedNeed: 'High tier but healthy payment state'
  });
  const risky = createConsultation(db, patient, {
    tier: 'normal',
    requestedNeed: 'Lower tier but payment inconsistency'
  });

  const riskyRow = db.consultations.find((item) => item.id === risky.id);
  riskyRow.claimWindowEndsAt = new Date(Date.now() + 5000).toISOString();
  const riskyHold = db.payments.find((item) => item.consultationId === risky.id && item.paymentType === 'consultation_hold');
  riskyHold.status = 'captured';

  const ordered = listConsultationsWithOptions(db, coordinator, { sort: 'risk_score' });
  assert.equal(ordered[0].id, risky.id);
  assert.ok(ordered[0].riskSummary.score >= ordered[1].riskSummary.score);

  const baselineItem = ordered.find((item) => item.id === baseline.id);
  assert.ok(baselineItem);
});

test('consultation risk summary exposes readable top risk labels', () => {
  const db = seedDatabase();
  const patient = getUser(db, 'patient');
  const coordinator = getUser(db, 'coordinator');

  const consultation = createConsultation(db, patient, {
    tier: 'super_priority',
    requestedNeed: 'Readable risk label test'
  });

  const row = db.consultations.find((item) => item.id === consultation.id);
  row.claimWindowEndsAt = new Date(Date.now() - 1000).toISOString();
  const hold = db.payments.find((item) => item.consultationId === consultation.id && item.paymentType === 'consultation_hold');
  hold.status = 'captured';

  const expanded = listConsultationsWithOptions(db, coordinator, { sort: 'risk_score' }).find((item) => item.id === consultation.id);
  assert.ok(expanded);
  assert.ok(expanded.riskSummary.flags.length >= 2);
  assert.ok(expanded.riskSummary.topFlags.length >= 1);
  assert.ok(expanded.riskSummary.topFlags.length <= 3);
  assert.ok(typeof expanded.riskSummary.topFlags[0].label === 'string');
});

test('ensureActiveCommunicationLayer and switchConsultationCommunicationLayer manage active comms layer atomically', () => {
  const db = seedDatabase();
  const patient = getUser(db, 'patient');
  const clinician = getUser(db, 'clinician');

  const consultation = createConsultation(db, patient, {
    tier: 'priority',
    requestedNeed: 'Active comms layer management test',
    requestedCommunicationMode: 'voice_call'
  });

  claimConsultation(db, clinician, consultation.id);
  startConsultation(db, clinician, consultation.id);

  const ensured = ensureActiveCommunicationLayer(db, clinician, consultation.id);
  assert.equal(ensured.session.status, 'active');
  assert.equal(ensured.session.channel, 'voice_call');
  assert.equal(ensured.consultation.activeCommunicationLayer, 'voice_call');

  const reEnsured = ensureActiveCommunicationLayer(db, clinician, consultation.id);
  assert.equal(reEnsured.autoProvisioned, false);
  assert.equal(reEnsured.session.id, ensured.session.id);

  const switched = switchConsultationCommunicationLayer(db, clinician, consultation.id, {
    targetChannel: 'video_call',
    reason: 'clinical_escalation_to_video'
  });

  assert.equal(switched.switched, true);
  assert.equal(switched.session.channel, 'video_call');
  assert.equal(switched.session.status, 'active');
  assert.equal(switched.consultation.activeCommunicationLayer, 'video_call');

  const prevSession = db.consultationSessions.find((s) => s.id === ensured.session.id);
  assert.equal(prevSession.status, 'completed');
  assert.equal(prevSession.endReason, 'clinical_escalation_to_video');
});
