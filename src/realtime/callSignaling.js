import { WebSocketServer } from 'ws';

import { makeToken, now, normalizeString } from '../domain.js';

const MAX_SIGNAL_BYTES = 64 * 1024;
const MAX_SIGNAL_PAYLOAD_BYTES = 48 * 1024;
const SOCKET_OPEN_STATE = 1;
const MAX_ROOM_PEERS = 4;
const DEFAULT_RATE_LIMIT = {
  peerWindowMs: 10 * 1000,
  peerMax: 160,
  roomWindowMs: 10 * 1000,
  roomMax: 320
};

const ALLOWED_SIGNAL_TYPES = new Set([
  'offer',
  'answer',
  'ice_candidate',
  'hangup',
  'media_state',
  'ping'
]);

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function roomKey(consultationId, sessionId) {
  return `${consultationId}:${sessionId}`;
}

function serializablePeer(peer) {
  return {
    userId: peer.userId,
    role: peer.role,
    connectedAt: peer.connectedAt
  };
}

function ensureObjectPayload(payload) {
  if (payload === undefined) return {};
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) return payload;
  const error = new Error('Signal payload must be an object.');
  error.status = 422;
  throw error;
}

function validateSignalEnvelope(message) {
  const allowedKeys = new Set(['type', 'targetUserId', 'payload']);
  for (const key of Object.keys(message)) {
    if (!allowedKeys.has(key)) {
      const error = new Error(`Unsupported signaling field: ${key}.`);
      error.status = 422;
      throw error;
    }
  }

  if (typeof message.type !== 'string') {
    const error = new Error('Signal type is required.');
    error.status = 422;
    throw error;
  }

  if (message.targetUserId !== undefined && typeof message.targetUserId !== 'string') {
    const error = new Error('targetUserId must be a string when provided.');
    error.status = 422;
    throw error;
  }

  ensureObjectPayload(message.payload);
}

function applyRateLimit(counters, key, windowMs, maxCount) {
  const nowMs = Date.now();
  const record = counters.get(key) || { count: 0, resetAtMs: nowMs + windowMs };
  if (nowMs > record.resetAtMs) {
    record.count = 0;
    record.resetAtMs = nowMs + windowMs;
  }

  record.count += 1;
  counters.set(key, record);
  return record.count <= maxCount;
}

