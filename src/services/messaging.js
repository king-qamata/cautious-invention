import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const TELEGRAM_LINK_TTL_MS = 15 * 60 * 1000;
const MAX_DELIVERY_ATTEMPTS = 5;

function messagingError(message, status = 422) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function configured(channel, config) {
  if (channel === 'whatsapp') {
    return Boolean(
      config.whatsappAccessToken &&
      config.whatsappPhoneNumberId &&
      config.whatsappTemplateName
    );
  }
  if (channel === 'telegram') return Boolean(config.telegramBotToken);
  return false;
}

export function notificationChannelConfiguration(config) {
  return {
    whatsapp: configured('whatsapp', config),
    telegram: configured('telegram', config)
  };
}

export function createTelegramLink(db, user, config, timestamp = Date.now()) {
  if (!config.telegramBotToken || !config.telegramBotUsername) {
    throw messagingError('Telegram linking is not configured.', 503);
  }

  db.telegramLinkTokens ||= [];
  db.telegramLinkTokens = db.telegramLinkTokens.filter((item) =>
    item.userId !== user.id && Date.parse(item.expiresAt) > timestamp
  );
  const token = randomBytes(32).toString('base64url');
  const tokenHash = createHash('sha256').update(token).digest('hex');
  db.telegramLinkTokens.push({
    userId: user.id,
    tokenHash,
    expiresAt: new Date(timestamp + TELEGRAM_LINK_TTL_MS).toISOString(),
    createdAt: new Date(timestamp).toISOString()
  });

  return {
    deepLink: `https://t.me/${encodeURIComponent(config.telegramBotUsername)}?start=${encodeURIComponent(token)}`,
    expiresAt: new Date(timestamp + TELEGRAM_LINK_TTL_MS).toISOString()
  };
}

export function consumeTelegramLink(db, update, timestamp = Date.now()) {
  const message = update?.message;
  const text = String(message?.text || '');
  const match = text.match(/^\/start\s+([A-Za-z0-9_-]{32,100})$/);
  const chatId = message?.chat?.id;
  if (
    !match ||
    (typeof chatId !== 'number' && typeof chatId !== 'string') ||
    (message.chat.type && message.chat.type !== 'private') ||
    (message.from?.id !== undefined && String(message.from.id) !== String(chatId))
  ) return false;

  const tokenHash = createHash('sha256').update(match[1]).digest('hex');
  const challengeIndex = (db.telegramLinkTokens || []).findIndex((item) => {
    const storedHash = Buffer.from(item.tokenHash || '', 'hex');
    const candidateHash = Buffer.from(tokenHash, 'hex');
    return storedHash.length === candidateHash.length &&
      timingSafeEqual(storedHash, candidateHash) &&
      Date.parse(item.expiresAt) > timestamp;
  });
  if (challengeIndex < 0) return false;

  const [challenge] = db.telegramLinkTokens.splice(challengeIndex, 1);
  const user = db.users.find((item) => item.id === challenge.userId);
  if (!user) return false;
  user.telegramChatId = String(chatId);
  user.updatedAt = new Date(timestamp).toISOString();
  return true;
}

