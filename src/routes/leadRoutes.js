import {
  assertConsultationTier,
  assertFunnelTransition,
  assertProcedureForSpecialty,
  assertRole,
  consentWasGiven,
  leadTransitions,
  makeId,
  nextReferralNumber,
  normalizeString,
  now
} from '../domain.js';

export async function handleLeadRoutes(context) {
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
    normalizeEmail,
    audit,
    notify,
    expandReferral
  } = context;

  if (key === 'GET /api/v1/leads') {
    const user = await requireUser(req);
    assertRole(user, ['admin', 'coordinator']);
    const db = await store.read();
    sendJson(res, 200, { data: db.leads });
    return true;
  }

  if (key === 'POST /api/v1/leads') {
    const body = await readBody(req);
    requireFields(body, ['name', 'phone', 'healthcareRequirement']);
    if (!consentWasGiven(body.consentGiven)) {
      const error = new Error('Consent is required before Mindset Healthcare can process this enquiry.');
      error.status = 422;
      throw error;
    }
    assertConsultationTier(body.preferredUrgency || 'normal');
    await store.update((db) => {
      const timestamp = now();
      const lead = {
        id: makeId('lead'),
        patientId: body.patientId || null,
        careFor: ['self', 'family'].includes(body.careFor) ? body.careFor : 'self',
        consentGiven: true,
        consentGivenAt: timestamp,
        source: normalizeString(body.source || 'website', 100),
        channel: normalizeString(body.channel || 'direct', 50),
        name: normalizeString(body.name, 200),
        email: normalizeEmail(body.email),
        phone: normalizeString(body.phone, 30),
        location: normalizeString(body.location, 200),
        country: normalizeString(body.country || 'Nigeria', 100),
        healthcareRequirement: normalizeString(body.healthcareRequirement, 4000),
        preferredUrgency: body.preferredUrgency || 'normal',
        status: 'new',
        funnelStage: 'application',
        funnelStageHistory: [{ stage: 'application', changedByUserId: null, createdAt: timestamp }],
        assignedStaffId: null,
        createdAt: timestamp,
        updatedAt: timestamp
      };
      db.leads.push(lead);
      audit(db, null, 'created', 'lead', lead.id);
      sendJson(res, 201, { data: lead });
    });
    return true;
  }

  if (parts[2] === 'leads' && parts[3] && req.method === 'PATCH') {
    const user = await requireUser(req);
    assertRole(user, ['admin', 'coordinator']);
    const body = await readBody(req);
    await store.update((db) => {
      const lead = db.leads.find((item) => item.id === parts[3]);
      if (!lead) {
        const error = new Error('Lead not found.');
        error.status = 404;
        throw error;
      }
      if (body.status && body.status !== lead.status) {
        if (!leadTransitions[lead.status]?.includes(body.status)) {
          const error = new Error(`Cannot move lead from ${lead.status} to ${body.status}.`);
          error.status = 422;
          throw error;
        }
        lead.status = body.status;
      }
      if (body.funnelStage && body.funnelStage !== lead.funnelStage) {
        assertFunnelTransition(lead.funnelStage || 'application', body.funnelStage);
        lead.funnelStage = body.funnelStage;
        lead.funnelStageHistory = lead.funnelStageHistory || [];
        lead.funnelStageHistory.push({ stage: body.funnelStage, changedByUserId: user.id, createdAt: now() });
      }
      for (const field of ['assignedStaffId', 'source', 'channel', 'location', 'healthcareRequirement']) {
        if (body[field] !== undefined) {
          lead[field] = normalizeString(body[field], field === 'healthcareRequirement' ? 4000 : 200);
        }
      }
      lead.updatedAt = now();
      audit(db, user.id, 'updated', 'lead', lead.id);
      sendJson(res, 200, { data: lead });
    });
    return true;
  }

  if (parts[2] === 'leads' && parts[3] && parts[4] === 'convert-to-referral' && req.method === 'POST') {
    const user = await requireUser(req);
    assertRole(user, ['admin', 'coordinator']);
    const body = await readBody(req);
    requireFields(body, ['specialtyId', 'procedureId']);
    await store.update((db) => {
      const lead = db.leads.find((item) => item.id === parts[3]);
      if (!lead) {
        const error = new Error('Lead not found.');
        error.status = 404;
        throw error;
      }
      assertProcedureForSpecialty(db, body.specialtyId, body.procedureId);
      const timestamp = now();
      let patient = lead.patientId ? db.patients.find((item) => item.id === lead.patientId) : null;
      if (!patient) {
        patient = {
          id: makeId('patient'),
          userId: null,
          name: lead.name,
          email: lead.email,
          phone: lead.phone,
          city: normalizeString(body.city || lead.location, 100),
          state: normalizeString(body.state, 100),
          country: lead.country || 'Nigeria',
          consentGiven: Boolean(body.consentGiven),
          createdAt: timestamp,
          updatedAt: timestamp
        };
        db.patients.push(patient);
        lead.patientId = patient.id;
      }
      const referral = {
        id: makeId('referral'),
        referralNumber: nextReferralNumber(db),
        patientId: patient.id,
        leadId: lead.id,
        referrerClinicianId: null,
        healthcareRequirement: lead.healthcareRequirement,
        specialtyId: body.specialtyId,
        procedureId: body.procedureId,
        priority: body.priority || 'routine',
        status: 'submitted',
        assignedCoordinatorId: user.id,
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
        note: 'Referral created from lead.',
        createdAt: timestamp,
        updatedAt: timestamp
      });
      lead.status = 'referral_created';
      lead.updatedAt = timestamp;
      notify(db, referral, 'email', 'coordinator@mindset.local', 'New referral submitted', referral.referralNumber);
      audit(db, user.id, 'converted', 'lead', lead.id, { referralId: referral.id });
      sendJson(res, 201, { data: expandReferral(db, referral) });
    });
    return true;
  }

  return false;
}
