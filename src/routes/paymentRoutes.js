import { createHmac, timingSafeEqual } from 'node:crypto';
import { makeId, now } from '../domain.js';
import {
  applySuccessfulConsultationPayment,
  reserveConsultationPayment
} from '../services/consultations.js';

function httpError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function providerError(message, status, definitive = false) {
  const error = httpError(message, status);
  error.definitive = definitive;
  return error;
}

function paystackErrorMessage(payload) {
  return String(payload?.message || payload?.data?.message || 'Paystack could not process the request.');
}

async function paystackRequest(config, path, options = {}) {
  const response = await fetch(`${config.paystackBaseUrl}${path}`, {
    ...options,
    headers: {
      authorization: `Bearer ${config.paystackSecretKey}`,
      'content-type': 'application/json',
      ...options.headers
    },
    signal: AbortSignal.timeout(15_000)
  });
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw providerError('Paystack returned an invalid response.', 502);
  }
  if (!response.ok || payload?.status !== true) {
    throw providerError(paystackErrorMessage(payload), 502, true);
  }
  if (!payload.data || typeof payload.data !== 'object') {
    throw providerError('Paystack returned an incomplete response.', 502);
  }
  return payload.data;
}

function validPaystackSignature(rawBody, signature, secret) {
  if (!secret || !signature || !/^[a-f\d]{128}$/i.test(signature)) return false;
  const expected = createHmac('sha512', secret).update(rawBody).digest();
  const provided = Buffer.from(signature, 'hex');
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

async function initializeCheckout(config, payment, patient) {
  const payload = {
    email: patient.email,
    amount: Math.round(Number(payment.amount) * 100),
    currency: payment.currency,
    reference: payment.transactionReference,
    metadata: {
      consultationId: payment.consultationId,
      consultationNumber: payment.consultationNumber
    }
  };
  const callbackUrl = config.paystackCallbackUrl ||
    (config.publicBaseUrl ? `${config.publicBaseUrl.replace(/\/+$/, '')}/?payment=returned` : '');
  if (callbackUrl) payload.callback_url = callbackUrl;

  const data = await paystackRequest(config, '/transaction/initialize', {
    method: 'POST',
    body: JSON.stringify(payload)
  });
  let checkoutUrl;
  try {
    checkoutUrl = new URL(data.authorization_url);
  } catch {
    throw httpError('Paystack did not return a valid checkout URL.', 502);
  }
  if (checkoutUrl.protocol !== 'https:' || !checkoutUrl.hostname.endsWith('.paystack.com')) {
    throw httpError('Paystack returned an untrusted checkout URL.', 502);
  }
  if (data.reference !== payment.transactionReference) {
    throw httpError('Paystack returned a mismatched transaction reference.', 502);
  }
  return { authorizationUrl: checkoutUrl.toString(), accessCode: data.access_code };
}

async function verifyTransaction(config, reference) {
  return paystackRequest(
    config,
    `/transaction/verify/${encodeURIComponent(reference)}`
  );
}

function transactionFromVerification(data) {
  if (!data || typeof data !== 'object') {
    throw httpError('Paystack returned incomplete transaction details.', 502);
  }
  return {
    reference: data.reference,
    status: data.status,
    amount: data.amount,
    currency: data.currency,
    id: data.id,
    paidAt: data.paid_at || data.paidAt
  };
}

export async function handlePaymentRoutes(context) {
  const {
    req,
    res,
    key,
    parts,
    store,
    sendJson,
    requireUser,
    readRawBody,
    config,
    audit
  } = context;

  if (key === 'POST /api/v1/payments/paystack/webhook') {
    if (!config.paystackSecretKey) throw httpError('Paystack is not configured.', 503);
    const rawBody = await readRawBody(req);
    const signature = String(req.headers['x-paystack-signature'] || '');
    const webhookSecret = config.paystackWebhookSecret || config.paystackSecretKey;
    if (!validPaystackSignature(rawBody, signature, webhookSecret)) {
      throw httpError('Invalid Paystack webhook signature.', 401);
    }
    let event;
    try {
      event = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw httpError('Webhook body must be valid JSON.', 400);
    }
    if (event?.event !== 'charge.success') {
      sendJson(res, 200, { data: { received: true, ignored: true } });
      return true;
    }
    await store.update((db) => {
      const result = applySuccessfulConsultationPayment(db, transactionFromVerification(event.data));
      if (result.applied) {
        audit(db, null, 'paystack_payment_confirmed', 'payment', result.payment.id, {
          consultationId: result.payment.consultationId,
          gatewayTransactionId: result.payment.gatewayTransactionId
        });
      }
      sendJson(res, 200, { data: { received: true, ...result } });
    });
    return true;
  }

  if (
    parts[2] === 'consultations' &&
    parts[3] &&
    parts[4] === 'payment' &&
    parts[5] === 'initialize' &&
    req.method === 'POST'
  ) {
    const user = await requireUser(req);
    if (user.role !== 'patient') throw httpError('Only the patient can initiate consultation payment.', 403);
    if (!config.paystackSecretKey) throw httpError('Paystack checkout is not configured.', 503);
    const reservation = await store.update((db) => {
      const prepared = reserveConsultationPayment(db, user, parts[3], makeId('paystack'));
      return prepared;
    });
    if (reservation.authorizationUrl) {
      sendJson(res, 200, { data: reservation });
      return true;
    }
    let checkout;
    try {
      checkout = await initializeCheckout(config, reservation.payment, reservation.patient);
    } catch (error) {
      if (error.definitive) {
        await store.update((db) => {
          const payment = db.payments.find(
            (item) => item.id === reservation.payment.id &&
              item.transactionReference === reservation.payment.transactionReference
          );
          if (payment?.status === 'initializing') {
            payment.status = 'initialization_failed';
            payment.initializationFailure = String(error.message || 'Paystack initialization failed.');
            payment.updatedAt = now();
          }
        });
      }
      throw error;
    }
    await store.update((db) => {
      const payment = db.payments.find(
        (item) => item.id === reservation.payment.id &&
          item.transactionReference === reservation.payment.transactionReference
      );
      if (!payment || payment.status !== 'initializing') {
        throw httpError('Payment state changed while checkout was initializing.', 409);
      }
      payment.status = 'pending';
      payment.authorizationUrl = checkout.authorizationUrl;
      payment.accessCode = checkout.accessCode;
      payment.checkoutInitializedAt = now();
      payment.updatedAt = now();
    });
    sendJson(res, 200, { data: { authorizationUrl: checkout.authorizationUrl } });
    return true;
  }

  if (
    parts[2] === 'consultations' &&
    parts[3] &&
    parts[4] === 'payment' &&
    parts[5] === 'verify' &&
    req.method === 'POST'
  ) {
    const user = await requireUser(req);
    if (user.role !== 'patient') throw httpError('Only the patient can verify consultation payment.', 403);
    if (!config.paystackSecretKey) throw httpError('Paystack verification is not configured.', 503);
    const reservation = await store.read();
    const payment = reservation.payments
      .filter((item) => item.consultationId === parts[3] && item.paymentType === 'consultation_charge')
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
    if (!payment || payment.patientId !== user.patientId || !payment.transactionReference) {
      throw httpError('No matching consultation payment was found.', 404);
    }
    const verified = await verifyTransaction(config, payment.transactionReference);
    if (String(verified?.status || '').toLowerCase() !== 'success') {
      sendJson(res, 200, {
        data: {
          applied: false,
          pending: ['ongoing', 'pending'].includes(String(verified?.status || '').toLowerCase()),
          status: String(verified?.status || 'unknown')
        }
      });
      return true;
    }
    const transaction = transactionFromVerification(verified);
    let result;
    await store.update((db) => {
      result = applySuccessfulConsultationPayment(db, transaction);
      if (result.applied) {
        audit(db, user.id, 'paystack_payment_verified', 'payment', result.payment.id, {
          consultationId: result.payment.consultationId,
          gatewayTransactionId: result.payment.gatewayTransactionId
        });
      }
    });
    sendJson(res, 200, { data: result });
    return true;
  }

  return false;
}
