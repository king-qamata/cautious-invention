import {
  assertRole,
  consultationTiers,
  hashPassword,
  isEmail,
  normalizeEmail,
  normalizeString,
  now,
  publicUser,
  verifyPassword
} from '../domain.js';
import { countClinicianEligibleBroadcasts } from './consultations.js';

function ensureCollections(db) {
  db.users ||= [];
  db.leads ||= [];
  db.referrals ||= [];
  db.consultations ||= [];
  db.appointments ||= [];
  db.payments ||= [];
  db.notificationLogs ||= [];
}

const SUPPORTED_NOTIFICATION_CHANNELS = ['sms', 'email', 'in_app'];
const SUPPORTED_NOTIFICATION_TYPES = ['consultation', 'communication', 'referral', 'account', 'system'];
const SUPPORTED_NOTIFICATION_SEVERITIES = ['info', 'warning', 'critical'];
const SUPPORTED_NEXT_ACTION_STATUSES = ['active', 'completed', 'snoozed'];

function normalizePreferenceChannels(channels) {
  if (!Array.isArray(channels)) {
    const error = new Error('preferredChannels must be an array.');
    error.status = 422;
    throw error;
  }
  const seen = new Set();
  const normalized = [];
  for (const item of channels) {
    const value = normalizeString(item, 30).toLowerCase();
    if (!SUPPORTED_NOTIFICATION_CHANNELS.includes(value)) {
      const error = new Error(`Unsupported notification channel: ${value || 'unknown'}`);
      error.status = 422;
      throw error;
    }
    if (seen.has(value)) continue;
    seen.add(value);
    normalized.push(value);
  }
  return normalized;
}

function defaultNotificationPreferences() {
  return {
    consultations: {
      preferredChannels: ['sms', 'email'],
      emailCopyEnabled: true
    }
  };
}

function currentNotificationPreferences(user) {
  const existing = user.notificationPreferences;
  if (!existing || typeof existing !== 'object') {
    user.notificationPreferences = defaultNotificationPreferences();
  }
  if (!user.notificationPreferences.consultations || typeof user.notificationPreferences.consultations !== 'object') {
    user.notificationPreferences.consultations = { preferredChannels: ['sms', 'email'], emailCopyEnabled: true };
  }
  if (!Array.isArray(user.notificationPreferences.consultations.preferredChannels)) {
    user.notificationPreferences.consultations.preferredChannels = ['sms', 'email'];
  }
  if (typeof user.notificationPreferences.consultations.emailCopyEnabled !== 'boolean') {
    user.notificationPreferences.consultations.emailCopyEnabled = true;
  }
  return user.notificationPreferences;
}

export function updateOwnProfile(db, userId, payload) {
  ensureCollections(db);
  const user = db.users.find((item) => item.id === userId);
  if (!user) {
    const error = new Error('User not found.');
    error.status = 404;
    throw error;
  }

  const updatable = ['firstName', 'lastName', 'phone'];
  for (const field of updatable) {
    if (payload[field] !== undefined) {
      user[field] = normalizeString(payload[field], field === 'phone' ? 30 : 100);
    }
  }

  if (payload.email !== undefined) {
    const nextEmail = normalizeEmail(payload.email);
    if (!isEmail(nextEmail)) {
      const error = new Error('A valid email address is required.');
      error.status = 422;
      throw error;
    }
    const duplicate = db.users.find((item) => item.id !== user.id && item.email.toLowerCase() === nextEmail);
    if (duplicate) {
      const error = new Error('Email is already in use.');
      error.status = 409;
      throw error;
    }
    user.email = nextEmail;
  }

  user.updatedAt = now();

  if (user.role === 'patient' && user.patientId) {
    const patient = db.patients.find((item) => item.id === user.patientId);
    if (patient) {
      patient.name = `${user.firstName} ${user.lastName}`.trim();
      patient.email = user.email;
      patient.phone = user.phone;
      if (payload.city !== undefined) patient.city = normalizeString(payload.city, 100);
      if (payload.state !== undefined) patient.state = normalizeString(payload.state, 100);
      if (payload.country !== undefined) patient.country = normalizeString(payload.country, 100);
      patient.updatedAt = now();
    }
  }

  return publicUser(user);
}

