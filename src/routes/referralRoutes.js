import {
  assertProcedureForSpecialty,
  assertRole,
  canViewReferral,
  makeId,
  nextReferralNumber,
  normalizeString,
  now,
  recommendProviders,
  referralTransitions
} from '../domain.js';

export async function handleReferralRoutes(context) {
  const {
    req,
    res,
    key,
    parts,
    store,
    sendJson,
    requireUser,
    readBody,
    requireFields,
    notify,
    audit,
    expandReferral,
    expandAppointment
  } = context;

  if (key === 'GET /api/v1/referrals') {
    const user = await requireUser(req);
    const db = await store.read();
    const referrals = db.referrals
      .filter((referral) => canViewReferral(user, referral))
      .map((referral) => expandReferral(db, referral));
    sendJson(res, 200, { data: referrals });
    return true;
  }

  if (key === 'POST /api/v1/referrals') {
    const user = await requireUser(req);
    const body = await readBody(req);
    requireFields(body, ['patientId', 'healthcareRequirement', 'specialtyId', 'procedureId']);
    if (!['admin', 'coordinator', 'clinician', 'patient'].includes(user.role)) assertRole(user, []);
    await store.update((db) => {
      const patientId = user.role === 'patient' ? user.patientId : body.patientId;
      const patient = db.patients.find((item) => item.id === patientId);
      if (!patient) {
        const error = new Error('Patient not found.');
        error.status = 404;
        throw error;
      }
      assertProcedureForSpecialty(db, body.specialtyId, body.procedureId);
      const timestamp = now();
      const referral = {
        id: makeId('referral'),
        referralNumber: nextReferralNumber(db),
        patientId,
        leadId: body.leadId || null,
        referrerClinicianId: user.role === 'clinician' ? user.id : body.referrerClinicianId || null,
        healthcareRequirement: normalizeString(body.healthcareRequirement, 4000),
        specialtyId: body.specialtyId,
        procedureId: body.procedureId,
        priority: body.priority || 'routine',
        status: 'submitted',
        assignedCoordinatorId: body.assignedCoordinatorId || null,
        assignedProviderId: null,
        patientNotes: normalizeString(body.patientNotes, 4000),
        internalNotes: normalizeString(body.internalNotes, 4000),
        closedAt: null,
        createdAt: timestamp,
        updatedAt: timestamp
      };
      db.referrals.push(referral);
      db.referralStatusHistory.push({
        id: makeId('history'),
        referralId: referral.id,
        fromStatus: null,
        toStatus: 'submitted',
        changedByUserId: user.id,
        note: normalizeString(body.note || 'Referral submitted.', 4000),
        createdAt: timestamp,
        updatedAt: timestamp
      });
      notify(db, referral, 'email', 'coordinator@mindset.local', 'New referral submitted', referral.referralNumber);
      audit(db, user.id, 'created', 'referral', referral.id);
      sendJson(res, 201, { data: expandReferral(db, referral) });
    });
    return true;
  }

  if (parts[2] === 'referrals' && parts[3] && req.method === 'GET' && parts.length === 4) {
    const user = await requireUser(req);
    const db = await store.read();
    const referral = db.referrals.find((item) => item.referralNumber === parts[3]);
    if (!referral || !canViewReferral(user, referral)) {
      const error = new Error('Referral not found.');
      error.status = 404;
      throw error;
    }
    sendJson(res, 200, { data: expandReferral(db, referral) });
    return true;
  }

  if (parts[2] === 'referrals' && parts[3] && parts[4] === 'recommendations' && req.method === 'GET') {
    const user = await requireUser(req);
    const db = await store.read();
    const referral = db.referrals.find((item) => item.referralNumber === parts[3]);
    if (!referral || !canViewReferral(user, referral)) {
      const error = new Error('Referral not found.');
      error.status = 404;
      throw error;
    }
    sendJson(res, 200, { data: recommendProviders(db, referral) });
    return true;
  }

  if (parts[2] === 'referrals' && parts[3] && parts[4] === 'transition' && req.method === 'POST') {
    const user = await requireUser(req);
    const body = await readBody(req);
    requireFields(body, ['toStatus']);
    await store.update((db) => {
      const referral = db.referrals.find((item) => item.referralNumber === parts[3]);
      if (!referral || !canViewReferral(user, referral)) {
        const error = new Error('Referral not found.');
        error.status = 404;
        throw error;
      }
      const providerOnly = ['accepted', 'rejected', 'request_info'];
      if (providerOnly.includes(body.toStatus)) assertRole(user, ['admin', 'coordinator', 'hospital_staff']);
      else assertRole(user, ['admin', 'coordinator']);
      if (body.assignedProviderId && !['admin', 'coordinator'].includes(user.role)) {
        const error = new Error('Only coordinators can assign a provider.');
        error.status = 403;
        throw error;
      }
      if (body.assignedProviderId) {
        const provider = db.providers.find(
          (item) => item.id === body.assignedProviderId && item.isActive && item.onboardingStatus === 'active'
        );
        const capability = db.providerProcedures.find(
          (item) => item.providerId === body.assignedProviderId && item.procedureId === referral.procedureId
        );
        if (!provider || !capability || capability.availability === 'unavailable') {
          const error = new Error('The selected provider is not active or cannot deliver this referral procedure.');
          error.status = 422;
          throw error;
        }
      }
      if (!referralTransitions[referral.status]?.includes(body.toStatus)) {
        const error = new Error(`Cannot transition from ${referral.status} to ${body.toStatus}.`);
        error.status = 422;
        throw error;
      }
      if (body.assignedProviderId) referral.assignedProviderId = body.assignedProviderId;
      if (body.toStatus === 'accepted' && !referral.assignedProviderId) {
        const error = new Error('Cannot accept a referral without an assigned provider.');
        error.status = 422;
        throw error;
      }
      const previous = referral.status;
      referral.status = body.toStatus;
      referral.updatedAt = now();
      if (['closed', 'cancelled'].includes(referral.status)) referral.closedAt = referral.updatedAt;
      db.referralStatusHistory.push({
        id: makeId('history'),
        referralId: referral.id,
        fromStatus: previous,
        toStatus: body.toStatus,
        changedByUserId: user.id,
        note: normalizeString(body.note, 4000),
        createdAt: referral.updatedAt,
        updatedAt: referral.updatedAt
      });
      if (body.toStatus === 'matched' && body.assignedProviderId) {
        const lead = db.leads.find((item) => item.id === referral.leadId);
        if (lead) lead.status = 'provider_matched';
      }
      notify(
        db,
        referral,
        'sms',
        expandReferral(db, referral).patient?.phone || 'unknown',
        'Referral status changed',
        `${referral.referralNumber}: ${body.toStatus}`
      );
      audit(db, user.id, 'transitioned', 'referral', referral.id, {
        fromStatus: previous,
        toStatus: body.toStatus
      });
      sendJson(res, 200, { data: expandReferral(db, referral) });
    });
    return true;
  }

  if (parts[2] === 'referrals' && parts[3] && parts[4] === 'history' && req.method === 'GET') {
    const user = await requireUser(req);
    const db = await store.read();
    const referral = db.referrals.find((item) => item.referralNumber === parts[3]);
    if (!referral || !canViewReferral(user, referral)) {
      const error = new Error('Referral not found.');
      error.status = 404;
      throw error;
    }
    const history = db.referralStatusHistory.filter((item) => item.referralId === referral.id);
    sendJson(res, 200, { data: history });
    return true;
  }

  if (parts[2] === 'referrals' && parts[3] && parts[4] === 'appointments') {
    const user = await requireUser(req);
    const db = await store.read();
    const referral = db.referrals.find((item) => item.referralNumber === parts[3]);
    if (!referral || !canViewReferral(user, referral)) {
      const error = new Error('Referral not found.');
      error.status = 404;
      throw error;
    }
    if (req.method === 'GET') {
      const appointments = db.appointments
        .filter((item) => item.referralId === referral.id)
        .map((item) => expandAppointment(db, item));
      sendJson(res, 200, { data: appointments });
      return true;
    }
    if (req.method === 'POST') {
      assertRole(user, ['admin', 'coordinator', 'hospital_staff']);
      const body = await readBody(req);
      requireFields(body, ['scheduledDate', 'scheduledTime']);
      await store.update((freshDb) => {
        const freshReferral = freshDb.referrals.find((item) => item.id === referral.id);
        if (!['accepted', 'appointment_scheduled'].includes(freshReferral.status)) {
          const error = new Error('A referral must be accepted before scheduling an appointment.');
          error.status = 422;
          throw error;
        }
        if (!freshReferral.assignedProviderId && !body.providerId) {
          const error = new Error('Assign a provider before scheduling an appointment.');
          error.status = 422;
          throw error;
        }
        const timestamp = now();
        const appointment = {
          id: makeId('appointment'),
          referralId: freshReferral.id,
          providerId: body.providerId || freshReferral.assignedProviderId,
          patientId: freshReferral.patientId,
          scheduledDate: normalizeString(body.scheduledDate, 20),
          scheduledTime: normalizeString(body.scheduledTime, 20),
          durationMinutes: Number(body.durationMinutes || 30),
          status: normalizeString(body.status || 'scheduled', 50),
          notes: normalizeString(body.notes, 2000),
          createdAt: timestamp,
          updatedAt: timestamp
        };
        freshDb.appointments.push(appointment);
        if (freshReferral.status === 'accepted') {
          const previousStatus = freshReferral.status;
          freshReferral.status = 'appointment_scheduled';
          freshReferral.updatedAt = timestamp;
          freshDb.referralStatusHistory.push({
            id: makeId('history'),
            referralId: freshReferral.id,
            fromStatus: previousStatus,
            toStatus: freshReferral.status,
            changedByUserId: user.id,
            note: 'Appointment scheduled.',
            createdAt: timestamp,
            updatedAt: timestamp
          });
        }
        notify(
          freshDb,
          freshReferral,
          'sms',
          expandReferral(freshDb, freshReferral).patient?.phone || 'unknown',
          'Appointment scheduled',
          `${appointment.scheduledDate} ${appointment.scheduledTime}`
        );
        audit(freshDb, user.id, 'created', 'appointment', appointment.id, { referralId: freshReferral.id });
        sendJson(res, 201, { data: expandAppointment(freshDb, appointment) });
      });
      return true;
    }
  }

  return false;
}
