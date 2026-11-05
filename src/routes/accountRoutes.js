import {
  accountUseCases,
  changeOwnPassword,
  getOwnAccountWorkspace,
  getOwnClinicianAvailability,
  getOwnNotificationInbox,
  getOwnNotificationPreferences,
  getOwnNotificationSummary,
  markOwnNotificationsRead,
  updateOwnNextActionState,
  updateOwnClinicianAvailability,
  updateOwnNotificationPreferences,
  updateOwnProfile
} from '../services/accounts.js';

export async function handleAccountRoutes(context) {
  const {
    req,
    res,
    key,
    store,
    sendJson,
    requireUser,
    readBody,
    requireFields,
    audit,
    ensureConsultationCollections
  } = context;

  if (key === 'GET /api/v1/account/use-cases') {
    const user = await requireUser(req);
    const db = await store.read();
    ensureConsultationCollections(db);
    sendJson(res, 200, { data: accountUseCases(db, user) });
    return true;
  }

  if (key === 'GET /api/v1/account/workspace') {
    const user = await requireUser(req);
    const requestUrl = new URL(req.url || '/api/v1/account/workspace', 'http://localhost');
    const includeInboxParam = String(requestUrl.searchParams.get('includeInbox') || '').toLowerCase();
    const includeNotificationInbox = includeInboxParam === '1' || includeInboxParam === 'true';
    const unreadOnlyParam = String(requestUrl.searchParams.get('unreadOnly') || '').toLowerCase();
    const notificationUnreadOnly = unreadOnlyParam === '1' || unreadOnlyParam === 'true';
    const db = await store.read();
    ensureConsultationCollections(db);
    sendJson(res, 200, {
      data: getOwnAccountWorkspace(db, user, {
        includeNotificationInbox,
        notificationChannel: requestUrl.searchParams.get('channel') || 'all',
        notificationType: requestUrl.searchParams.get('type') || 'all',
        notificationSeverity: requestUrl.searchParams.get('severity') || 'all',
        notificationUnreadOnly,
        notificationLimit: requestUrl.searchParams.get('limit') || '50'
      })
    });
    return true;
  }

  if (key === 'PATCH /api/v1/account/profile') {
    const user = await requireUser(req);
    const body = await readBody(req);
    await store.update((db) => {
      const profile = updateOwnProfile(db, user.id, body);
      audit(db, user.id, 'updated_profile', 'user', user.id);
      sendJson(res, 200, { data: profile });
    });
    return true;
  }

  if (key === 'POST /api/v1/account/change-password') {
    const user = await requireUser(req);
    const body = await readBody(req);
    requireFields(body, ['currentPassword', 'newPassword']);
    await store.update((db) => {
      const result = changeOwnPassword(db, user.id, body);
      db.sessions = db.sessions.filter((session) => session.userId !== user.id);
      audit(db, user.id, 'changed_password', 'user', user.id);
      sendJson(res, 200, { data: result });
    });
    return true;
  }

  if (key === 'GET /api/v1/account/clinician-availability') {
    const user = await requireUser(req);
    const db = await store.read();
    sendJson(res, 200, { data: getOwnClinicianAvailability(db, user.id) });
    return true;
  }

  if (key === 'PATCH /api/v1/account/clinician-availability') {
    const user = await requireUser(req);
    const body = await readBody(req);
    await store.update((db) => {
      const availability = updateOwnClinicianAvailability(db, user.id, body);
      audit(db, user.id, 'updated_clinician_availability', 'user', user.id);
      sendJson(res, 200, { data: availability });
    });
    return true;
  }

  if (key === 'GET /api/v1/account/notification-preferences') {
    const user = await requireUser(req);
    const db = await store.read();
    sendJson(res, 200, { data: getOwnNotificationPreferences(db, user.id) });
    return true;
  }

  if (key === 'PATCH /api/v1/account/notification-preferences') {
    const user = await requireUser(req);
    const body = await readBody(req);
    await store.update((db) => {
      const preferences = updateOwnNotificationPreferences(db, user.id, body);
      audit(db, user.id, 'updated_notification_preferences', 'user', user.id);
      sendJson(res, 200, { data: preferences });
    });
    return true;
  }

  if (key === 'GET /api/v1/account/notifications') {
    const user = await requireUser(req);
    const requestUrl = new URL(req.url || '/api/v1/account/notifications', 'http://localhost');
    const unreadOnlyParam = String(requestUrl.searchParams.get('unreadOnly') || '').toLowerCase();
    const unreadOnly = unreadOnlyParam === '1' || unreadOnlyParam === 'true';
    const channel = requestUrl.searchParams.get('channel') || 'all';
    const type = requestUrl.searchParams.get('type') || 'all';
    const severity = requestUrl.searchParams.get('severity') || 'all';
    const limit = requestUrl.searchParams.get('limit') || '50';
    const db = await store.read();
    sendJson(res, 200, {
      data: getOwnNotificationInbox(db, user.id, {
        channel,
        type,
        severity,
        unreadOnly,
        limit
      })
    });
    return true;
  }

  if (key === 'GET /api/v1/account/notifications/summary') {
    const user = await requireUser(req);
    const db = await store.read();
    sendJson(res, 200, { data: getOwnNotificationSummary(db, user.id) });
    return true;
  }

  if (key === 'POST /api/v1/account/notifications/read') {
    const user = await requireUser(req);
    const body = await readBody(req);
    await store.update((db) => {
      const result = markOwnNotificationsRead(db, user.id, body);
      audit(db, user.id, 'marked_notifications_read', 'user', user.id);
      sendJson(res, 200, { data: result });
    });
    return true;
  }

  if (key === 'POST /api/v1/account/next-actions/state') {
    const user = await requireUser(req);
    const body = await readBody(req);
    await store.update((db) => {
      ensureConsultationCollections(db);
      const result = updateOwnNextActionState(db, user.id, body);
      const workspace = getOwnAccountWorkspace(db, user);
      audit(db, user.id, 'updated_account_next_action_state', 'user', user.id, {
        actionId: result.actionId,
        status: result.status
      });
      sendJson(res, 200, { data: { result, workspace } });
    });
    return true;
  }

  return false;
}