export function changeOwnPassword(db, userId, payload) {
  ensureCollections(db);
  const user = db.users.find((item) => item.id === userId);
  if (!user) {
    const error = new Error('User not found.');
    error.status = 404;
    throw error;
  }

  const currentPassword = String(payload.currentPassword || '');
  const newPassword = String(payload.newPassword || '');
  if (!verifyPassword(currentPassword, user.passwordHash)) {
    const error = new Error('Current password is incorrect.');
    error.status = 401;
    throw error;
  }
  if (newPassword.length < 8) {
    const error = new Error('New password must be at least 8 characters.');
    error.status = 422;
    throw error;
  }

  user.passwordHash = hashPassword(newPassword);
  user.updatedAt = now();
  return { ok: true };
}

export function accountUseCases(db, user) {
  ensureCollections(db);
  const base = {
    user: publicUser(user),
    allowedActions: allowedActionsByRole(user.role)
  };

  if (user.role === 'patient') {
    const consultations = db.consultations.filter((item) => item.patientId === user.patientId);
    const referrals = db.referrals.filter((item) => item.patientId === user.patientId);
    return {
      ...base,
      summary: {
        consultations: consultations.length,
        pendingConsultations: consultations.filter((item) => ['REQUESTED', 'DOCTOR_ACCEPTED', 'IN_PROGRESS'].includes(item.status)).length,
        completedConsultations: consultations.filter((item) => item.status === 'COMPLETED').length,
        referrals: referrals.length
      }
    };
  }

  if (user.role === 'clinician') {
    const claimed = db.consultations.filter((item) => item.assignedClinicianId === user.id);
    return {
      ...base,
      summary: {
        openBroadcasts: countClinicianEligibleBroadcasts(db, user),
        claimedConsultations: claimed.length,
        inProgressConsultations: claimed.filter((item) => item.status === 'IN_PROGRESS').length,
        completedConsultations: claimed.filter((item) => item.status === 'COMPLETED').length
      }
    };
  }

  if (['coordinator', 'admin', 'finance'].includes(user.role)) {
    return {
      ...base,
      summary: {
        leads: db.leads.length,
        referrals: db.referrals.length,
        consultations: db.consultations.length,
        appointments: db.appointments.length,
        unsettledConsultationHolds: db.payments.filter(
          (item) => item.consultationId && item.paymentType === 'consultation_hold' && item.status === 'held'
        ).length
      }
    };
  }

  assertRole(user, []);
}

export function getOwnClinicianAvailability(db, userId) {
  ensureCollections(db);
  const user = db.users.find((item) => item.id === userId);
  if (!user) {
    const error = new Error('User not found.');
    error.status = 404;
    throw error;
  }
  assertRole(user, ['clinician']);
  user.consultationAvailability ||= {
    enabled: true,
    acceptedTiers: Object.keys(consultationTiers),
    specialtyIds: [],
    procedureIds: []
  };
  return structuredClone(user.consultationAvailability);
}

export function updateOwnClinicianAvailability(db, userId, payload) {
  ensureCollections(db);
  const user = db.users.find((item) => item.id === userId);
  if (!user) {
    const error = new Error('User not found.');
    error.status = 404;
    throw error;
  }
  assertRole(user, ['clinician']);

  const next = {
    enabled: payload.enabled !== undefined ? Boolean(payload.enabled) : true,
    acceptedTiers: Array.isArray(payload.acceptedTiers) ? payload.acceptedTiers.map((item) => String(item)) : Object.keys(consultationTiers),
    specialtyIds: Array.isArray(payload.specialtyIds) ? payload.specialtyIds.map((item) => String(item)) : [],
    procedureIds: Array.isArray(payload.procedureIds) ? payload.procedureIds.map((item) => String(item)) : []
  };

  const invalidTier = next.acceptedTiers.find((item) => !Object.hasOwn(consultationTiers, item));
  if (invalidTier) {
    const error = new Error(`Unsupported consultation tier: ${invalidTier}`);
    error.status = 422;
    throw error;
  }

  const specialtyIds = new Set(db.specialties.map((item) => item.id));
  const procedureById = new Map(db.procedures.map((item) => [item.id, item]));

  const unknownSpecialty = next.specialtyIds.find((id) => !specialtyIds.has(id));
  if (unknownSpecialty) {
    const error = new Error(`Unknown specialty id: ${unknownSpecialty}`);
    error.status = 422;
    throw error;
  }

  const unknownProcedure = next.procedureIds.find((id) => !procedureById.has(id));
  if (unknownProcedure) {
    const error = new Error(`Unknown procedure id: ${unknownProcedure}`);
    error.status = 422;
    throw error;
  }

  if (next.specialtyIds.length && next.procedureIds.length) {
    const mismatched = next.procedureIds.find((id) => !next.specialtyIds.includes(procedureById.get(id).specialtyId));
    if (mismatched) {
      const error = new Error('Each selected procedure must belong to one of the selected specialties.');
      error.status = 422;
      throw error;
    }
  }

  user.consultationAvailability = next;
  user.updatedAt = now();
  return structuredClone(next);
}

