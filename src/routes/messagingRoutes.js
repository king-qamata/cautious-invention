import {
  consumeTelegramLink,
  createTelegramLink,
  validTelegramWebhookSecret
} from '../services/messaging.js';

function routeError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

export async function handleMessagingRoutes(context) {
  const { req, res, key, store, sendJson, requireUser, readBody, config } = context;

  if (key === 'POST /api/v1/account/telegram/link') {
    const user = await requireUser(req);
    const result = await store.update((db) => createTelegramLink(db, user, config));
    sendJson(res, 201, { data: result });
    return true;
  }

  if (key === 'DELETE /api/v1/account/telegram/link') {
    const user = await requireUser(req);
    await store.update((db) => {
      const current = db.users.find((item) => item.id === user.id);
      if (current) {
        delete current.telegramChatId;
        current.updatedAt = new Date().toISOString();
      }
      db.telegramLinkTokens = (db.telegramLinkTokens || []).filter((item) => item.userId !== user.id);
    });
    sendJson(res, 200, { data: { linked: false } });
    return true;
  }

  if (key === 'POST /api/v1/messaging/telegram/webhook') {
    if (!config.telegramWebhookSecret) {
      throw routeError('Telegram webhook is not configured.', 503);
    }
    if (!validTelegramWebhookSecret(req.headers['x-telegram-bot-api-secret-token'], config.telegramWebhookSecret)) {
      throw routeError('Invalid webhook secret.', 401);
    }
    const update = await readBody(req);
    const linked = await store.update((db) => consumeTelegramLink(db, update));
    sendJson(res, 200, { data: { accepted: true, linked } });
    return true;
  }

  return false;
}