export function createCallSignalingHub({
  server,
  tokenTtlSeconds = 180,
  authorizeMessage = null,
  onAuditEvent = null,
  isOriginAllowed = null,
  rateLimit = {}
} = {}) {
  const wss = new WebSocketServer({ noServer: true });
  const rooms = new Map();
  const signalTokens = new Map();
  const peerRateCounters = new Map();
  const roomRateCounters = new Map();
  const limits = {
    peerWindowMs: Math.max(1000, Number(rateLimit.peerWindowMs) || DEFAULT_RATE_LIMIT.peerWindowMs),
    peerMax: Math.max(10, Number(rateLimit.peerMax) || DEFAULT_RATE_LIMIT.peerMax),
    roomWindowMs: Math.max(1000, Number(rateLimit.roomWindowMs) || DEFAULT_RATE_LIMIT.roomWindowMs),
    roomMax: Math.max(20, Number(rateLimit.roomMax) || DEFAULT_RATE_LIMIT.roomMax)
  };

  async function emitAuditEvent(payload) {
    if (typeof onAuditEvent !== 'function') return;
    try {
      await onAuditEvent(payload);
    } catch {
      // Keep signaling path resilient when background audit persistence fails.
    }
  }

  function pruneExpiredSignalTokens() {
    const nowMs = Date.now();
    for (const [token, payload] of signalTokens.entries()) {
      if (payload.expiresAtMs <= nowMs) signalTokens.delete(token);
    }
  }

  function issueSignalToken({ consultationId, sessionId, userId, role }) {
    pruneExpiredSignalTokens();
    const token = makeToken();
    const ttlMs = Math.max(30, Number(tokenTtlSeconds) || 180) * 1000;
    const expiresAtMs = Date.now() + ttlMs;
    const payload = {
      consultationId,
      sessionId,
      userId,
      role,
      expiresAtMs
    };
    signalTokens.set(token, payload);
    return {
      token,
      expiresAt: new Date(expiresAtMs).toISOString()
    };
  }

  function consumeSignalToken(token, consultationId, sessionId) {
    pruneExpiredSignalTokens();
    const payload = signalTokens.get(token);
    if (!payload) return null;
    if (payload.consultationId !== consultationId || payload.sessionId !== sessionId) return null;
    signalTokens.delete(token);
    return payload;
  }

  function send(ws, payload) {
    if (ws.readyState !== SOCKET_OPEN_STATE) return;
    ws.send(JSON.stringify(payload));
  }

  function broadcast(room, payload, exceptWs = null) {
    for (const peer of room.values()) {
      if (exceptWs && peer.ws === exceptWs) continue;
      send(peer.ws, payload);
    }
  }

  function getOrCreateRoom(consultationId, sessionId) {
    const key = roomKey(consultationId, sessionId);
    if (!rooms.has(key)) rooms.set(key, new Map());
    return rooms.get(key);
  }

  function removePeer(consultationId, sessionId, ws) {
    const key = roomKey(consultationId, sessionId);
    const room = rooms.get(key);
    if (!room) return;

    let removed = null;
    for (const [peerId, peer] of room.entries()) {
      if (peer.ws === ws) {
        removed = { peerId, peer };
        room.delete(peerId);
        break;
      }
    }

    if (!removed) return;

    peerRateCounters.delete(removed.peerId);
    emitAuditEvent({
      consultationId,
      sessionId,
      marker: 'participant_left',
      userId: removed.peer.userId,
      role: removed.peer.role,
      reason: 'socket_closed',
      metadata: {
        peerId: removed.peerId
      }
    });

    if (room.size === 0) {
      rooms.delete(key);
      roomRateCounters.delete(key);
      return;
    }

    broadcast(room, {
      type: 'peer_left',
      peer: serializablePeer(removed.peer),
      at: now()
    });
  }

  function sanitizeSignalPayload(signalType, payload) {
    const candidate = ensureObjectPayload(payload);
    const encoded = JSON.stringify(candidate);
    if (Buffer.byteLength(encoded, 'utf8') > MAX_SIGNAL_PAYLOAD_BYTES) {
      const error = new Error('Signal payload is too large.');
      error.status = 413;
      throw error;
    }

    if (signalType === 'offer' || signalType === 'answer') {
      const description = candidate.description && typeof candidate.description === 'object'
        ? candidate.description
        : candidate;
      if (!description || typeof description.sdp !== 'string' || typeof description.type !== 'string') {
        const error = new Error('Session description payload is required.');
        error.status = 422;
        throw error;
      }
      if (description.type !== signalType) {
        const error = new Error(`Session description type must be ${signalType}.`);
        error.status = 422;
        throw error;
      }
      if (description.sdp.length > 40000) {
        const error = new Error('Session description is too large.');
        error.status = 413;
        throw error;
      }
    }

    if (signalType === 'ice_candidate') {
      const ice = candidate.candidate && typeof candidate.candidate === 'object'
        ? candidate.candidate
        : candidate;
      if (!ice || typeof ice.candidate !== 'string') {
        const error = new Error('ICE candidate payload is required.');
        error.status = 422;
        throw error;
      }
      if (ice.candidate.length > 2000) {
        const error = new Error('ICE candidate payload is too large.');
        error.status = 413;
        throw error;
      }
    }

    if (signalType === 'hangup') {
      const reason = normalizeString(candidate.reason, 120);
      return {
        ...candidate,
        reason: reason || 'peer_hangup'
      };
    }

    if (signalType === 'media_state') {
      if (candidate.audioMuted !== undefined && typeof candidate.audioMuted !== 'boolean') {
        const error = new Error('media_state.audioMuted must be a boolean.');
        error.status = 422;
        throw error;
      }
      if (candidate.cameraEnabled !== undefined && typeof candidate.cameraEnabled !== 'boolean') {
        const error = new Error('media_state.cameraEnabled must be a boolean.');
        error.status = 422;
        throw error;
      }
      if (candidate.permissionRecovered !== undefined && typeof candidate.permissionRecovered !== 'boolean') {
        const error = new Error('media_state.permissionRecovered must be a boolean.');
        error.status = 422;
        throw error;
      }
    }

    return candidate;
  }

  async function handleSignalMessage(peer, room, message) {
    validateSignalEnvelope(message);

    const signalType = normalizeString(message.type, 40).toLowerCase();
    if (!ALLOWED_SIGNAL_TYPES.has(signalType)) {
      send(peer.ws, { type: 'signal_error', error: 'Unsupported signal type.' });
      return;
    }

    const key = roomKey(peer.consultationId, peer.sessionId);
    if (!applyRateLimit(peerRateCounters, peer.id, limits.peerWindowMs, limits.peerMax)) {
      send(peer.ws, { type: 'signal_error', error: 'Rate limit exceeded for signaling messages.' });
      await emitAuditEvent({
        consultationId: peer.consultationId,
        sessionId: peer.sessionId,
        marker: 'rate_limited',
        userId: peer.userId,
        role: peer.role,
        reason: 'peer_rate_limit_exceeded',
        metadata: { signalType }
      });
      return;
    }
    if (!applyRateLimit(roomRateCounters, key, limits.roomWindowMs, limits.roomMax)) {
      send(peer.ws, { type: 'signal_error', error: 'Room signaling rate limit exceeded.' });
      await emitAuditEvent({
        consultationId: peer.consultationId,
        sessionId: peer.sessionId,
        marker: 'rate_limited',
        userId: peer.userId,
        role: peer.role,
        reason: 'room_rate_limit_exceeded',
        metadata: { signalType }
      });
      return;
    }

    if (signalType === 'ping') {
      send(peer.ws, { type: 'pong', at: now() });
      return;
    }

    let targetUserId = normalizeString(message.targetUserId, 120) || null;

    if (typeof authorizeMessage === 'function') {
      const decision = await authorizeMessage({
        consultationId: peer.consultationId,
        sessionId: peer.sessionId,
        fromUserId: peer.userId,
        fromRole: peer.role,
        targetUserId,
        signalType
      });

      if (!decision || decision.ok !== true) {
        send(peer.ws, { type: 'signal_error', error: decision?.error || 'Signal authorization failed.' });
        await emitAuditEvent({
          consultationId: peer.consultationId,
          sessionId: peer.sessionId,
          marker: 'authorization_blocked',
          userId: peer.userId,
          role: peer.role,
          reason: decision?.error || 'authorization_failed',
          metadata: { signalType, targetUserId }
        });
        return;
      }

      if (decision.targetUserId) {
        targetUserId = normalizeString(decision.targetUserId, 120) || targetUserId;
      }
    }

    if (!targetUserId && ['offer', 'answer', 'ice_candidate', 'hangup', 'media_state'].includes(signalType)) {
      send(peer.ws, { type: 'signal_error', error: `targetUserId is required for ${signalType} signals.` });
      return;
    }

    let payload;
    try {
      payload = sanitizeSignalPayload(signalType, message.payload || {});
    } catch (error) {
      send(peer.ws, { type: 'signal_error', error: error.message || 'Invalid signal payload.' });
      return;
    }

    const envelope = {
      type: 'signal',
      signalType,
      from: serializablePeer(peer),
      toUserId: targetUserId,
      payload,
      at: now()
    };

    let relayedCount = 0;
    for (const item of room.values()) {
      if (item.ws === peer.ws) continue;
      if (targetUserId && item.userId !== targetUserId) continue;
      send(item.ws, envelope);
      relayedCount += 1;
    }

    if (targetUserId && relayedCount === 0) {
      send(peer.ws, { type: 'signal_error', error: 'Target participant is not connected to this call room.' });
    }

    if (signalType === 'offer') {
      await emitAuditEvent({
        consultationId: peer.consultationId,
        sessionId: peer.sessionId,
        marker: 'offer_sent',
        userId: peer.userId,
        role: peer.role,
        reason: 'offer_relayed',
        metadata: { targetUserId, relayedCount }
      });
    } else if (signalType === 'answer') {
      await emitAuditEvent({
        consultationId: peer.consultationId,
        sessionId: peer.sessionId,
        marker: 'answer_sent',
        userId: peer.userId,
        role: peer.role,
        reason: 'answer_relayed',
        metadata: { targetUserId, relayedCount }
      });
    } else if (signalType === 'hangup') {
      await emitAuditEvent({
        consultationId: peer.consultationId,
        sessionId: peer.sessionId,
        marker: 'ended',
        userId: peer.userId,
        role: peer.role,
        reason: payload.reason || 'peer_hangup',
        metadata: { targetUserId }
      });
    }
  }

  wss.on('connection', async (ws, req, auth) => {
    const peerId = makeToken();
    const peer = {
      id: peerId,
      ws,
      consultationId: auth.consultationId,
      sessionId: auth.sessionId,
      userId: auth.userId,
      role: auth.role,
      connectedAt: now()
    };

    const room = getOrCreateRoom(peer.consultationId, peer.sessionId);
    if (room.size >= MAX_ROOM_PEERS) {
      ws.close(1013, 'Call room is at capacity');
      return;
    }

    room.set(peerId, peer);
    await emitAuditEvent({
      consultationId: peer.consultationId,
      sessionId: peer.sessionId,
      marker: 'participant_joined',
      userId: peer.userId,
      role: peer.role,
      reason: 'socket_connected',
      metadata: {
        peerId,
        roomSize: room.size
      }
    });

    send(ws, {
      type: 'room_state',
      peers: [...room.values()]
        .filter((item) => item.ws !== ws)
        .map(serializablePeer),
      self: serializablePeer(peer),
      at: now()
    });

    broadcast(room, {
      type: 'peer_joined',
      peer: serializablePeer(peer),
      at: now()
    }, ws);

    ws.on('message', async (raw, isBinary) => {
      if (isBinary) {
        send(ws, { type: 'signal_error', error: 'Binary frames are not supported.' });
        return;
      }

      if (Buffer.byteLength(raw) > MAX_SIGNAL_BYTES) {
        ws.close(1009, 'Payload too large');
        return;
      }

      const parsed = safeJsonParse(raw.toString());
      if (!parsed || typeof parsed !== 'object') {
        send(ws, { type: 'signal_error', error: 'Signal payload must be valid JSON.' });
        return;
      }

      try {
        await handleSignalMessage(peer, room, parsed);
      } catch (error) {
        send(ws, { type: 'signal_error', error: error?.message || 'Signal handling failed.' });
      }
    });

    ws.on('close', () => {
      removePeer(peer.consultationId, peer.sessionId, ws);
    });

    ws.on('error', () => {
      removePeer(peer.consultationId, peer.sessionId, ws);
    });
  });

  function tryHandleUpgrade(req, socket, head) {
    try {
      const requestUrl = new URL(req.url || '/', 'http://localhost');
      const parts = requestUrl.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      const isSignalRoute =
        parts[0] === 'api' &&
        parts[1] === 'v1' &&
        parts[2] === 'realtime' &&
        parts[3] === 'consultations' &&
        Boolean(parts[4]) &&
        parts[5] === 'sessions' &&
        Boolean(parts[6]);

      if (!isSignalRoute) return false;

      const requestOrigin = normalizeString(req.headers.origin, 300);
      if (typeof isOriginAllowed === 'function' && !isOriginAllowed(requestOrigin)) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return true;
      }

      const consultationId = parts[4];
      const sessionId = parts[6];
      const signalToken = normalizeString(requestUrl.searchParams.get('signalToken'), 300);
      if (!signalToken) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return true;
      }

      const validated = consumeSignalToken(signalToken, consultationId, sessionId);
      if (!validated) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return true;
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req, validated);
      });
      return true;
    } catch {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return true;
    }
  }

  function signalingPath({ consultationId, sessionId, signalToken }) {
    return `/api/v1/realtime/consultations/${encodeURIComponent(consultationId)}/sessions/${encodeURIComponent(sessionId)}?signalToken=${encodeURIComponent(signalToken)}`;
  }

  function close() {
    for (const room of rooms.values()) {
      for (const peer of room.values()) {
        try {
          peer.ws.close(1001, 'Server shutdown');
        } catch {
          // ignore close errors during shutdown
        }
      }
    }
    rooms.clear();
    signalTokens.clear();
    peerRateCounters.clear();
    roomRateCounters.clear();
    wss.close();
  }

  server.on('upgrade', (req, socket, head) => {
    const handled = tryHandleUpgrade(req, socket, head);
    if (!handled) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
    }
  });

  return {
    issueSignalToken,
    signalingPath,
    close
  };
}