export function getOwnNotificationPreferences(db, userId) {
  ensureCollections(db);
  const user = db.users.find((item) => item.id === userId);
  if (!user) {
    const error = new Error('User not found.');
    error.status = 404;
    throw error;
  }
  return structuredClone(currentNotificationPreferences(user));
}

export function updateOwnNotificationPreferences(db, userId, payload) {
  ensureCollections(db);
  const user = db.users.find((item) => item.id === userId);
  if (!user) {
    const error = new Error('User not found.');
    error.status = 404;
    throw error;
  }

  const consultations = payload?.consultations;
  if (!consultations || typeof consultations !== 'object') {
    const error = new Error('consultations preferences are required.');
    error.status = 422;
    throw error;
  }

  const preferredChannels = normalizePreferenceChannels(consultations.preferredChannels);
  if (!preferredChannels.length) {
    const error = new Error('At least one preferred notification channel is required.');
    error.status = 422;
    throw error;
  }

  if (consultations.emailCopyEnabled !== undefined && typeof consultations.emailCopyEnabled !== 'boolean') {
    const error = new Error('emailCopyEnabled must be a boolean.');
    error.status = 422;
    throw error;
  }

  const preferences = currentNotificationPreferences(user);
  preferences.consultations.preferredChannels = preferredChannels;
  if (consultations.emailCopyEnabled !== undefined) {
    preferences.consultations.emailCopyEnabled = consultations.emailCopyEnabled;
  }
  user.updatedAt = now();

  return structuredClone(preferences);
}

function notificationBelongsToUser(item, userId) {
  if (!item || typeof item !== 'object') return false;
  if (item.userId === userId) return true;
  if (item.channel === 'in_app' && String(item.recipient || '') === `user:${userId}`) return true;
  return false;
}

function normalizeNotificationChannelFilter(channel) {
  const value = normalizeString(channel, 30).toLowerCase();
  if (!value || value === 'all') return 'all';
  if (!SUPPORTED_NOTIFICATION_CHANNELS.includes(value)) {
    const error = new Error(`Unsupported notification channel filter: ${value}`);
    error.status = 422;
    throw error;
  }
  return value;
}

function normalizeNotificationLimit(limit) {
  if (limit === undefined || limit === null || limit === '') return 50;
  const parsed = Number.parseInt(String(limit), 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 200) {
    const error = new Error('limit must be between 1 and 200.');
    error.status = 422;
    throw error;
  }
  return parsed;
}

function normalizeNotificationTypeFilter(type) {
  const value = normalizeString(type, 40).toLowerCase();
  if (!value || value === 'all') return 'all';
  if (!SUPPORTED_NOTIFICATION_TYPES.includes(value)) {
    const error = new Error(`Unsupported notification type filter: ${value}`);
    error.status = 422;
    throw error;
  }
  return value;
}

function normalizeNotificationSeverityFilter(severity) {
  const value = normalizeString(severity, 20).toLowerCase();
  if (!value || value === 'all') return 'all';
  if (!SUPPORTED_NOTIFICATION_SEVERITIES.includes(value)) {
    const error = new Error(`Unsupported notification severity filter: ${value}`);
    error.status = 422;
    throw error;
  }
  return value;
}

function normalizeNotificationFilters(options = {}) {
  return {
    channel: normalizeNotificationChannelFilter(options.channel),
    type: normalizeNotificationTypeFilter(options.type),
    severity: normalizeNotificationSeverityFilter(options.severity),
    unreadOnly: options.unreadOnly === true
  };
}

function resolveNotificationType(item) {
  const fromStored = normalizeString(item?.notificationType, 40).toLowerCase();
  if (SUPPORTED_NOTIFICATION_TYPES.includes(fromStored)) return fromStored;

  const eventKey = normalizeString(item?.eventKey, 80).toLowerCase();
  if (eventKey.includes('call_') || eventKey.includes('communication_')) return 'communication';
  if (item?.referralId) return 'referral';
  if (item?.consultationId) return 'consultation';
  return 'system';
}

function resolveNotificationSeverity(item) {
  const fromStored = normalizeString(item?.severity, 20).toLowerCase();
  if (SUPPORTED_NOTIFICATION_SEVERITIES.includes(fromStored)) return fromStored;
  return 'info';
}

