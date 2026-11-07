import assert from 'node:assert/strict';
import test from 'node:test';

import { seedDatabase, publicUser } from '../src/domain.js';
import {
  consumeTelegramLink,
  createTelegramLink,
  deliverExternalNotification,
  deliverNextNotification,
  notificationChannelConfiguration,
  validTelegramWebhookSecret
} from '../src/services/messaging.js';
import { handleMessagingRoutes } from '../src/routes/messagingRoutes.js';

const messagingConfig = {
  whatsappAccessToken: 'test-access-token',
  whatsappPhoneNumberId: '123456789',
  whatsappApiVersion: 'v22.0',
  whatsappTemplateName: 'consultation_update',
  whatsappTemplateLanguage: 'en',
  telegramBotToken: 'test-bot-token',
  telegramBotUsername: 'mindset_test_bot',
  telegramWebhookSecret: 'test-webhook-secret'
};

function fakeStore(db) {
  return {
    async read() {
      return db;
    },
    async update(mutator) {
      return mutator(db);
    }
  };
}

test('Telegram account linking uses a one-time expiring token and hides the chat ID', () => {
  const db = seedDatabase();
  const user = db.users.find((item) => item.role === 'patient');
  const timestamp = Date.now();
  const link = createTelegramLink(db, user, messagingConfig, timestamp);
  const token = new URL(link.deepLink).searchParams.get('start');

  assert.ok(token);
  assert.equal(db.telegramLinkTokens[0].tokenHash.includes(token), false);
  assert.equal(
    consumeTelegramLink(db, { message: { text: `/start ${token}`, chat: { id: 98765 } } }, timestamp + 1000),
    true
  );
  assert.equal(user.telegramChatId, '98765');
  assert.equal(publicUser(user).telegramChatId, undefined);
  assert.equal(
    consumeTelegramLink(db, { message: { text: `/start ${token}`, chat: { id: 98765 } } }, timestamp + 2000),
    false
  );
});

test('Telegram link tokens expire and webhook secrets are compared safely', () => {
  const db = seedDatabase();
  const user = db.users.find((item) => item.role === 'patient');
  const timestamp = Date.now();
  const link = createTelegramLink(db, user, messagingConfig, timestamp);
  const token = new URL(link.deepLink).searchParams.get('start');

  assert.equal(
    consumeTelegramLink(db, { message: { text: `/start ${token}`, chat: { id: 98765 } } }, timestamp + 16 * 60 * 1000),
    false
  );
  assert.equal(validTelegramWebhookSecret('test-webhook-secret', 'test-webhook-secret'), true);
  assert.equal(validTelegramWebhookSecret('wrong', 'test-webhook-secret'), false);
  assert.equal(validTelegramWebhookSecret('test-webhook-secret', ''), false);
});

test('Telegram link and webhook routes require the configured shared secret', async () => {
  const db = seedDatabase();
  const user = db.users.find((item) => item.role === 'patient');
  const store = fakeStore(db);
  const responses = [];
  const sendJson = (_res, status, payload) => responses.push({ status, payload });
  const config = messagingConfig;

  await handleMessagingRoutes({
    req: { headers: {} },
    res: {},
    key: 'POST /api/v1/account/telegram/link',
    store,
    sendJson,
    requireUser: async () => user,
    readBody: async () => ({}),
    config
  });
  const deepLink = responses[0].payload.data.deepLink;
  const token = new URL(deepLink).searchParams.get('start');

  await handleMessagingRoutes({
    req: { headers: { 'x-telegram-bot-api-secret-token': config.telegramWebhookSecret } },
    res: {},
    key: 'POST /api/v1/messaging/telegram/webhook',
    store,
    sendJson,
    requireUser: async () => user,
    readBody: async () => ({ message: { text: `/start ${token}`, chat: { id: 76543 } } }),
    config
  });

  assert.equal(responses[0].status, 201);
  assert.equal(responses[1].status, 200);
  assert.equal(responses[1].payload.data.linked, true);
  assert.equal(user.telegramChatId, '76543');
});

test('WhatsApp delivery uses an approved template and returns the provider message ID', async () => {
  let request;
  const result = await deliverExternalNotification({
    channel: 'whatsapp',
    recipient: '+2348000000000',
    subject: 'Consultation update',
    body: 'A consultation status changed.'
  }, messagingConfig, async (url, options) => {
    request = { url, options };
    return {
      ok: true,
      async json() {
        return { messages: [{ id: 'wamid.123' }] };
      }
    };
  });

  assert.match(request.url, /graph\.facebook\.com\/v22\.0\/123456789\/messages$/);
  assert.equal(request.options.headers.authorization, 'Bearer test-access-token');
  const payload = JSON.parse(request.options.body);
  assert.equal(payload.type, 'template');
  assert.equal(payload.template.name, 'consultation_update');
  assert.deepEqual(result, { providerReference: 'wamid.123' });
});

test('notification worker delivers queued Telegram updates and records delivery state', async () => {
  const db = seedDatabase();
  const notification = {
    id: 'notification_test_1',
    channel: 'telegram',
    recipient: '98765',
    subject: 'Consultation update',
    body: 'A consultation status changed.',
    status: 'queued',
    deliveryAttempts: 0
  };
  db.notificationLogs.push(notification);
  const delivered = await deliverNextNotification(fakeStore(db), messagingConfig, async (url, options) => {
    assert.match(url, /sendMessage$/);
    assert.equal(JSON.parse(options.body).chat_id, '98765');
    return {
      ok: true,
      async json() {
        return { ok: true, result: { message_id: 44 } };
      }
    };
  });

  assert.equal(delivered, true);
  assert.equal(notification.status, 'delivered');
  assert.equal(notification.provider, 'telegram-bot-api');
  assert.equal(notification.providerReference, '44');
  assert.equal(notification.deliveryAttempts, 1);
});

test('unconfigured notification channels stay queued and report readiness accurately', async () => {
  const db = seedDatabase();
  db.notificationLogs.push({
    id: 'notification_pending',
    channel: 'whatsapp',
    recipient: '+2348000000000',
    status: 'queued'
  });

  assert.deepEqual(notificationChannelConfiguration({}), { whatsapp: false, telegram: false });
  assert.equal(await deliverNextNotification(fakeStore(db), {}), false);
  assert.equal(db.notificationLogs[0].status, 'queued');
});
