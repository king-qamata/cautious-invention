import {
  hashPassword,
  makeId,
  makeToken,
  normalizeEmail,
  normalizeString,
  publicUser,
  verifyPassword
} from '../domain.js';
import {
  createVerificationChallenge,
  deliverVerificationCode,
  verifyEmailCode,
  verifySmsCode,
  verificationLimits
} from '../services/identityVerification.js';

function routeError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

export async function handleAuthRoutes(context) {
  const {
    req,
    res,
    key,
    store,
    sendJson,
    readBody,
    requireFields,
    requireEmail,
    requirePassword,
    recordLoginAttempt,
    checkLoginThrottle,
    audit,
    config,
    now,
    deliverCode = deliverVerificationCode,
    verifySms = verifySmsCode
  } = context;

  if (key === 'POST /api/v1/auth/register') {
    const body = await readBody(req);
    requireFields(body, ['email', 'password', 'firstName', 'lastName']);
    if (body.role !== undefined && body.role !== 'patient') {
      throw routeError('Public account registration is for patients only. Submit the appropriate onboarding application.', 422);
    }
    if (!body.consentGiven) {
      throw routeError('Consent is required before creating an account.', 422);
    }
    const email = normalizeEmail(body.email);
    requireEmail(email);
    requirePassword(body.password);
    const channel = body.verificationChannel || 'email';
    if (!['email', 'sms'].includes(channel)) throw routeError('Choose email or SMS verification.', 422);
    if (channel === 'sms' && !normalizeString(body.phone, 30)) throw routeError('A phone number is required for SMS verification.', 422);

    const user = await store.update((db) => {
      db.verificationChallenges ||= [];
      if (db.users.some((item) => item.email.toLowerCase() === email)) {
        throw routeError('Email is already registered.', 409);
      }
      const timestamp = now();
      const createdUser = {
        id: makeId('user'),
        email,
        passwordHash: hashPassword(body.password),
        firstName: normalizeString(body.firstName, 100),
        lastName: normalizeString(body.lastName, 100),
        phone: normalizeString(body.phone, 30),
        role: 'patient',
        verifiedAt: null,
        createdAt: timestamp,
        updatedAt: timestamp
      };
      const patient = {
        id: makeId('patient'),
        userId: createdUser.id,
        name: `${createdUser.firstName} ${createdUser.lastName}`,
        email: createdUser.email,
        phone: createdUser.phone,
        city: normalizeString(body.city, 100),
        state: normalizeString(body.state, 100),
        country: normalizeString(body.country || 'Nigeria', 100),
        consentGiven: true,
        createdAt: timestamp,
        updatedAt: timestamp
      };
      createdUser.patientId = patient.id;
      db.patients.push(patient);
      db.users.push(createdUser);
      audit(db, createdUser.id, 'registered_pending_verification', 'user', createdUser.id);
      return createdUser;
    });

    const delivery = await store.update((db) => createVerificationChallenge(db, user, channel, config, now()));
    await deliverCode(delivery.challenge, delivery.code, config);
    sendJson(res, 201, {
      data: {
        user: publicUser(user),
        verification: { channel, expiresAt: delivery.challenge.expiresAt }
      }
    });
    return true;
  }

  if (key === 'POST /api/v1/auth/verification/start') {
    const body = await readBody(req);
    requireFields(body, ['email', 'channel']);
    const email = normalizeEmail(body.email);
    requireEmail(email);
    if (!['email', 'sms'].includes(body.channel)) throw routeError('Choose email or SMS verification.', 422);

    const user = (await store.read()).users.find((item) => item.email.toLowerCase() === email);
    if (user && user.verifiedAt === null) {
      const delivery = await store.update((db) => {
        const freshUser = db.users.find((item) => item.id === user.id);
        if (!freshUser || freshUser.verifiedAt !== null) return null;
        return createVerificationChallenge(db, freshUser, body.channel, config, now());
      });
      if (delivery) await deliverCode(delivery.challenge, delivery.code, config);
    }
    sendJson(res, 202, { data: { message: 'If the account is awaiting verification, a message has been sent to the selected contact.' } });
    return true;
  }

  if (key === 'POST /api/v1/auth/verification/confirm') {
    const body = await readBody(req);
    requireFields(body, ['email', 'channel', 'code']);
    const email = normalizeEmail(body.email);
    requireEmail(email);
    if (!['email', 'sms'].includes(body.channel)) throw routeError('Choose email or SMS verification.', 422);

    const db = await store.read();
    const user = db.users.find((item) => item.email.toLowerCase() === email);
    const challenge = user && db.verificationChallenges
      ?.filter((item) => item.userId === user.id && item.channel === body.channel && item.status === 'pending')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (!user || user.verifiedAt !== null || !challenge) {
      throw routeError('Verification code is invalid or expired. Request a new code.', 422);
    }

    const valid = body.channel === 'email'
      ? verifyEmailCode(challenge, body.code)
      : await verifySms(challenge, body.code, config);
    const result = await store.update((freshDb) => {
      const freshUser = freshDb.users.find((item) => item.id === user.id);
      const freshChallenge = freshDb.verificationChallenges?.find((item) => item.id === challenge.id);
      if (!freshUser || freshUser.verifiedAt !== null || !freshChallenge || freshChallenge.status !== 'pending') {
        throw routeError('Verification code is invalid or expired. Request a new code.', 422);
      }

      if (!valid) {
        freshChallenge.attempts += 1;
        if (freshChallenge.attempts >= verificationLimits.codeAttempts) freshChallenge.status = 'locked';
        return false;
      }

      const timestamp = now();
      freshChallenge.status = 'verified';
      freshChallenge.verifiedAt = timestamp;
      freshUser.verifiedAt = timestamp;
      freshUser.verificationChannel = body.channel;
      if (body.channel === 'email') freshUser.emailVerifiedAt = timestamp;
      else freshUser.phoneVerifiedAt = timestamp;
      freshUser.updatedAt = timestamp;
      for (const other of freshDb.verificationChallenges || []) {
        if (other.userId === freshUser.id && other.status === 'pending') other.status = 'superseded';
      }
      audit(freshDb, freshUser.id, 'verified_contact', 'user', freshUser.id, { channel: body.channel });
      return true;
    });

    if (!result) throw routeError('Verification code is invalid or expired. Request a new code.', 422);
    sendJson(res, 200, { data: { verified: true } });
    return true;
  }

  if (key === 'POST /api/v1/auth/login') {
    const body = await readBody(req);
    requireFields(body, ['email', 'password']);
    const email = normalizeEmail(body.email);
    requireEmail(email);
    checkLoginThrottle(req, email);
    await store.update((db) => {
      const user = db.users.find((item) => item.email.toLowerCase() === email);
      if (!user || !verifyPassword(body.password, user.passwordHash)) {
        recordLoginAttempt(req, email, false);
        throw routeError('Invalid email or password.', 401);
      }
      if (user.verifiedAt === null) {
        throw routeError('Verify your account before signing in.', 403);
      }
      recordLoginAttempt(req, email, true);
      const token = makeToken();
      const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * config.sessionTtlHours).toISOString();
      db.sessions.push({ token, userId: user.id, expiresAt, createdAt: now() });
      audit(db, user.id, 'logged_in', 'user', user.id);
      sendJson(res, 200, { data: { token, user: publicUser(user) } });
    });
    return true;
  }

  return false;
}