function asNotificationInboxItem(item) {
  const notificationType = resolveNotificationType(item);
  const severity = resolveNotificationSeverity(item);
  return {
    id: item.id,
    consultationId: item.consultationId || null,
    referralId: item.referralId || null,
    channel: item.channel,
    notificationType,
    severity,
    eventKey: item.eventKey || null,
    recipient: item.recipient,
    subject: item.subject || '',
    body: item.body || '',
    status: item.status || 'sent',
    sentAt: item.sentAt || item.createdAt || null,
    createdAt: item.createdAt || null,
    readAt: item.readAt || null
  };
}

function sortNotificationsNewestFirst(left, right) {
  const leftMs = Date.parse(left?.createdAt || left?.sentAt || '') || 0;
  const rightMs = Date.parse(right?.createdAt || right?.sentAt || '') || 0;
  return rightMs - leftMs;
}

function listOwnNotifications(db, userId) {
  return db.notificationLogs
    .filter((item) => notificationBelongsToUser(item, userId))
    .sort(sortNotificationsNewestFirst);
}

function summarizeOwnNotifications(items = []) {
  const totalCount = items.length;
  const unread = items.filter((item) => !item.readAt);
  const unreadBySeverity = {
    info: 0,
    warning: 0,
    critical: 0
  };
  for (const item of unread) {
    const severity = resolveNotificationSeverity(item);
    unreadBySeverity[severity] += 1;
  }
  return {
    unreadCount: unread.length,
    totalCount,
    latestCreatedAt: items[0]?.createdAt || items[0]?.sentAt || null,
    latestUnreadCreatedAt: unread[0]?.createdAt || unread[0]?.sentAt || null,
    unreadBySeverity
  };
}

function matchesNotificationFilters(item, filters) {
  if (filters.channel !== 'all' && item.channel !== filters.channel) return false;
  if (filters.type !== 'all' && resolveNotificationType(item) !== filters.type) return false;
  if (filters.severity !== 'all' && resolveNotificationSeverity(item) !== filters.severity) return false;
  if (filters.unreadOnly && item.readAt) return false;
  return true;
}

export function getOwnNotificationInbox(db, userId, options = {}) {
  ensureCollections(db);
  const user = db.users.find((item) => item.id === userId);
  if (!user) {
    const error = new Error('User not found.');
    error.status = 404;
    throw error;
  }

  const filters = normalizeNotificationFilters(options);
  const limit = normalizeNotificationLimit(options.limit);

  const allForUser = listOwnNotifications(db, userId);
  const summary = summarizeOwnNotifications(allForUser);

  const filtered = allForUser.filter((item) => matchesNotificationFilters(item, filters));

  const visibleByType = {
    consultation: 0,
    communication: 0,
    referral: 0,
    account: 0,
    system: 0
  };
  const visibleBySeverity = {
    info: 0,
    warning: 0,
    critical: 0
  };
  let visibleUnreadCount = 0;
  for (const item of filtered.slice(0, limit)) {
    visibleByType[resolveNotificationType(item)] += 1;
    visibleBySeverity[resolveNotificationSeverity(item)] += 1;
    if (!item.readAt) visibleUnreadCount += 1;
  }

  const items = filtered.slice(0, limit).map(asNotificationInboxItem);

  return {
    items,
    meta: {
      unreadCount: summary.unreadCount,
      totalCount: summary.totalCount,
      visibleCount: items.length,
      visibleUnreadCount,
      visibleByType,
      visibleBySeverity,
      appliedFilters: {
        channel: filters.channel,
        type: filters.type,
        severity: filters.severity,
        unreadOnly: filters.unreadOnly,
        limit
      }
    }
  };
}

