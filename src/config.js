import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = fileURLToPath(new URL('..', import.meta.url));
const isVercel = process.env.VERCEL === '1';
const vercelWritableDir = '/tmp/mindset-healthcare';

function numberEnv(name, fallback) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isFinite(value)) return fallback;
  return value;
}

function stringListEnv(name, fallback = []) {
  return (process.env[name] || fallback.join(','))
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function stringEnv(name, fallback = '') {
  const value = String(process.env[name] || fallback).trim();
  return value;
}

export const config = {
  env: process.env.NODE_ENV || 'development',
  host: process.env.HOST || '127.0.0.1',
  port: numberEnv('PORT', 3000),
  publicDir: resolve(rootDir, process.env.PUBLIC_DIR || 'public'),
  dataFile: resolve(rootDir, process.env.DATA_FILE || (isVercel ? `${vercelWritableDir}/mindset.json` : 'data/mindset.json')),
  documentDir: resolve(rootDir, process.env.DOCUMENT_DIR || (isVercel ? `${vercelWritableDir}/documents` : 'data/documents')),
  sessionTtlHours: numberEnv('SESSION_TTL_HOURS', 168),
  maxBodyBytes: numberEnv('MAX_BODY_BYTES', 1024 * 1024),
  loginWindowMs: numberEnv('LOGIN_WINDOW_MS', 15 * 60 * 1000),
  loginMaxAttempts: numberEnv('LOGIN_MAX_ATTEMPTS', 8),
  writeRateWindowMs: numberEnv('WRITE_RATE_WINDOW_MS', 60 * 1000),
  writeRateMaxRequests: numberEnv('WRITE_RATE_MAX_REQUESTS', 30),
  maxInProgressMinutes: numberEnv('MAX_IN_PROGRESS_MINUTES', 120),
  claimConflictThreshold: numberEnv('CLAIM_CONFLICT_THRESHOLD', 5),
  terminalHoldReconciliationGraceMinutes: numberEnv('TERMINAL_HOLD_RECONCILIATION_GRACE_MINUTES', 30),
  claimSweepIntervalMs: numberEnv('CLAIM_SWEEP_INTERVAL_MS', 30 * 1000),
  enableClaimSweepJob: String(process.env.ENABLE_CLAIM_SWEEP_JOB || 'true').toLowerCase() !== 'false',
  corsOrigins: stringListEnv('CORS_ORIGINS', ['http://127.0.0.1:3000', 'http://localhost:3000']),
  publicBaseUrl: stringEnv('PUBLIC_BASE_URL', ''),
  callSignalTokenTtlSeconds: numberEnv('CALL_SIGNAL_TOKEN_TTL_SECONDS', 180),
  callSignalPeerRateWindowMs: numberEnv('CALL_SIGNAL_PEER_RATE_WINDOW_MS', 10 * 1000),
  callSignalPeerRateMax: numberEnv('CALL_SIGNAL_PEER_RATE_MAX', 160),
  callSignalRoomRateWindowMs: numberEnv('CALL_SIGNAL_ROOM_RATE_WINDOW_MS', 10 * 1000),
  callSignalRoomRateMax: numberEnv('CALL_SIGNAL_ROOM_RATE_MAX', 320),
  callStunUrls: stringListEnv('CALL_STUN_URLS', ['stun:stun.l.google.com:19302']),
  callTurnUrls: stringListEnv('CALL_TURN_URLS', []),
  callTurnCredentialTtlSeconds: numberEnv('CALL_TURN_CREDENTIAL_TTL_SECONDS', 300),
  callTurnSharedSecret: stringEnv('CALL_TURN_SHARED_SECRET', ''),
  callTurnUsername: stringEnv('CALL_TURN_USERNAME', ''),
  callTurnCredential: stringEnv('CALL_TURN_CREDENTIAL', ''),
  smtpHost: stringEnv('SMTP_HOST', ''),
  smtpPort: numberEnv('SMTP_PORT', 465),
  smtpSecure: String(process.env.SMTP_SECURE || 'true').toLowerCase() !== 'false',
  smtpUser: stringEnv('SMTP_USER', ''),
  smtpPassword: stringEnv('SMTP_PASSWORD', ''),
  smtpFrom: stringEnv('SMTP_FROM', ''),
  twilioAccountSid: stringEnv('TWILIO_ACCOUNT_SID', ''),
  twilioAuthToken: stringEnv('TWILIO_AUTH_TOKEN', ''),
  twilioVerifyServiceSid: stringEnv('TWILIO_VERIFY_SERVICE_SID', ''),
  paystackSecretKey: stringEnv('PAYSTACK_SECRET_KEY', ''),
  paystackWebhookSecret: stringEnv('PAYSTACK_WEBHOOK_SECRET', ''),
  paystackBaseUrl: stringEnv('PAYSTACK_BASE_URL', 'https://api.paystack.co'),
  paystackCallbackUrl: stringEnv('PAYSTACK_CALLBACK_URL', ''),
  whatsappAccessToken: stringEnv('WHATSAPP_ACCESS_TOKEN', ''),
  whatsappPhoneNumberId: stringEnv('WHATSAPP_PHONE_NUMBER_ID', ''),
  whatsappApiVersion: stringEnv('WHATSAPP_API_VERSION', 'v22.0'),
  whatsappTemplateName: stringEnv('WHATSAPP_TEMPLATE_NAME', ''),
  whatsappTemplateLanguage: stringEnv('WHATSAPP_TEMPLATE_LANGUAGE', 'en'),
  telegramBotToken: stringEnv('TELEGRAM_BOT_TOKEN', ''),
  telegramBotUsername: stringEnv('TELEGRAM_BOT_USERNAME', ''),
  telegramWebhookSecret: stringEnv('TELEGRAM_WEBHOOK_SECRET', ''),
  notificationDeliveryIntervalMs: numberEnv('NOTIFICATION_DELIVERY_INTERVAL_MS', 2000)
};