export async function deliverExternalNotification(notification, config, fetchImpl = fetch) {
  if (notification.channel === 'whatsapp') {
    const response = await fetchImpl(
      `https://graph.facebook.com/${encodeURIComponent(config.whatsappApiVersion)}/${encodeURIComponent(config.whatsappPhoneNumberId)}/messages`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.whatsappAccessToken}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: notification.recipient,
          type: 'template',
          template: {
            name: config.whatsappTemplateName,
            language: { code: config.whatsappTemplateLanguage || 'en' },
            components: [{
              type: 'body',
              parameters: [
                { type: 'text', text: String(notification.subject || '').slice(0, 1024) },
                { type: 'text', text: String(notification.body || '').slice(0, 1024) }
              ]
            }]
          }
        }),
        signal: AbortSignal.timeout(10_000)
      }
    );
    if (!response.ok) throw new Error(`WhatsApp provider returned ${response.status}.`);
    const result = await response.json();
    return { providerReference: result.messages?.[0]?.id || null };
  }

  if (notification.channel === 'telegram') {
    const response = await fetchImpl(
      `https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: notification.recipient,
          text: `${notification.subject}\n${notification.body}`.slice(0, 4096)
        }),
        signal: AbortSignal.timeout(10_000)
      }
    );
    const result = await response.json();
    if (!response.ok || result.ok !== true) {
      throw new Error(`Telegram provider returned ${response.status}.`);
    }
    return { providerReference: result.result?.message_id ? String(result.result.message_id) : null };
  }

  throw messagingError(`Unsupported external notification channel: ${notification.channel}`);
}

function retryDelayMs(attempts) {
  return Math.min(60 * 60 * 1000, 30_000 * (2 ** Math.max(0, attempts - 1)));
}

export async function deliverNextNotification(store, config, fetchImpl = fetch, timestamp = Date.now()) {
  const snapshot = await store.read();
  const hasEligibleDelivery = snapshot.notificationLogs?.some((entry) =>
    ['whatsapp', 'telegram'].includes(entry.channel) &&
    configured(entry.channel, config) &&
    (
      (
        entry.status === 'queued' &&
        (!entry.nextAttemptAt || Date.parse(entry.nextAttemptAt) <= timestamp) &&
        Number(entry.deliveryAttempts || 0) < MAX_DELIVERY_ATTEMPTS
      ) ||
      (
        entry.status === 'processing' &&
        Date.parse(entry.deliveryStartedAt || '') < timestamp - 2 * 60 * 1000
      )
    )
  );
  if (!hasEligibleDelivery) return false;

  const claim = await store.update((db) => {
    db.notificationLogs ||= [];
    for (const entry of db.notificationLogs) {
      if (
        entry.status === 'processing' &&
        Date.parse(entry.deliveryStartedAt || '') < timestamp - 2 * 60 * 1000
      ) {
        if (Number(entry.deliveryAttempts || 0) >= MAX_DELIVERY_ATTEMPTS) {
          entry.status = 'failed';
          entry.failureReason = 'Delivery interrupted after maximum attempts.';
        } else {
          entry.status = 'queued';
          entry.nextAttemptAt = new Date(timestamp).toISOString();
        }
      }
    }
    const item = db.notificationLogs.find((entry) =>
      ['whatsapp', 'telegram'].includes(entry.channel) &&
      entry.status === 'queued' &&
      (!entry.nextAttemptAt || Date.parse(entry.nextAttemptAt) <= timestamp) &&
      Number(entry.deliveryAttempts || 0) < MAX_DELIVERY_ATTEMPTS &&
      configured(entry.channel, config)
    );
    if (!item) return null;

    item.status = 'processing';
    item.deliveryAttempts = Number(item.deliveryAttempts || 0) + 1;
    item.deliveryStartedAt = new Date(timestamp).toISOString();
    item.updatedAt = item.deliveryStartedAt;
    return structuredClone(item);
  });
  if (!claim) return false;

  try {
    const result = await deliverExternalNotification(claim, config, fetchImpl);
    await store.update((db) => {
      const item = db.notificationLogs.find((entry) => entry.id === claim.id);
      if (!item || item.status !== 'processing') return;
      item.status = 'delivered';
      item.provider = claim.channel === 'whatsapp' ? 'whatsapp-cloud-api' : 'telegram-bot-api';
      item.providerReference = result.providerReference;
      item.deliveredAt = new Date().toISOString();
      item.failureReason = null;
      item.updatedAt = item.deliveredAt;
    });
  } catch (error) {
    await store.update((db) => {
      const item = db.notificationLogs.find((entry) => entry.id === claim.id);
      if (!item || item.status !== 'processing') return;
      const attempts = Number(item.deliveryAttempts || 1);
      item.status = attempts >= MAX_DELIVERY_ATTEMPTS ? 'failed' : 'queued';
      item.nextAttemptAt = attempts >= MAX_DELIVERY_ATTEMPTS
        ? null
        : new Date(Date.now() + retryDelayMs(attempts)).toISOString();
      item.failureReason = String(error.message || 'Provider delivery failed.').slice(0, 240);
      item.updatedAt = new Date().toISOString();
    });
    return true;
  }
  return true;
}

export function validTelegramWebhookSecret(received, expected) {
  if (!expected || typeof received !== 'string') return false;
  const actual = Buffer.from(received);
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}