export function markOwnNotificationsRead(db, userId, payload = {}) {
  ensureCollections(db);
  const user = db.users.find((item) => item.id === userId);
  if (!user) {
    const error = new Error('User not found.');
    error.status = 404;
    throw error;
  }

  const markAll = payload.markAll === true;
  const markFiltered = payload.markFiltered === true;
  const singleId = payload.notificationId ? String(payload.notificationId) : '';
  const manyIds = Array.isArray(payload.notificationIds)
    ? payload.notificationIds.map((item) => String(item)).filter(Boolean)
    : [];
  const targetIds = new Set(singleId ? [singleId, ...manyIds] : manyIds);
  const filterOptions = payload.filters && typeof payload.filters === 'object' ? payload.filters : {};
  const filters = markFiltered
    ? normalizeNotificationFilters({
        channel: filterOptions.channel,
        type: filterOptions.type,
        severity: filterOptions.severity,
        unreadOnly: filterOptions.unreadOnly !== false
      })
    : null;

  if (!markAll && !markFiltered && targetIds.size === 0) {
    const error = new Error('Provide notificationId, notificationIds, markFiltered=true, or markAll=true.');
    error.status = 422;
    throw error;
  }

  const targetNotifications = db.notificationLogs.filter((item) => {
    if (!notificationBelongsToUser(item, userId)) return false;
    if (markAll) return !item.readAt;
    if (markFiltered) return !item.readAt && matchesNotificationFilters(item, filters);
    return targetIds.has(String(item.id || ''));
  });

  if (!markAll && !markFiltered && targetNotifications.length === 0) {
    const error = new Error('No matching notifications found for this user.');
    error.status = 404;
    throw error;
  }

  const readAt = now();
  let updatedCount = 0;
  for (const item of targetNotifications) {
    if (item.readAt) continue;
    item.readAt = readAt;
    item.updatedAt = readAt;
    updatedCount += 1;
  }

  const unreadCount = db.notificationLogs.reduce((count, item) => {
    if (!notificationBelongsToUser(item, userId)) return count;
    return count + (item.readAt ? 0 : 1);
  }, 0);

  return {
    updatedCount,
    unreadCount,
    items: targetNotifications.map(asNotificationInboxItem),
    appliedFilters: markFiltered
      ? {
          channel: filters.channel,
          type: filters.type,
          severity: filters.severity,
          unreadOnly: filters.unreadOnly
        }
      : null
  };
}

export function getOwnNotificationSummary(db, userId) {
  ensureCollections(db);
  const user = db.users.find((item) => item.id === userId);
  if (!user) {
    const error = new Error('User not found.');
    error.status = 404;
    throw error;
  }

  const summary = summarizeOwnNotifications(listOwnNotifications(db, userId));
  return {
    unreadCount: summary.unreadCount,
    totalCount: summary.totalCount,
    hasUnread: summary.unreadCount > 0,
    latestCreatedAt: summary.latestCreatedAt,
    latestUnreadCreatedAt: summary.latestUnreadCreatedAt,
    unreadBySeverity: summary.unreadBySeverity
  };
}

function defaultAccountScreenForRole(role) {
  return role === 'patient' ? 'profile' : 'operations';
}

function recommendedQueuePresetForRole(role) {
  if (role === 'clinician') return 'needs_claim';
  if (role === 'coordinator') return 'live_triage';
  if (role === 'admin') return 'live_triage';
  if (role === 'finance') return 'critical_followup';
  return 'all_queue';
}

function roleExperienceProfile(role) {
  return {
    defaultAccountScreen: defaultAccountScreenForRole(role),
    recommendedQueuePreset: recommendedQueuePresetForRole(role),
    highlightUnreadNotifications: true
  };
}

function currentAccountActionState(user) {
  const state = user?.accountActionState;
  return state && typeof state === 'object' ? state : {};
}

function ensureAccountActionState(user) {
  const existing = currentAccountActionState(user);
  if (user.accountActionState && typeof user.accountActionState === 'object') {
    return user.accountActionState;
  }
  user.accountActionState = { ...existing };
  return user.accountActionState;
}

function normalizeNextActionStatus(value) {
  const status = normalizeString(value, 20).toLowerCase();
  if (!SUPPORTED_NEXT_ACTION_STATUSES.includes(status)) {
    const error = new Error('status must be active, completed, or snoozed.');
    error.status = 422;
    throw error;
  }
  return status;
}

function normalizeSnoozeMinutes(value) {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(parsed) || parsed < 15 || parsed > 10080) {
    const error = new Error('snoozeMinutes must be between 15 and 10080.');
    error.status = 422;
    throw error;
  }
  return parsed;
}

function asPositiveNumber(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return parsed > 0 ? parsed : 0;
}

function actionPriorityWeight(priority) {
  if (priority === 'critical') return 4;
  if (priority === 'high') return 3;
  if (priority === 'medium') return 2;
  return 1;
}

function resolveActionRuntimeState(entry, nowMs) {
  if (!entry || typeof entry !== 'object') {
    return {
      status: 'active',
      isSuppressed: false,
      snoozeUntil: null
    };
  }

  const status = normalizeString(entry.status, 20).toLowerCase();
  if (status === 'completed') {
    return {
      status: 'completed',
      isSuppressed: true,
      snoozeUntil: null
    };
  }

  if (status === 'snoozed') {
    const snoozeUntil = String(entry.snoozeUntil || '');
    const untilMs = Date.parse(snoozeUntil);
    if (Number.isFinite(untilMs) && untilMs > nowMs) {
      return {
        status: 'snoozed',
        isSuppressed: true,
        snoozeUntil
      };
    }
  }

  return {
    status: 'active',
    isSuppressed: false,
    snoozeUntil: null
  };
}

