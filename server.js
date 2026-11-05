import { createHmac } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import http from 'node:http';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';

import {
  assertRole,
  hashPassword,
  isEmail,
  makeId,
  makeToken,
  now,
  normalizeEmail,
  normalizeString,
  publicUser,
  seedDatabase,
  verifyPassword
} from './src/domain.js';
import { config } from './src/config.js';
import { buildHealthSnapshot } from './src/health.js';
import { toHttpErrorResponse } from './src/http-errors.js';
import { createCallSignalingHub } from './src/realtime/callSignaling.js';
import { handleAccountRoutes } from './src/routes/accountRoutes.js';
import { handleConsultationRoutes } from './src/routes/consultationRoutes.js';
import { handleLeadReferralRoutes } from './src/routes/leadReferralRoutes.js';
import { handleProviderRoutes } from './src/routes/providerRoutes.js';
import { handleReportRoutes } from './src/routes/reportRoutes.js';
import {
  authorizeConsultationCallSignal,
  consultationOperationalAlerts,
  ensureConsultationCollections,
  recordConsultationCallAuditEvent,
  triggerClaimWindowSweep
} from './src/services/consultations.js';
import { JsonStore } from './src/storage.js';

const publicDir = config.publicDir;
const store = new JsonStore(config.dataFile, seedDatabase());
const loginAttempts = new Map();
const writeAttempts = new Map();
const startedAt = new Date().toISOString();

await mkdir(dirname(config.dataFile), { recursive: true });
await mkdir(config.documentDir, { recursive: true });

async function checkDependencyHealth() {
  try {
    const db = await store.read();
    const dataStore = true;
    const documentDir = await (async () => {
      try {
        await mkdir(config.documentDir, { recursive: true });
        return true;
      } catch {
        return false;
      }
    })();

    ensureConsultationCollections(db);
    const consultationAlerts = consultationOperationalAlerts(db, {
      maxInProgressMinutes: config.maxInProgressMinutes,
      claimConflictThreshold: config.claimConflictThreshold,
      terminalHoldReconciliationGraceMinutes: config.terminalHoldReconciliationGraceMinutes
    });

    const consultationWorkflow = consultationAlerts.every((alert) => alert.severity !== 'critical');
    const paymentIntegrity = consultationAlerts.every((alert) => alert.code !== 'terminal_hold_unreconciled');
    const notificationPipeline = db.notificationLogs.every((item) => ['queued', 'sent', 'delivered'].includes(item.status || 'sent'));

    return {
      dataStore,
      documentDir,
      consultationWorkflow,
      paymentIntegrity,
      notificationPipeline
    };
  } catch {
    return {
      dataStore: false,
      documentDir: false,
      consultationWorkflow: false,
      paymentIntegrity: false,
      notificationPipeline: false
    };
  }
}

function securityHeaders(extra = {}) {
  return {
    'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self' ws: wss:; base-uri 'none'; frame-ancestors 'none'",
    'cross-origin-resource-policy': 'same-origin',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'permissions-policy': 'geolocation=(), microphone=(self), camera=(self)',
    ...extra
  };
}

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon'
};

