import { assertRole } from '../domain.js';
import {
  cancelConsultation,
  closeConsultationSession,
  claimConsultation,
  completeConsultation,
  consultationOperationalAlerts,
  consultationOperationalSnapshot,
  consultationWorkspaceOverview,
  createConsultation,
  ensureActiveCommunicationLayer,
  ensureConsultationCollections,
  escalateConsultationTier,
  getConsultationCallSessionContext,
  transitionConsultationCallSessionState,
  listBiometricHooks,
  listConsultationClaims,
  listConsultationEvents,
  listConsultationEventsWithOptions,
  listConsultationInteractions,
  listConsultationInteractionsWithOptions,
  listConsultationPatientMedicalRecords,
  listConsultations,
  listConsultationsWithOptions,
  listConsultationSessions,
  openConsultationSession,
  recordConsultationInteraction,
  recordBiometricHook,
  startConsultation,
  switchConsultationCommunicationLayer,
  triggerClaimWindowSweep
} from '../services/consultations.js';

function queryParamsFromRequest(req) {
  try {
    const requestUrl = new URL(req.url || '/', 'http://localhost');
    return requestUrl.searchParams;
  } catch {
    return new URLSearchParams();
  }
}

function csvCell(value) {
  const text = String(value ?? '');
  if (!/[",\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function eventsToCsv(events) {
  const headers = ['at', 'kind', 'message', 'actorId'];
  const rows = events.map((item) => [item.at, item.kind, item.message, item.actorId || '']);
  return [headers.join(',')]
    .concat(rows.map((row) => row.map(csvCell).join(',')))
    .join('\n');
}

function interactionsToCsv(interactions) {
  const headers = ['createdAt', 'channel', 'interactionType', 'marker', 'message', 'createdByRole', 'createdByUserId'];
  const rows = interactions.map((item) => [
    item.createdAt,
    item.channel || '',
    item.interactionType || '',
    item.marker || '',
    item.message || '',
    item.createdByRole || '',
    item.createdByUserId || ''
  ]);
  return [headers.join(',')]
    .concat(rows.map((row) => row.map(csvCell).join(',')))
    .join('\n');
}

export async function handleConsultationRoutes(context) {
  const {
    req,
    res,
    key,
    parts,
    store,
    sendJson,
    requireUser,
    readBody,
    requireFields
  } = context;

  if (key === 'GET /api/v1/consultations') {
    const user = await requireUser(req);
    const db = await store.read();
    ensureConsultationCollections(db);
    const params = queryParamsFromRequest(req);
    const sort = params.get('sort') || undefined;
    const status = params.get('status') || undefined;
    const tier = params.get('tier') || undefined;
    const search = params.get('search') || undefined;
    sendJson(res, 200, { data: listConsultationsWithOptions(db, user, { sort, status, tier, search }) });
    return true;
  }

  if (key === 'GET /api/v1/consultations/workspace') {
    const user = await requireUser(req);
    const db = await store.read();
    ensureConsultationCollections(db);
    const params = queryParamsFromRequest(req);
    const sort = params.get('sort') || undefined;
    const status = params.get('status') || undefined;
    const tier = params.get('tier') || undefined;
    const search = params.get('search') || undefined;
    sendJson(res, 200, { data: consultationWorkspaceOverview(db, user, { sort, status, tier, search }) });
    return true;
  }

  if (key === 'POST /api/v1/consultations') {
    const user = await requireUser(req);
    const body = await readBody(req);
    requireFields(body, ['requestedNeed']);
    await store.update((db) => {
      sendJson(res, 201, { data: createConsultation(db, user, body) });
    });
    return true;
  }

  if (parts[2] === 'consultations' && parts[3] && req.method === 'GET' && parts.length === 4) {
    const user = await requireUser(req);
    const db = await store.read();
    ensureConsultationCollections(db);
    const consultation = listConsultations(db, user).find(
      (item) => item.id === parts[3] || item.consultationNumber === parts[3]
    );
    if (!consultation) {
      const error = new Error('Consultation not found.');
      error.status = 404;
      throw error;
    }
    sendJson(res, 200, { data: consultation });
    return true;
  }

  if (parts[2] === 'consultations' && parts[3] && parts[4] === 'claim' && req.method === 'POST') {
    const user = await requireUser(req);
    await store.update((db) => {
      sendJson(res, 200, { data: claimConsultation(db, user, parts[3]) });
    });
    return true;
  }

  if (parts[2] === 'consultations' && parts[3] && parts[4] === 'start' && req.method === 'POST') {
    const user = await requireUser(req);
    const body = await readBody(req).catch(() => ({}));
    await store.update((db) => {
      const started = startConsultation(db, user, parts[3], body);
      if (body.autoOpenSession || body.channel) {
        ensureActiveCommunicationLayer(db, user, parts[3], body);
      }
      sendJson(res, 200, { data: listConsultations(db, user).find((item) => item.id === started.id) || started });
    });
    return true;
  }

  if (parts[2] === 'consultations' && parts[3] && parts[4] === 'escalate' && req.method === 'POST') {
    const user = await requireUser(req);
    const body = await readBody(req);
    requireFields(body, ['toTier']);
    await store.update((db) => {
      sendJson(res, 200, { data: escalateConsultationTier(db, user, parts[3], body) });
    });
    return true;
  }

  if (parts[2] === 'consultations' && parts[3] && parts[4] === 'complete' && req.method === 'POST') {
    const user = await requireUser(req);
    await store.update((db) => {
      sendJson(res, 200, { data: completeConsultation(db, user, parts[3]) });
    });
    return true;
  }

  if (parts[2] === 'consultations' && parts[3] && parts[4] === 'cancel' && req.method === 'POST') {
    const user = await requireUser(req);
    const body = await readBody(req);
    await store.update((db) => {
      sendJson(res, 200, { data: cancelConsultation(db, user, parts[3], body) });
    });
    return true;
  }

  if (parts[2] === 'consultations' && parts[3] && parts[4] === 'claims' && req.method === 'GET') {
    const user = await requireUser(req);
    const db = await store.read();
    sendJson(res, 200, { data: listConsultationClaims(db, user, parts[3]) });
    return true;
  }

  if (parts[2] === 'consultations' && parts[3] && parts[4] === 'events' && parts[5] === 'export' && req.method === 'GET') {
    const user = await requireUser(req);
    const db = await store.read();
    const params = queryParamsFromRequest(req);
    const kind = params.get('kind') || undefined;
    const limit = params.get('limit') || undefined;
    const format = String(params.get('format') || 'csv').toLowerCase();
    if (!['csv', 'json'].includes(format)) {
      const error = new Error('format must be csv or json.');
      error.status = 422;
      throw error;
    }

    const events = listConsultationEventsWithOptions(db, user, parts[3], { kind, limit });
    const fileName = `${parts[3]}-events.${format}`;
    if (format === 'json') {
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': `attachment; filename="${fileName}"`,
        'cache-control': 'no-store, max-age=0'
      });
      res.end(JSON.stringify(events));
      return true;
    }

    res.writeHead(200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${fileName}"`,
      'cache-control': 'no-store, max-age=0'
    });
    res.end(eventsToCsv(events));
    return true;
  }

  if (parts[2] === 'consultations' && parts[3] && parts[4] === 'events' && req.method === 'GET') {
    const user = await requireUser(req);
    const db = await store.read();
    const params = queryParamsFromRequest(req);
    const kind = params.get('kind') || undefined;
    const limit = params.get('limit') || undefined;
    sendJson(res, 200, { data: listConsultationEventsWithOptions(db, user, parts[3], { kind, limit }) });
    return true;
  }

  if (parts[2] === 'consultations' && parts[3] && parts[4] === 'biometric-hooks') {
    const user = await requireUser(req);
    if (req.method === 'GET') {
      const db = await store.read();
      sendJson(res, 200, { data: listBiometricHooks(db, user, parts[3]) });
      return true;
    }
    if (req.method === 'POST') {
      const body = await readBody(req);
      await store.update((db) => {
        sendJson(res, 201, { data: recordBiometricHook(db, user, parts[3], body) });
      });
      return true;
    }
  }

  if (parts[2] === 'consultations' && parts[3] && parts[4] === 'patient-medical-records' && req.method === 'GET') {
    const user = await requireUser(req);
    const db = await store.read();
    ensureConsultationCollections(db);
    const params = queryParamsFromRequest(req);
    const limit = params.get('limit') || undefined;
    sendJson(res, 200, { data: listConsultationPatientMedicalRecords(db, user, parts[3], { limit }) });
    return true;
  }

  if (parts[2] === 'consultations' && parts[3] && parts[4] === 'ensure-active-layer' && req.method === 'POST') {
    const user = await requireUser(req);
    const body = await readBody(req).catch(() => ({}));
    await store.update((db) => {
      sendJson(res, 200, { data: ensureActiveCommunicationLayer(db, user, parts[3], body) });
    });
    return true;
  }

  if (parts[2] === 'consultations' && parts[3] && parts[4] === 'sessions' && parts[5] && req.method === 'POST') {
    const user = await requireUser(req);
    if (parts[5] === 'switch') {
      const body = await readBody(req).catch(() => ({}));
      await store.update((db) => {
        sendJson(res, 200, { data: switchConsultationCommunicationLayer(db, user, parts[3], body) });
      });
      return true;
    }
    if (parts[5] === 'ensure-active' || parts[5] === 'ensure-active-layer') {
      const body = await readBody(req).catch(() => ({}));
      await store.update((db) => {
        sendJson(res, 200, { data: ensureActiveCommunicationLayer(db, user, parts[3], body) });
      });
      return true;
    }
    if (parts[6] === 'close') {
      const body = await readBody(req);
      await store.update((db) => {
        sendJson(res, 200, { data: closeConsultationSession(db, user, parts[3], parts[5], body) });
      });
      return true;
    }
  }

  if (parts[2] === 'consultations' && parts[3] && parts[4] === 'sessions' && parts[5] && parts[6] === 'call-state' && parts.length === 7) {
    const user = await requireUser(req);
    if (req.method === 'GET') {
      const db = await store.read();
      const { session } = getConsultationCallSessionContext(db, user, parts[3], parts[5]);
      sendJson(res, 200, {
        data: {
          consultationId: parts[3],
          sessionId: parts[5],
          channel: session.channel,
          state: session.callState || 'idle',
          updatedAt: session.callStateUpdatedAt || session.updatedAt,
          reason: session.callStateReason || null,
          history: Array.isArray(session.callStateHistory) ? session.callStateHistory : []
        }
      });
      return true;
    }

    if (req.method === 'POST') {
      const body = await readBody(req).catch(() => ({}));
      await store.update((db) => {
        sendJson(res, 200, {
          data: transitionConsultationCallSessionState(db, user, parts[3], parts[5], body)
        });
      });
      return true;
    }
  }

  if (parts[2] === 'consultations' && parts[3] && parts[4] === 'sessions' && parts[5] && parts[6] === 'interactions') {
    const user = await requireUser(req);
    if (parts[7] === 'export' && req.method === 'GET') {
      const db = await store.read();
      const params = queryParamsFromRequest(req);
      const type = params.get('type') || undefined;
      const actorRole = params.get('actorRole') || undefined;
      const limit = params.get('limit') || undefined;
      const format = String(params.get('format') || 'csv').toLowerCase();
      if (!['csv', 'json'].includes(format)) {
        const error = new Error('format must be csv or json.');
        error.status = 422;
        throw error;
      }

      const interactions = listConsultationInteractionsWithOptions(db, user, parts[3], parts[5], {
        type,
        actorRole,
        limit
      });
      const fileName = `${parts[3]}-${parts[5]}-interactions.${format}`;
      if (format === 'json') {
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'content-disposition': `attachment; filename="${fileName}"`,
          'cache-control': 'no-store, max-age=0'
        });
        res.end(JSON.stringify(interactions));
        return true;
      }

      res.writeHead(200, {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="${fileName}"`,
        'cache-control': 'no-store, max-age=0'
      });
      res.end(interactionsToCsv(interactions));
      return true;
    }

    if (req.method === 'GET') {
      const db = await store.read();
      const params = queryParamsFromRequest(req);
      const type = params.get('type') || undefined;
      const actorRole = params.get('actorRole') || undefined;
      const limit = params.get('limit') || undefined;
      sendJson(res, 200, {
        data: listConsultationInteractionsWithOptions(db, user, parts[3], parts[5], {
          type,
          actorRole,
          limit
        })
      });
      return true;
    }
    if (req.method === 'POST') {
      const body = await readBody(req);
      await store.update((db) => {
        sendJson(res, 201, { data: recordConsultationInteraction(db, user, parts[3], parts[5], body) });
      });
      return true;
    }
  }

  if (parts[2] === 'consultations' && parts[3] && parts[4] === 'sessions' && parts[5] && parts[6] === 'call-config' && parts.length === 7 && req.method === 'GET') {
    const user = await requireUser(req);
    const db = await store.read();
    const { session } = getConsultationCallSessionContext(db, user, parts[3], parts[5]);

    if (typeof context.createCallSignalToken !== 'function' || typeof context.buildCallSignalingUrl !== 'function') {
      const error = new Error('Realtime call signaling is not enabled on this deployment.');
      error.status = 503;
      throw error;
    }

    const signalToken = context.createCallSignalToken({
      consultationId: parts[3],
      sessionId: parts[5],
      userId: user.id,
      role: user.role
    });

    const signalingUrl = context.buildCallSignalingUrl(req, {
      consultationId: parts[3],
      sessionId: parts[5],
      signalToken: signalToken.token
    });

    const iceConfig = typeof context.getCallIceServers === 'function'
      ? context.getCallIceServers({
          consultationId: parts[3],
          sessionId: parts[5],
          userId: user.id,
          role: user.role
        })
      : [];
    const iceServers = Array.isArray(iceConfig)
      ? iceConfig
      : Array.isArray(iceConfig?.iceServers)
        ? iceConfig.iceServers
        : [];
    const turnCredentialExpiresAt = Array.isArray(iceConfig)
      ? null
      : iceConfig?.turnCredentialExpiresAt || null;
    const turnCredentialMode = Array.isArray(iceConfig)
      ? null
      : iceConfig?.turnCredentialMode || null;

    sendJson(res, 200, {
      data: {
        consultationId: parts[3],
        sessionId: parts[5],
        channel: session.channel,
        callState: session.callState || 'idle',
        callStateUpdatedAt: session.callStateUpdatedAt || session.updatedAt,
        callStateReason: session.callStateReason || null,
        selfUserId: user.id,
        signalingUrl,
        signalingTokenExpiresAt: signalToken.expiresAt,
        iceServers,
        turnCredentialMode,
        turnCredentialExpiresAt,
        mediaConstraints: {
          audio: true,
          video: session.channel === 'video_call'
        }
      }
    });
    return true;
  }

  if (parts[2] === 'consultations' && parts[3] && parts[4] === 'sessions' && parts.length === 5) {
    const user = await requireUser(req);
    if (req.method === 'GET') {
      const db = await store.read();
      sendJson(res, 200, { data: listConsultationSessions(db, user, parts[3]) });
      return true;
    }
    if (req.method === 'POST') {
      const body = await readBody(req);
      await store.update((db) => {
        sendJson(res, 201, { data: openConsultationSession(db, user, parts[3], body) });
      });
      return true;
    }
  }

  if (key === 'GET /api/v1/operations/consultation-sla') {
    const user = await requireUser(req);
    assertRole(user, ['admin', 'coordinator', 'finance']);
    const db = await store.read();
    sendJson(res, 200, {
      data: {
        ...consultationOperationalSnapshot(db),
        alerts: consultationOperationalAlerts(db)
      }
    });
    return true;
  }

  if (key === 'POST /api/v1/operations/jobs/release-unclaimed-consultations') {
    const user = await requireUser(req);
    assertRole(user, ['admin', 'coordinator']);
    await store.update((db) => {
      const result = triggerClaimWindowSweep(db, user.id);
      sendJson(res, 200, { data: result });
    });
    return true;
  }

  return false;
}
