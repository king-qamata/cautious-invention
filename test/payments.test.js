import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { seedDatabase } from '../src/domain.js';
import { handlePaymentRoutes } from '../src/routes/paymentRoutes.js';
import { claimConsultation, createConsultation } from '../src/services/consultations.js';
import { JsonStore } from '../src/storage.js';

async function createPaymentContext() {
  const directory = await mkdtemp(join(tmpdir(), 'mindset-payments-'));
  const store = new JsonStore(join(directory, 'data.json'), seedDatabase());
  const db = seedDatabase();
  const patient = db.users.find((item) => item.role === 'patient');
  const clinician = db.users.find((item) => item.role === 'clinician');
  const consultation = createConsultation(db, patient, {
    requestedNeed: 'Payment integration test',
    tier: 'priority'
  });
  claimConsultation(db, clinician, consultation.id);
  await store.write(db);

  const context = {
    req: {
      method: 'POST',
      headers: {},
      url: '/'
    },
    res: {
      status: null,
      payload: null
    },
    parts: [],
    key: '',
    store,
    sendJson(res, status, payload) {
      res.status = status;
      res.payload = payload;
    },
    requireUser: async () => patient,
    readRawBody: async () => Buffer.alloc(0),
    config: {
      paystackSecretKey: 'sk_test_for_unit_test',
      paystackWebhookSecret: 'webhook_test_secret',
      paystackBaseUrl: 'https://api.paystack.co',
      paystackCallbackUrl: 'https://app.example.test/payment-return',
      publicBaseUrl: 'https://app.example.test'
    },
    audit(dbRef, actorId, action, entityType, entityId, details) {
      dbRef.auditLogs.push({ actorId, action, entityType, entityId, details });
    },
    patient,
    clinician,
    consultation,
    cleanup: () => rm(directory, { recursive: true, force: true })
  };
  return context;
}

test('Paystack checkout initializes once with the consultation price and patient email', async () => {
  const context = await createPaymentContext();
  const originalFetch = globalThis.fetch;
  let initRequest;
  globalThis.fetch = async (url, options) => {
    initRequest = { url, options, body: JSON.parse(options.body) };
    return {
      ok: true,
      async json() {
        return {
          status: true,
          data: {
            authorization_url: 'https://checkout.paystack.com/checkoutcode',
            access_code: 'access-code',
            reference: initRequest.body.reference
          }
        };
      }
    };
  };

  try {
    context.key = '';
    context.parts = ['api', 'v1', 'consultations', context.consultation.id, 'payment', 'initialize'];
    assert.equal(await handlePaymentRoutes(context), true);
    assert.equal(context.res.status, 200);
    assert.equal(context.res.payload.data.authorizationUrl, 'https://checkout.paystack.com/checkoutcode');
    assert.equal(initRequest.url, 'https://api.paystack.co/transaction/initialize');
    assert.equal(initRequest.body.amount, 500000);
    assert.equal(initRequest.body.currency, 'NGN');
    assert.equal(initRequest.body.email, context.patient.email);
    assert.equal(initRequest.body.callback_url, 'https://app.example.test/payment-return');

    const db = await context.store.read();
    assert.equal(db.payments.length, 1);
    assert.equal(db.payments[0].status, 'pending');
    assert.equal(db.payments[0].paymentType, 'consultation_charge');
  } finally {
    globalThis.fetch = originalFetch;
    await context.cleanup();
  }
});

test('Paystack webhook validates the raw-body signature, transaction details, and duplicate delivery', async () => {
  const context = await createPaymentContext();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    return {
      ok: true,
      async json() {
        return {
          status: true,
          data: {
            authorization_url: 'https://checkout.paystack.com/checkoutcode',
            access_code: 'access-code',
            reference: body.reference
          }
        };
      }
    };
  };

  try {
    context.parts = ['api', 'v1', 'consultations', context.consultation.id, 'payment', 'initialize'];
    await handlePaymentRoutes(context);
    const dbBeforeWebhook = await context.store.read();
    const payment = dbBeforeWebhook.payments[0];
    const eventBody = Buffer.from(JSON.stringify({
      event: 'charge.success',
      data: {
        reference: payment.transactionReference,
        status: 'success',
        amount: 500000,
        currency: 'NGN',
        id: 4321,
        paid_at: '2026-03-19T13:00:00.000Z'
      }
    }));
    const signature = createHmac('sha512', context.config.paystackWebhookSecret).update(eventBody).digest('hex');
    context.key = 'POST /api/v1/payments/paystack/webhook';
    context.parts = ['api', 'v1', 'payments', 'paystack', 'webhook'];
    context.req.headers['x-paystack-signature'] = signature;
    context.readRawBody = async () => eventBody;

    await handlePaymentRoutes(context);
    assert.equal(context.res.status, 200);
    assert.equal(context.res.payload.data.applied, true);

    await handlePaymentRoutes(context);
    assert.equal(context.res.payload.data.duplicate, true);
    const dbAfterWebhook = await context.store.read();
    assert.equal(dbAfterWebhook.payments[0].status, 'captured');
    assert.equal(dbAfterWebhook.payments[0].gatewayTransactionId, '4321');

    const invalidBody = Buffer.from(JSON.stringify({
      event: 'charge.success',
      data: {
        reference: payment.transactionReference,
        status: 'success',
        amount: 1,
        currency: 'NGN'
      }
    }));
    context.readRawBody = async () => invalidBody;
    context.req.headers['x-paystack-signature'] = createHmac('sha512', context.config.paystackWebhookSecret)
      .update(invalidBody)
      .digest('hex');
    await assert.rejects(() => handlePaymentRoutes(context), /status, amount, or currency does not match/);
  } finally {
    globalThis.fetch = originalFetch;
    await context.cleanup();
  }
});