function requestId() {
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

function startOperationalTimers() {
  if (!config.enableClaimSweepJob) return null;
  const intervalMs = Math.max(5000, Number(config.claimSweepIntervalMs) || 30000);
  const timer = setInterval(async () => {
    try {
      await store.update((db) => {
        triggerClaimWindowSweep(db, 'system_claim_sweeper');
      });
    } catch (error) {
      console.error(`[${new Date().toISOString()}] Claim sweep failed: ${error.message}`);
    }
  }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

function safeTurnIdentitySegment(value, maxLength = 40) {
  return normalizeString(value, maxLength)
    .replace(/[^a-zA-Z0-9_.:-]/g, '_')
    .slice(0, maxLength);
}

function createShortLivedTurnCredential(claims = {}) {
  if (!config.callTurnSharedSecret) return null;
  const ttlSeconds = Math.max(30, Number(config.callTurnCredentialTtlSeconds) || 300);
  const expiresAtUnix = Math.floor(Date.now() / 1000) + ttlSeconds;
  const userSegment = safeTurnIdentitySegment(claims.userId || 'anonymous', 48) || 'anonymous';
  const consultationSegment = safeTurnIdentitySegment(claims.consultationId || 'consultation', 24) || 'consultation';
  const username = `${expiresAtUnix}:${consultationSegment}:${userSegment}`;
  const credential = createHmac('sha1', config.callTurnSharedSecret)
    .update(username)
    .digest('base64');

  return {
    username,
    credential,
    expiresAt: new Date(expiresAtUnix * 1000).toISOString()
  };
}

function callIceServers(claims = {}) {
  const iceServers = [];
  if (Array.isArray(config.callStunUrls) && config.callStunUrls.length) {
    iceServers.push({ urls: config.callStunUrls });
  }

  let turnCredentialExpiresAt = null;
  let turnCredentialMode = null;
  if (Array.isArray(config.callTurnUrls) && config.callTurnUrls.length) {
    const ephemeral = createShortLivedTurnCredential(claims);
    if (ephemeral) {
      iceServers.push({
        urls: config.callTurnUrls,
        username: ephemeral.username,
        credential: ephemeral.credential
      });
      turnCredentialMode = 'ephemeral';
      turnCredentialExpiresAt = ephemeral.expiresAt;
    } else if (config.callTurnUsername && config.callTurnCredential) {
      iceServers.push({
        urls: config.callTurnUrls,
        username: config.callTurnUsername,
        credential: config.callTurnCredential
      });
      turnCredentialMode = 'static';
    }
  }

  return {
    iceServers,
    turnCredentialMode,
    turnCredentialExpiresAt
  };
}

function signalingOrigin(req) {
  if (config.publicBaseUrl) {
    try {
      const url = new URL(config.publicBaseUrl);
      const protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      return `${protocol}//${url.host}`;
    } catch {
      // fall through to forwarded headers
    }
  }

  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  const isSecure = forwardedProto ? forwardedProto === 'https' : Boolean(req.socket.encrypted);
  const protocol = isSecure ? 'wss' : 'ws';
  const forwardedHost = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
  const host = forwardedHost || req.headers.host || `${config.host}:${config.port}`;
  return `${protocol}://${host}`;
}

function isAllowedSignalingOrigin(origin) {
  const normalizedOrigin = normalizeString(origin, 300);
  if (!normalizedOrigin) return true;
  if (config.corsOrigins.includes(normalizedOrigin)) return true;
  if (config.publicBaseUrl) {
    try {
      const publicOrigin = new URL(config.publicBaseUrl).origin;
      if (publicOrigin === normalizedOrigin) return true;
    } catch {
      // Ignore invalid PUBLIC_BASE_URL and fallback to configured CORS origins.
    }
  }
  return false;
}

function corsHeaders(req) {
  const origin = req.headers.origin;
  if (origin && config.corsOrigins.includes(origin)) {
    return {
      'access-control-allow-origin': origin,
      'access-control-allow-headers': 'content-type, authorization',
      'access-control-allow-methods': 'GET, POST, PATCH, OPTIONS',
      'vary': 'Origin'
    };
  }
  return {};
}

function sendJson(res, status, payload, headers = {}) {
  res.writeHead(status, securityHeaders({
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store, max-age=0',
    ...headers
  }));
  res.end(JSON.stringify(payload));
}

function sendError(res, error, id) {
  const errorResponse = toHttpErrorResponse(error, id, config.env);
  sendJson(
    res,
    errorResponse.status,
    errorResponse.payload,
    errorResponse.headers
  );
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > config.maxBodyBytes) {
      const error = new Error('Request body is too large.');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const body = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(body);
  } catch {
    const error = new Error('Request body must be valid JSON.');
    error.status = 400;
    throw error;
  }
}

function routeKey(method, pathname) {
  return `${method} ${pathname}`;
}

function pathParts(pathname) {
  return pathname.split('/').filter(Boolean).map(decodeURIComponent);
}

function requireFields(body, fields) {
  for (const field of fields) {
    if (body[field] === undefined || body[field] === '') {
      const error = new Error(`${field} is required.`);
      error.status = 422;
      throw error;
    }
  }
}

function requireEmail(email) {
  if (!isEmail(email)) {
    const error = new Error('A valid email address is required.');
    error.status = 422;
    throw error;
  }
}

function requirePassword(password) {
  if (String(password || '').length < 8) {
    const error = new Error('Password must be at least 8 characters.');
    error.status = 422;
    throw error;
  }
}

function clientIp(req) {
  return normalizeString(req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || 'unknown', 80);
}

function checkLoginThrottle(req, email) {
  const key = `${clientIp(req)}:${email}`;
  const current = loginAttempts.get(key) || { count: 0, resetAt: Date.now() + config.loginWindowMs };
  if (Date.now() > current.resetAt) {
    loginAttempts.set(key, { count: 0, resetAt: Date.now() + config.loginWindowMs });
    return;
  }
  if (current.count >= config.loginMaxAttempts) {
    const error = new Error('Too many login attempts. Try again later.');
    error.status = 429;
    throw error;
  }
}

function recordLoginAttempt(req, email, ok) {
  const key = `${clientIp(req)}:${email}`;
  if (ok) {
    loginAttempts.delete(key);
    return;
  }
  const current = loginAttempts.get(key) || { count: 0, resetAt: Date.now() + config.loginWindowMs };
  current.count += 1;
  loginAttempts.set(key, current);
}

function checkWriteRate(req) {
  if (!['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) return;
  const key = clientIp(req);
  const current = writeAttempts.get(key) || { count: 0, resetAt: Date.now() + config.writeRateWindowMs };
  if (Date.now() > current.resetAt) {
    writeAttempts.set(key, { count: 1, resetAt: Date.now() + config.writeRateWindowMs });
    return;
  }
  current.count += 1;
  writeAttempts.set(key, current);
  if (current.count > config.writeRateMaxRequests) {
    const error = new Error('Too many write requests. Try again later.');
    error.status = 429;
    error.retryAfterSeconds = Math.ceil((current.resetAt - Date.now()) / 1000);
    throw error;
  }
}

async function currentUser(req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return null;
  const db = await store.read();
  const session = db.sessions.find((item) => item.token === token && new Date(item.expiresAt) > new Date());
  if (!session) return null;
  return db.users.find((user) => user.id === session.userId) || null;
}

function scrubExpiredSessions(db) {
  db.sessions = db.sessions.filter((session) => new Date(session.expiresAt) > new Date());
}

async function requireUser(req) {
  const user = await currentUser(req);
  if (!user) {
    const error = new Error('Authentication required.');
    error.status = 401;
    throw error;
  }
  return user;
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

function notify(db, referral, channel, recipient, subject, body) {
  db.notificationLogs.push({
    id: makeId('notification'),
    referralId: referral?.id || null,
    userId: null,
    channel,
    recipient,
    subject,
    body,
    status: 'sent',
    provider: 'mvp-log',
    providerReference: makeId('delivery'),
    failureReason: null,
    sentAt: now(),
    createdAt: now(),
    updatedAt: now()
  });
}

function expandReferral(db, referral) {
  const patient = db.patients.find((item) => item.id === referral.patientId);
  const provider = db.providers.find((item) => item.id === referral.assignedProviderId);
  const specialty = db.specialties.find((item) => item.id === referral.specialtyId);
  const procedure = db.procedures.find((item) => item.id === referral.procedureId);
  return { ...referral, patient, provider, specialty, procedure };
}

function expandAppointment(db, appointment) {
  const referral = db.referrals.find((item) => item.id === appointment.referralId);
  const provider = db.providers.find((item) => item.id === appointment.providerId);
  const patient = db.patients.find((item) => item.id === appointment.patientId);
  return { ...appointment, referralNumber: referral?.referralNumber, provider, patient };
}

function expandPayment(db, payment) {
  const referral = db.referrals.find((item) => item.id === payment.referralId);
  const patient = db.patients.find((item) => item.id === payment.patientId);
  return { ...payment, referralNumber: referral?.referralNumber, patient };
}

async function handleApi(req, res, url, callSignalingHub) {
  const parts = pathParts(url.pathname);
  const key = routeKey(req.method, url.pathname);

  if (key === 'GET /api/v1/health') {
    const checks = await checkDependencyHealth();
    const snapshot = buildHealthSnapshot({
      status: 'ok',
      startedAt,
      uptimeMs: Date.now() - new Date(startedAt).getTime(),
      checks
    });
    sendJson(res, snapshot.status === 'ok' ? 200 : 503, {
      data: {
        service: 'mindset-healthcare-mvp',
        time: now(),
        ...snapshot
      }
    });
    return;
  }

  if (key === 'GET /api/v1/readiness') {
    const checks = await checkDependencyHealth();
    const ready = checks.dataStore && checks.documentDir;
    sendJson(res, ready ? 200 : 503, {
      data: {
        status: ready ? 'ready' : 'degraded',
        dataFile: config.dataFile,
        time: now(),
        checks
      }
    });
    return;
  }

  if (key === 'POST /api/v1/auth/register') {
    const body = await readBody(req);
    requireFields(body, ['email', 'password', 'firstName', 'lastName']);
    const email = normalizeEmail(body.email);
    requireEmail(email);
    requirePassword(body.password);
    await store.update((db) => {
      scrubExpiredSessions(db);
      if (db.users.some((user) => user.email.toLowerCase() === email)) {
        const error = new Error('Email is already registered.');
        error.status = 409;
        throw error;
      }
      const timestamp = now();
      const user = {
        id: makeId('user'),
        email,
        passwordHash: hashPassword(body.password),
        firstName: normalizeString(body.firstName, 100),
        lastName: normalizeString(body.lastName, 100),
        phone: normalizeString(body.phone, 30),
        role: body.role && ['patient', 'clinician'].includes(body.role) ? body.role : 'patient',
        createdAt: timestamp,
        updatedAt: timestamp
      };
      if (user.role === 'patient') {
        const patient = {
          id: makeId('patient'),
          userId: user.id,
          name: `${user.firstName} ${user.lastName}`,
          email: user.email,
          phone: user.phone,
          city: normalizeString(body.city, 100),
          state: normalizeString(body.state, 100),
          country: normalizeString(body.country || 'Nigeria', 100),
          consentGiven: Boolean(body.consentGiven),
          createdAt: timestamp,
          updatedAt: timestamp
        };
        db.patients.push(patient);
        user.patientId = patient.id;
      }
      db.users.push(user);
      audit(db, user.id, 'registered', 'user', user.id);
      sendJson(res, 201, { data: publicUser(user) });
    });
    return;
  }

  if (key === 'POST /api/v1/auth/login') {
    const body = await readBody(req);
    requireFields(body, ['email', 'password']);
    const email = normalizeEmail(body.email);
    requireEmail(email);
    checkLoginThrottle(req, email);
    await store.update((db) => {
      scrubExpiredSessions(db);
      const user = db.users.find((item) => item.email.toLowerCase() === email);
      if (!user || !verifyPassword(body.password, user.passwordHash)) {
        recordLoginAttempt(req, email, false);
        const error = new Error('Invalid email or password.');
        error.status = 401;
        throw error;
      }
      recordLoginAttempt(req, email, true);
      const token = makeToken();
      const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * config.sessionTtlHours).toISOString();
      db.sessions.push({ token, userId: user.id, expiresAt, createdAt: now() });
      audit(db, user.id, 'logged_in', 'user', user.id);
      sendJson(res, 200, { data: { token, user: publicUser(user) } });
    });
    return;
  }

  if (key === 'POST /api/v1/auth/logout') {
    const user = await requireUser(req);
    const token = (req.headers.authorization || '').slice(7);
    await store.update((db) => {
      db.sessions = db.sessions.filter((session) => session.token !== token);
      audit(db, user.id, 'logged_out', 'user', user.id);
      sendJson(res, 200, { data: { ok: true } });
    });
    return;
  }

  if (key === 'GET /api/v1/me') {
    const user = await requireUser(req);
    sendJson(res, 200, { data: publicUser(user) });
    return;
  }

  if (await handleAccountRoutes({
    req,
    res,
    key,
    store,
    sendJson,
    requireUser,
    readBody,
    requireFields,
    audit,
    ensureConsultationCollections: (db) => {
      db.consultations ||= [];
      db.consultationClaims ||= [];
      db.biometricVerifications ||= [];
    }
  })) {
    return;
  }

  if (await handleConsultationRoutes({
    req,
    res,
    key,
    parts,
    store,
    sendJson,
    requireUser,
    readBody,
    requireFields,
    createCallSignalToken: (claims) => callSignalingHub.issueSignalToken(claims),
    buildCallSignalingUrl: (request, claims) => `${signalingOrigin(request)}${callSignalingHub.signalingPath(claims)}`,
    getCallIceServers: (claims) => callIceServers(claims)
  })) {
    return;
  }

  if (await handleLeadReferralRoutes({
    req,
    res,
    key,
    parts,
    store,
    sendJson,
    requireUser,
    readBody,
    requireFields,
    normalizeEmail,
    config,
    securityHeaders,
    audit,
    notify,
    expandReferral,
    expandAppointment,
    expandPayment
  })) {
    return;
  }

  if (await handleProviderRoutes({
    req,
    res,
    key,
    parts,
    store,
    sendJson,
    requireUser,
    readBody,
    requireFields,
    audit
  })) {
    return;
  }

  if (await handleReportRoutes({
    req,
    res,
    key,
    store,
    sendJson,
    requireUser
  })) {
    return;
  }

  if (key === 'GET /api/v1/catalogue') {
    const db = await store.read();
    sendJson(res, 200, {
      data: {
        specialties: db.specialties,
        procedures: db.procedures,
        providers: db.providers,
        providerProcedures: db.providerProcedures
      }
    });
    return;
  }

  if (key === 'GET /api/v1/admin/export') {
    const user = await requireUser(req);
    assertRole(user, ['admin']);
    const db = await store.read();
    sendJson(res, 200, { data: db });
    return;
  }

  const error = new Error('API route not found.');
  error.status = 404;
  throw error;
}

async function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  const safePath = normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  const filePath = resolve(publicDir, `.${safePath}`);
  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403, securityHeaders({ 'content-type': 'text/plain; charset=utf-8' }));
    res.end('Forbidden');
    return;
  }
  const stream = createReadStream(filePath);
  stream.on('error', () => {
    createReadStream(join(publicDir, 'index.html'))
      .on('error', () => {
        res.writeHead(404, securityHeaders({ 'content-type': 'text/plain; charset=utf-8' }));
        res.end('Not found');
      })
      .pipe(res);
  });
  res.writeHead(200, securityHeaders({ 'content-type': mimeTypes[extname(filePath)] || 'application/octet-stream' }));
  stream.pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const id = requestId();
  const started = Date.now();
  res.setHeader('x-request-id', id);
  res.setHeader('x-response-time-ms', '0');
  for (const [header, value] of Object.entries(corsHeaders(req))) {
    res.setHeader(header, value);
  }
  try {
    checkWriteRate(req);
    if (req.method === 'OPTIONS') {
      res.writeHead(204, securityHeaders(corsHeaders(req)));
      res.end();
    } else if (url.pathname.startsWith('/api/v1/')) {
      await handleApi(req, res, url, callSignalingHub);
    } else {
      await serveStatic(req, res, url);
    }
  } catch (error) {
    sendError(res, error, id);
  } finally {
    const durationMs = Date.now() - started;
    if (!res.headersSent) {
      res.setHeader('x-response-time-ms', String(durationMs));
    }
    console.log(`${new Date().toISOString()} ${id} ${req.method} ${url.pathname} ${res.statusCode} ${durationMs}ms`);
  }
});

