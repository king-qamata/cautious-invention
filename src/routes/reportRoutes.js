import { assertRole, canViewReferral, funnelStages } from '../domain.js';
import { getOwnAccountWorkspace } from '../services/accounts.js';
import {
  consultationOperationalAlerts,
  consultationOperationalSnapshot,
  consultationWorkspaceOverview,
  listConsultationInteractionsWithOptions,
  listConsultationSessions
} from '../services/consultations.js';

const INTERACTION_TYPE_FILTERS = new Set([
  'patient_message',
  'clinician_message',
  'session_marker',
  'clinical_note'
]);

function byStatus(items = []) {
  return items.reduce((acc, item) => ({ ...acc, [item.status]: (acc[item.status] || 0) + 1 }), {});
}

function parseReportRange(requestUrl) {
  const from = requestUrl.searchParams.get('from');
  const to = requestUrl.searchParams.get('to');
  if (!from && !to) return null;

  const parseDay = (value, endOfDay = false) => {
    if (!value) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return NaN;
    const date = new Date(`${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`);
    return date.toISOString().slice(0, 10) === value ? date.getTime() : NaN;
  };
  const start = parseDay(from);
  const end = parseDay(to, true);
  if (!Number.isFinite(start ?? 0) || !Number.isFinite(end ?? 0) || (start !== null && end !== null && start > end)) {
    const error = new Error('Report dates must be valid calendar dates with the start on or before the end.');
    error.status = 422;
    throw error;
  }
  if (start !== null && end !== null && end - start > 1000 * 60 * 60 * 24 * 730) {
    const error = new Error('Report date range cannot exceed 730 days.');
    error.status = 422;
    throw error;
  }
  return { from: start, to: end };
}

function inReportRange(item, range) {
  const timestamp = new Date(item.createdAt).getTime();
  if (!Number.isFinite(timestamp)) return false;
  return (range.from === null || timestamp >= range.from) && (range.to === null || timestamp <= range.to);
}