function applyActionStateToNextActions(nextActions, actionState, generatedAt) {
  const nowMs = Date.parse(generatedAt) || Date.now();
  const visible = [];
  let suppressedCount = 0;

  for (const action of nextActions) {
    const runtimeState = resolveActionRuntimeState(actionState[action.id], nowMs);
    if (runtimeState.isSuppressed) {
      suppressedCount += 1;
      continue;
    }
    visible.push({
      ...action,
      userState: {
        status: runtimeState.status,
        snoozeUntil: runtimeState.snoozeUntil,
        isSuppressed: false
      }
    });
  }

  return {
    visible,
    meta: {
      totalCount: nextActions.length,
      visibleCount: visible.length,
      suppressedCount
    }
  };
}

function buildWorkspaceNextActions(role, summary, notificationSummary, options = {}) {
  const actions = [];
  const ids = new Set();

  function addAction(action) {
    if (!action || !action.id || ids.has(action.id)) return;
    ids.add(action.id);
    actions.push({
      id: String(action.id),
      title: String(action.title || 'Review action'),
      detail: String(action.detail || ''),
      priority: action.priority || 'routine',
      view: action.view || null,
      screen: action.screen || null,
      queuePreset: action.queuePreset || null,
      metricKey: action.metricKey || null,
      metricValue: action.metricValue ?? null
    });
  }

  const unreadCount = asPositiveNumber(notificationSummary?.unreadCount);
  const criticalUnread = asPositiveNumber(notificationSummary?.unreadBySeverity?.critical);

  if (criticalUnread > 0) {
    addAction({
      id: 'notifications-critical-unread',
      title: 'Resolve critical alerts',
      detail: 'Prioritize critical unread events before continuing daily operations.',
      priority: 'critical',
      screen: 'notifications',
      metricKey: 'criticalUnread',
      metricValue: criticalUnread
    });
  } else if (unreadCount > 0) {
    addAction({
      id: 'notifications-unread',
      title: 'Triage unread notifications',
      detail: 'Clear unread notifications to keep queue and escalation signals current.',
      priority: 'high',
      screen: 'notifications',
      metricKey: 'unreadCount',
      metricValue: unreadCount
    });
  }

  if (role === 'patient') {
    const pendingConsultations = asPositiveNumber(summary?.pendingConsultations);
    const activeReferrals = asPositiveNumber(summary?.referrals);

    if (pendingConsultations > 0) {
      addAction({
        id: 'patient-followup-pending-consults',
        title: 'Follow up pending consultations',
        detail: 'Check pending consultation progress and respond to requested updates.',
        priority: 'high',
        view: 'consultations',
        queuePreset: 'all_queue',
        metricKey: 'pendingConsultations',
        metricValue: pendingConsultations
      });
    }

    if (activeReferrals > 0) {
      addAction({
        id: 'patient-track-referrals',
        title: 'Track referral journey',
        detail: 'Review referral movement and provider assignment progress.',
        priority: 'medium',
        view: 'referrals',
        metricKey: 'referrals',
        metricValue: activeReferrals
      });
    }
  }

  if (role === 'clinician') {
    const openBroadcasts = asPositiveNumber(summary?.openBroadcasts);
    const inProgressConsultations = asPositiveNumber(summary?.inProgressConsultations);
    const availabilitySummary = options.clinicianAvailabilitySummary || null;

    if (openBroadcasts > 0) {
      addAction({
        id: 'clinician-claim-open-broadcasts',
        title: 'Claim open broadcasts',
        detail: 'Prioritize eligible requests close to claim window expiration.',
        priority: 'high',
        view: 'consultations',
        queuePreset: 'needs_claim',
        metricKey: 'openBroadcasts',
        metricValue: openBroadcasts
      });
    }

    if (inProgressConsultations > 0) {
      addAction({
        id: 'clinician-close-in-progress',
        title: 'Advance active consultations',
        detail: 'Close or escalate in-progress sessions to maintain care continuity.',
        priority: 'medium',
        view: 'consultations',
        queuePreset: 'live_triage',
        metricKey: 'inProgressConsultations',
        metricValue: inProgressConsultations
      });
    }

    if (availabilitySummary && (!availabilitySummary.enabled || availabilitySummary.acceptedTierCount === 0)) {
      addAction({
        id: 'clinician-repair-availability',
        title: 'Repair clinician availability rules',
        detail: 'Enable broadcasts and set accepted tiers to receive assignable consultations.',
        priority: 'critical',
        screen: 'clinician',
        metricKey: 'acceptedTierCount',
        metricValue: availabilitySummary.acceptedTierCount
      });
    }
  }

  if (role === 'coordinator' || role === 'admin') {
    const leads = asPositiveNumber(summary?.leads);
    const unsettledHolds = asPositiveNumber(summary?.unsettledConsultationHolds);
    const consultations = asPositiveNumber(summary?.consultations);

    if (leads > 0) {
      addAction({
        id: `${role}-clear-intake`,
        title: 'Clear intake backlog',
        detail: 'Work pending leads to keep referral conversion cycle times stable.',
        priority: 'high',
        view: 'intake',
        metricKey: 'leads',
        metricValue: leads
      });
    }

    if (consultations > 0) {
      addAction({
        id: `${role}-triage-live-consults`,
        title: 'Triage consultation pressure',
        detail: 'Review in-progress queue for potential bottlenecks and escalations.',
        priority: 'medium',
        view: 'consultations',
        queuePreset: 'live_triage',
        metricKey: 'consultations',
        metricValue: consultations
      });
    }

    if (unsettledHolds > 0) {
      addAction({
        id: `${role}-reconcile-holds`,
        title: 'Reconcile unsettled holds',
        detail: 'Investigate held consultation payments that remain unreconciled.',
        priority: role === 'admin' ? 'high' : 'critical',
        view: 'reports',
        metricKey: 'unsettledConsultationHolds',
        metricValue: unsettledHolds
      });
    }
  }

  if (role === 'finance') {
    const unsettledHolds = asPositiveNumber(summary?.unsettledConsultationHolds);
    const consultations = asPositiveNumber(summary?.consultations);

    if (unsettledHolds > 0) {
      addAction({
        id: 'finance-reconcile-holds',
        title: 'Reconcile unsettled holds',
        detail: 'Resolve outstanding consultation hold exceptions in settlement reports.',
        priority: 'critical',
        view: 'reports',
        metricKey: 'unsettledConsultationHolds',
        metricValue: unsettledHolds
      });
    }

    if (consultations > 0) {
      addAction({
        id: 'finance-monitor-critical-followup',
        title: 'Monitor critical consultation follow-up',
        detail: 'Use critical follow-up queue lens to catch payment-sensitive workloads.',
        priority: 'medium',
        view: 'consultations',
        queuePreset: 'critical_followup',
        metricKey: 'consultations',
        metricValue: consultations
      });
    }
  }

  if (!actions.length) {
    addAction({
      id: 'default-profile-hygiene',
      title: 'Run account hygiene check',
      detail: 'Review profile, security, and communication settings.',
      priority: 'routine',
      screen: 'profile'
    });
  }

  return actions
    .sort((left, right) => actionPriorityWeight(right.priority) - actionPriorityWeight(left.priority))
    .slice(0, 6);
}

