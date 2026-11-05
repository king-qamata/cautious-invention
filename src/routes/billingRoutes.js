import { assertRole, makeId, normalizeString, now } from '../domain.js';

export async function handleBillingRoutes(context) {
  const {
    req,
    res,
    parts,
    store,
    sendJson,
    requireUser,
    readBody,
    requireFields,
    audit,
    expandPayment
  } = context;

  if (parts[2] === 'referrals' && parts[3] && parts[4] === 'payments') {
    const user = await requireUser(req);
    assertRole(user, ['admin', 'coordinator', 'finance']);
    const db = await store.read();
    const referral = db.referrals.find((item) => item.referralNumber === parts[3]);
    if (!referral) {
      const error = new Error('Referral not found.');
      error.status = 404;
      throw error;
    }

    if (req.method === 'GET') {
      const payments = db.payments
        .filter((item) => item.referralId === referral.id)
        .map((item) => expandPayment(db, item));
      sendJson(res, 200, { data: payments });
      return true;
    }

    if (req.method === 'POST') {
      const body = await readBody(req);
      requireFields(body, ['amount', 'paymentType']);
      await store.update((freshDb) => {
        const freshReferral = freshDb.referrals.find((item) => item.id === referral.id);
        const amount = Number(body.amount);
        if (!Number.isFinite(amount) || amount <= 0) {
          const error = new Error('Payment amount must be greater than zero.');
          error.status = 422;
          throw error;
        }

        const timestamp = now();
        const payment = {
          id: makeId('payment'),
          referralId: freshReferral.id,
          patientId: freshReferral.patientId,
          amount,
          currency: normalizeString(body.currency || 'NGN', 3).toUpperCase(),
          paymentType: normalizeString(body.paymentType, 50),
          status: normalizeString(body.status || 'pending', 50),
          paymentMethod: normalizeString(body.paymentMethod, 50),
          transactionReference: normalizeString(body.transactionReference || makeId('txn'), 255),
          providerPayoutAmount: body.providerPayoutAmount ? Number(body.providerPayoutAmount) : null,
          reconciliationStatus: normalizeString(body.reconciliationStatus || 'unreconciled', 50),
          paidAt: body.status === 'paid' ? timestamp : null,
          createdAt: timestamp,
          updatedAt: timestamp
        };

        freshDb.payments.push(payment);
        audit(freshDb, user.id, 'created', 'payment', payment.id, { referralId: freshReferral.id, amount });
        sendJson(res, 201, { data: expandPayment(freshDb, payment) });
      });
      return true;
    }
  }

  return false;
}