function groupCounts(items, keyFor) {
  const counts = new Map();
  for (const item of items) {
    const key = String(keyFor(item) || 'unknown');
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const visible = groups.filter(([, count]) => count >= 5).map(([key, count]) => ({ key, count }));
  return { groups: visible, suppressedGroups: groups.length - visible.length };
}

function getLeadCareType(lead) {
  const match = /^Care type: (physical|mental|both)\b/i.exec(lead.healthcareRequirement || '');
  return match?.[1].toLowerCase() || 'unknown';
}

function buildReportSummary(sourceDb, range) {
  const db = range ? {
    ...sourceDb,
    leads: sourceDb.leads.filter((item) => inReportRange(item, range)),
    referrals: sourceDb.referrals.filter((item) => inReportRange(item, range)),
    appointments: sourceDb.appointments.filter((item) => inReportRange(item, range)),
    payments: sourceDb.payments.filter((item) => inReportRange(item, range)),
    consultations: sourceDb.consultations.filter((item) => inReportRange(item, range)),
    notificationLogs: sourceDb.notificationLogs.filter((item) => inReportRange(item, range))
  } : sourceDb;
  const stale = db.referrals.filter((referral) => {
    if (['closed', 'cancelled'].includes(referral.status)) return false;
    return Date.now() - new Date(referral.updatedAt).getTime() > 1000 * 60 * 60 * 24 * 3;
  });
  const convertedLeads = db.leads.filter((lead) => lead.status !== 'new' && lead.status !== 'contacted').length;
  const screenedLeads = db.leads.filter((lead) => funnelStages.indexOf(lead.funnelStage || 'application') >= funnelStages.indexOf('screening')).length;
  const funnel = Object.fromEntries(funnelStages.map((stage) => [stage, db.leads.filter((lead) => funnelStages.indexOf(lead.funnelStage || 'application') >= funnelStages.indexOf(stage)).length]));
  const urgency = Object.fromEntries(['normal', 'priority', 'super_priority'].map((tier) => [tier, db.leads.filter((lead) => (lead.preferredUrgency || 'normal') === tier).length]));
  const completedReferrals = db.referrals.filter((referral) => referral.status === 'closed').length;
  const turnaroundSamples = db.referrals
    .filter((referral) => ['closed', 'service_completed'].includes(referral.status))
    .map((referral) => (new Date(referral.updatedAt).getTime() - new Date(referral.createdAt).getTime()) / 86400000)
    .filter((days) => Number.isFinite(days) && days >= 0);
  const averageTurnaroundDays = turnaroundSamples.length
    ? Math.round((turnaroundSamples.reduce((sum, days) => sum + days, 0) / turnaroundSamples.length) * 10) / 10
    : 0;
  const monthly = new Map();
  for (const item of [...db.leads, ...db.referrals]) {
    const month = String(item.createdAt || '').slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(month)) continue;
    const counts = monthly.get(month) || { month, leads: 0, referrals: 0 };
    counts[item.referralNumber ? 'referrals' : 'leads'] += 1;
    monthly.set(month, counts);
  }

  return {
    leads: {
      total: db.leads.length,
      byStatus: byStatus(db.leads),
      byChannel: byStatus(db.leads.map((lead) => ({ status: lead.channel || 'unknown' }))),
      converted: convertedLeads,
      conversionRate: db.leads.length ? Math.round((convertedLeads / db.leads.length) * 1000) / 10 : 0,
      screened: screenedLeads,
      funnel,
      preferredUrgency: urgency
    },
    referrals: {
      total: db.referrals.length,
      byStatus: byStatus(db.referrals),
      stale: stale.length,
      completed: completedReferrals,
      averageTurnaroundDays
    },
    providers: {
      total: db.providers.length,
      active: db.providers.filter((item) => item.isActive).length,
      trained: db.providers.filter((item) => item.trainingStatus === 'trained').length
    },
    appointments: { total: db.appointments.length, scheduled: db.appointments.filter((item) => item.status === 'scheduled').length },
    payments: {
      total: db.payments.length,
      amount: db.payments.reduce((sum, item) => sum + Number(item.amount || 0), 0),
      unreconciled: db.payments.filter((item) => item.reconciliationStatus === 'unreconciled').length
    },
    consultations: consultationOperationalSnapshot(db),
    operationalAlerts: consultationOperationalAlerts(db),
    notifications: { total: db.notificationLogs.length },
    advanced: {
      period: range ? {
        from: range.from === null ? null : new Date(range.from).toISOString().slice(0, 10),
        to: range.to === null ? null : new Date(range.to).toISOString().slice(0, 10)
      } : null,
      monthly: [...monthly.values()].sort((a, b) => a.month.localeCompare(b.month)),
      leadsByCountry: groupCounts(db.leads, (lead) => lead.country),
      leadsByCareType: groupCounts(db.leads, getLeadCareType),
      referralsByProvider: groupCounts(db.referrals.filter((item) => item.assignedProviderId), (item) => {
        return sourceDb.providers.find((provider) => provider.id === item.assignedProviderId)?.name;
      })
    }
  };
}