export function getOwnAccountWorkspace(db, user, options = {}) {
  ensureCollections(db);
  const dbUser = db.users.find((item) => item.id === user.id);
  if (!dbUser) {
    const error = new Error('User not found.');
    error.status = 404;
    throw error;
  }

  const useCases = accountUseCases(db, dbUser);
  const notificationSummary = getOwnNotificationSummary(db, dbUser.id);
  const notificationPreferences = getOwnNotificationPreferences(db, dbUser.id);
  const includeNotificationInbox = options.includeNotificationInbox === true;
  const generatedAt = now();
  let clinicianAvailabilitySummary = null;
  const actionState = currentAccountActionState(dbUser);
  const workspace = {
    generatedAt,
    role: dbUser.role,
    roleProfile: roleExperienceProfile(dbUser.role),
    useCases,
    notificationSummary,
    notificationPreferences,
    nextActionMeta: {
      totalCount: 0,
      visibleCount: 0,
      suppressedCount: 0
    },
    nextActions: []
  };

  if (includeNotificationInbox) {
    workspace.notificationInbox = getOwnNotificationInbox(db, dbUser.id, {
      channel: options.notificationChannel,
      type: options.notificationType,
      severity: options.notificationSeverity,
      unreadOnly: options.notificationUnreadOnly,
      limit: options.notificationLimit
    });
  }

  if (dbUser.role === 'clinician') {
    const availability = getOwnClinicianAvailability(db, dbUser.id);
    workspace.clinicianAvailability = availability;
    workspace.clinicianAvailabilitySummary = {
      enabled: availability.enabled,
      acceptedTierCount: availability.acceptedTiers.length,
      specialtyCount: availability.specialtyIds.length,
      procedureCount: availability.procedureIds.length
    };
    clinicianAvailabilitySummary = workspace.clinicianAvailabilitySummary;
  }

  const rankedActions = buildWorkspaceNextActions(
    dbUser.role,
    useCases.summary || {},
    notificationSummary,
    { clinicianAvailabilitySummary }
  );

  const actionView = applyActionStateToNextActions(rankedActions, actionState, generatedAt);
  workspace.nextActions = actionView.visible;
  workspace.nextActionMeta = actionView.meta;

  return workspace;
}