const callSignalingHub = createCallSignalingHub({
  server,
  tokenTtlSeconds: config.callSignalTokenTtlSeconds,
  isOriginAllowed: isAllowedSignalingOrigin,
  authorizeMessage: async (payload) => {
    const db = await store.read();
    return authorizeConsultationCallSignal(db, payload);
  },
  onAuditEvent: async (event) => {
    await store.update((db) => {
      recordConsultationCallAuditEvent(db, event);
    });
  },
  rateLimit: {
    peerWindowMs: config.callSignalPeerRateWindowMs,
    peerMax: config.callSignalPeerRateMax,
    roomWindowMs: config.callSignalRoomRateWindowMs,
    roomMax: config.callSignalRoomRateMax
  }
});

server.keepAliveTimeout = 15 * 1000;
server.headersTimeout = 16 * 1000;

const claimSweepTimer = startOperationalTimers();

server.on('error', (error) => {
  console.error(`[${new Date().toISOString()}] Server failed: ${error.message}`);
  process.exitCode = 1;
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`[${new Date().toISOString()}] Shutdown signal received: ${signal}`);
    if (claimSweepTimer) clearInterval(claimSweepTimer);
    callSignalingHub.close();
    server.close(() => process.exit(0));
  });
}

server.listen(config.port, config.host, () => {
  console.log(`[${new Date().toISOString()}] Mindset Healthcare MVP running at http://${config.host}:${config.port}`);
});