function buildConsultationCommsBootstrap(db, user, consultationWorkspace, options = {}) {
  const consultations = Array.isArray(consultationWorkspace?.consultations)
    ? consultationWorkspace.consultations
    : [];
  const firstConsultation = consultations[0] || null;
  if (!firstConsultation) return null;

  const sessions = listConsultationSessions(db, user, firstConsultation.id);
  const preferredSession = sessions.find((item) => item.status === 'active') || sessions[sessions.length - 1] || null;

  const type = String(options.interactionType || '').toLowerCase();
  const actorRole = String(options.interactionActorRole || '').toLowerCase();
  const rawLimit = Number.parseInt(String(options.interactionLimit || ''), 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? String(Math.min(rawLimit, 200)) : '';

  const interactionQuery = new URLSearchParams();
  if (INTERACTION_TYPE_FILTERS.has(type)) {
    interactionQuery.set('type', type);
  }
  if (actorRole && actorRole !== 'all') {
    interactionQuery.set('actorRole', actorRole);
  }
  if (limit) {
    interactionQuery.set('limit', limit);
  }

  let interactions = [];
  if (preferredSession) {
    interactions = listConsultationInteractionsWithOptions(db, user, firstConsultation.id, preferredSession.id, {
      type: INTERACTION_TYPE_FILTERS.has(type) ? type : undefined,
      actorRole: actorRole && actorRole !== 'all' ? actorRole : undefined,
      limit: limit || undefined
    });
  }

  return {
    consultationId: firstConsultation.id,
    sessionId: preferredSession?.id || null,
    sessions,
    interactions,
    interactionQuery: interactionQuery.toString(),
    generatedAt: new Date().toISOString()
  };
}

export async function handleReportRoutes(context) {
  const {
    req,
    res,
    key,
    store,
    sendJson,
    requireUser,
    expandReferral
  } = context;

  if (key === 'GET /api/v1/operations/logs') {
    const user = await requireUser(req);
    assertRole(user, ['admin', 'coordinator', 'finance']);
    const db = await store.read();
    sendJson(res, 200, {
      data: {
        notifications: db.notificationLogs.slice(-25).reverse(),
        audit: db.auditLogs.slice(-25).reverse()
      }
    });
    return true;
  }

  if (key === 'GET /api/v1/reports/summary') {
    const user = await requireUser(req);
    assertRole(user, ['admin', 'coordinator', 'finance']);
    const db = await store.read();
    const requestUrl = new URL(req.url || '/api/v1/reports/summary', 'http://localhost');
    const range = parseReportRange(requestUrl);
    sendJson(res, 200, { data: buildReportSummary(db, range) });
    return true;
  }

  if (key === 'GET /api/v1/operations/workspace') {
    const user = await requireUser(req);
    const requestUrl = new URL(req.url || '/api/v1/operations/workspace', 'http://localhost');
    const includeConsultationsParam = String(requestUrl.searchParams.get('includeConsultations') || '').toLowerCase();
    const includeConsultations = includeConsultationsParam === '1' || includeConsultationsParam === 'true';
    const includeConsultationCommsParam = String(requestUrl.searchParams.get('includeConsultationComms') || '').toLowerCase();
    const includeConsultationComms = includeConsultationCommsParam === '1' || includeConsultationCommsParam === 'true';
    const includeAccountWorkspaceParam = String(requestUrl.searchParams.get('includeAccountWorkspace') || '').toLowerCase();
    const includeAccountWorkspace = includeAccountWorkspaceParam === '1' || includeAccountWorkspaceParam === 'true';
    const accountInboxUnreadOnlyParam = String(requestUrl.searchParams.get('accountNotificationUnreadOnly') || '').toLowerCase();
    const accountNotificationUnreadOnly = accountInboxUnreadOnlyParam === '1' || accountInboxUnreadOnlyParam === 'true';
    const db = await store.read();
    const canViewLeads = ['admin', 'coordinator'].includes(user.role);
    const canViewReports = ['admin', 'coordinator', 'finance'].includes(user.role);
    const referrals = db.referrals
      .filter((referral) => canViewReferral(user, referral))
      .map((referral) => expandReferral(db, referral));
    const consultationWorkspace = includeConsultations
      ? consultationWorkspaceOverview(db, user, {
        sort: requestUrl.searchParams.get('consultationSort') || 'recent',
        status: requestUrl.searchParams.get('consultationStatus') || 'all',
        tier: requestUrl.searchParams.get('consultationTier') || 'all',
        search: requestUrl.searchParams.get('consultationSearch') || ''
      })
      : null;
    const consultationCommsBootstrap = includeConsultations && includeConsultationComms
      ? buildConsultationCommsBootstrap(db, user, consultationWorkspace, {
        interactionType: requestUrl.searchParams.get('interactionType') || '',
        interactionActorRole: requestUrl.searchParams.get('interactionActorRole') || '',
        interactionLimit: requestUrl.searchParams.get('interactionLimit') || ''
      })
      : null;
    const accountWorkspace = includeAccountWorkspace
      ? getOwnAccountWorkspace(db, user, {
        includeNotificationInbox: true,
        notificationChannel: requestUrl.searchParams.get('accountNotificationChannel') || 'all',
        notificationType: requestUrl.searchParams.get('accountNotificationType') || 'all',
        notificationSeverity: requestUrl.searchParams.get('accountNotificationSeverity') || 'all',
        notificationUnreadOnly: accountNotificationUnreadOnly,
        notificationLimit: requestUrl.searchParams.get('accountNotificationLimit') || '50'
      })
      : null;

    sendJson(res, 200, {
      data: {
        generatedAt: new Date().toISOString(),
        role: user.role,
        capabilities: {
          canViewLeads,
          canViewReports
        },
        leads: canViewLeads ? db.leads : [],
        referrals,
        providers: db.providers,
        reportSummary: canViewReports ? buildReportSummary(db) : null,
        consultationWorkspace,
        consultationCommsBootstrap,
        accountWorkspace
      }
    });
    return true;
  }

  return false;
}