export function updateOwnNextActionState(db, userId, payload = {}) {
  ensureCollections(db);
  const user = db.users.find((item) => item.id === userId);
  if (!user) {
    const error = new Error('User not found.');
    error.status = 404;
    throw error;
  }

  const actionId = normalizeString(payload.actionId, 120);
  if (!actionId) {
    const error = new Error('actionId is required.');
    error.status = 422;
    throw error;
  }

  const status = normalizeNextActionStatus(payload.status);
  const useCases = accountUseCases(db, user);
  const notificationSummary = getOwnNotificationSummary(db, user.id);
  let clinicianAvailabilitySummary = null;
  if (user.role === 'clinician') {
    const availability = getOwnClinicianAvailability(db, user.id);
    clinicianAvailabilitySummary = {
      enabled: availability.enabled,
      acceptedTierCount: availability.acceptedTiers.length,
      specialtyCount: availability.specialtyIds.length,
      procedureCount: availability.procedureIds.length
    };
  }

  const rankedActions = buildWorkspaceNextActions(
    user.role,
    useCases.summary || {},
    notificationSummary,
    { clinicianAvailabilitySummary }
  );
  const actionState = ensureAccountActionState(user);
  const candidateIds = new Set(rankedActions.map((item) => item.id));
  const knownAction = candidateIds.has(actionId) || Object.hasOwn(actionState, actionId);
  if (!knownAction) {
    const error = new Error('Next action is not available for this account context.');
    error.status = 404;
    throw error;
  }

  const updatedAt = now();
  if (status === 'active') {
    delete actionState[actionId];
    user.updatedAt = updatedAt;
    return {
      actionId,
      status: 'active',
      snoozeUntil: null,
      updatedAt
    };
  }

  if (status === 'completed') {
    actionState[actionId] = {
      status: 'completed',
      snoozeUntil: null,
      updatedAt
    };
    user.updatedAt = updatedAt;
    return {
      actionId,
      status: 'completed',
      snoozeUntil: null,
      updatedAt
    };
  }

  const snoozeMinutes = normalizeSnoozeMinutes(payload.snoozeMinutes);
  const snoozeUntil = new Date(Date.now() + snoozeMinutes * 60 * 1000).toISOString();
  actionState[actionId] = {
    status: 'snoozed',
    snoozeUntil,
    updatedAt
  };
  user.updatedAt = updatedAt;

  return {
    actionId,
    status: 'snoozed',
    snoozeUntil,
    updatedAt,
    snoozeMinutes
  };
}

function allowedActionsByRole(role) {
  if (role === 'patient') {
    return [
      'create_consultation_request',
      'cancel_own_consultation',
      'view_assigned_clinician_profile',
      'view_own_referrals',
      'update_profile',
      'change_password'
    ];
  }
  if (role === 'clinician') {
    return [
      'claim_consultation',
      'start_consultation',
      'complete_consultation',
      'escalate_consultation_tier',
      'view_assigned_patient_medical_records',
      'record_biometric_hook',
      'update_profile',
      'change_password'
    ];
  }
  if (role === 'coordinator') {
    return [
      'manage_leads_and_referrals',
      'create_consultation_for_patient',
      'cancel_consultation',
      'run_claim_window_sweep',
      'view_operational_metrics',
      'update_profile',
      'change_password'
    ];
  }
  if (role === 'admin') {
    return [
      'full_access',
      'run_claim_window_sweep',
      'manage_users',
      'view_audit_logs',
      'update_profile',
      'change_password'
    ];
  }
  if (role === 'finance') {
    return ['view_payment_holds', 'view_operational_metrics', 'update_profile', 'change_password'];
  }
  return ['update_profile', 'change_password'];
}
