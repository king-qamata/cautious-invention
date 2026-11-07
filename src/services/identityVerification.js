import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import nodemailer from 'nodemailer';

const EMAIL_CODE_TTL_MS = 10 * 60 * 1000;
const MAX_CODE_ATTEMPTS = 5;
const MAX_SENDS_PER_HOUR = 4;

function verificationError(message, status = 422) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function codeDigest(challengeId, code) {
  return createHash('sha256').update(`${challengeId}:${code}`).digest();
}

export function createVerificationChallenge(db, user, channel, config, timestamp = new Date().toISOString()) {
  if (!['email', 'sms'].includes(channel)) {
    throw verificationError('Choose email or SMS verification.');
  }
  const destination = channel === 'email' ? user.email : user.phone;
  if (!destination) throw verificationError(`Add a ${channel === 'email' ? 'valid email' : 'phone number'} to verify this account.`);

  const configured = channel === 'email'
    ? config.smtpHost && config.smtpFrom
    : config.twilioAccountSid && config.twilioAuthToken && config.twilioVerifyServiceSid;
  if (!configured) {
    throw verificationError(`${channel === 'email' ? 'Email' : 'SMS'} verification is not configured. Contact the service administrator.`, 503);
  }

  db.verificationChallenges ||= [];
  const recentSends = db.verificationChallenges.filter((item) =>
    item.userId === user.id && new Date(item.createdAt).getTime() > Date.now() - 60 * 60 * 1000
  ).length;
  if (recentSends >= MAX_SENDS_PER_HOUR) {
    throw verificationError('Too many verification messages requested. Try again later.', 429);
  }

  db.verificationChallenges = db.verificationChallenges.filter((item) =>
    !(item.userId === user.id && item.channel === channel && item.status === 'pending')
  );
  const challengeId = randomInt(0, 0x7fffffff).toString(16) + randomInt(0, 0x7fffffff).toString(16);
  const code = channel === 'email' ? String(randomInt(0, 1_000_000)).padStart(6, '0') : null;
  const challenge = {
    id: challengeId,
    userId: user.id,
    channel,
    destination,
    codeDigest: code ? codeDigest(challengeId, code).toString('hex') : null,
    attempts: 0,
    status: 'pending',
    expiresAt: new Date(Date.parse(timestamp) + EMAIL_CODE_TTL_MS).toISOString(),
    createdAt: timestamp
  };
  db.verificationChallenges.push(challenge);
  return { challenge, code };
}

export function verifyEmailCode(challenge, code, timestamp = Date.now()) {
  if (challenge.status !== 'pending' || new Date(challenge.expiresAt).getTime() <= timestamp) return false;
  if (challenge.attempts >= MAX_CODE_ATTEMPTS || !/^\d{6}$/.test(String(code || ''))) return false;
  const expected = Buffer.from(challenge.codeDigest || '', 'hex');
  const actual = codeDigest(challenge.id, String(code));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export async function deliverVerificationCode(challenge, code, config, fetchImpl = fetch) {
  try {
    if (challenge.channel === 'email') {
      const transport = nodemailer.createTransport({
        host: config.smtpHost,
        port: config.smtpPort,
        secure: config.smtpSecure,
        auth: config.smtpUser ? { user: config.smtpUser, pass: config.smtpPassword } : undefined,
        disableFileAccess: true,
        disableUrlAccess: true
      });
      await transport.sendMail({
        from: config.smtpFrom,
        to: challenge.destination,
        subject: 'Mindset Healthcare account verification',
        text: `Your verification code is ${code}. It expires in 10 minutes. If you did not request this, you can ignore this message.`
      });
      return;
    }

    const response = await fetchImpl(
      `https://verify.twilio.com/v2/Services/${encodeURIComponent(config.twilioVerifyServiceSid)}/Verifications`,
      {
        method: 'POST',
        headers: {
          authorization: `Basic ${Buffer.from(`${config.twilioAccountSid}:${config.twilioAuthToken}`).toString('base64')}`,
          'content-type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({ To: challenge.destination, Channel: 'sms' }),
        signal: AbortSignal.timeout(10_000)
      }
    );
    if (!response.ok) throw new Error(`SMS provider returned ${response.status}.`);
  } catch (error) {
    const deliveryError = new Error('Verification message could not be delivered. Try again later.', { cause: error });
    deliveryError.status = 502;
    throw deliveryError;
  }
}

export async function verifySmsCode(challenge, code, config, fetchImpl = fetch) {
  if (challenge.status !== 'pending' || new Date(challenge.expiresAt).getTime() <= Date.now()) return false;
  if (challenge.attempts >= MAX_CODE_ATTEMPTS || !/^\d{4,10}$/.test(String(code || ''))) return false;
  const response = await fetchImpl(
    `https://verify.twilio.com/v2/Services/${encodeURIComponent(config.twilioVerifyServiceSid)}/VerificationCheck`,
    {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${config.twilioAccountSid}:${config.twilioAuthToken}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({ To: challenge.destination, Code: String(code) }),
      signal: AbortSignal.timeout(10_000)
    }
  );
  if (!response.ok) {
    const error = new Error(`SMS verification provider returned ${response.status}.`);
    error.status = 502;
    throw error;
  }
  const result = await response.json();
  return result.status === 'approved';
}

export const verificationLimits = Object.freeze({
  codeAttempts: MAX_CODE_ATTEMPTS,
  sendsPerHour: MAX_SENDS_PER_HOUR
});
