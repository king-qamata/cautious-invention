import { assertRole, isEmail, makeId, normalizeEmail, now } from '../domain.js';

const FAMILY_INVITATION_TTL_DAYS = 30;

function portalError(message, status = 422) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function ownPatient(db, user) {
  const patient = db.patients.find((item) => item.userId === user.id || item.id === user.patientId);
  if (!patient) throw portalError('Patient profile not found.', 404);
  return patient;
}

function referralSummary(db, patientId) {
  return db.referrals
    .filter((item) => item.patientId === patientId)
    .map((item) => ({
      referralNumber: item.referralNumber,
      status: item.status,
      procedure: db.procedures.find((procedure) => procedure.id === item.procedureId)?.name || null,
      provider: db.providers.find((provider) => provider.id === item.assignedProviderId)?.name || null,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt
    }));
}

function consultationSummary(db, patientId) {
  return db.consultations
    .filter((item) => item.patientId === patientId)
    .map((item) => ({
      consultationNumber: item.consultationNumber,
      status: item.status,
      tier: item.tier,
      channel: item.channel,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt
    }));
}

function caseSummary(db, patient) {
  return {
    patientId: patient.id,
    patientName: patient.name,
    referrals: referralSummary(db, patient.id),
    consultations: consultationSummary(db, patient.id)
  };
}

export async function handlePatientPortalRoutes(context) {
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
    audit
  } = context;

  if (key === 'GET /api/v1/patient/portal') {
    const user = await requireUser(req);
    assertRole(user, ['patient']);
    const db = await store.read();
    db.familyInvitations ||= [];
    db.consultations ||= [];
    db.appointments ||= [];
    db.payments ||= [];
    const patient = ownPatient(db, user);
    const activeInvitations = db.familyInvitations.filter((item) =>
      item.status === 'accepted' && item.invitedUserId === user.id &&
      new Date(item.expiresAt).getTime() > Date.now()
    );
    const sharedCases = activeInvitations
      .map((invitation) => db.patients.find((item) => item.id === invitation.patientId))
      .filter(Boolean)
      .map((item) => caseSummary(db, item));
    const self = caseSummary(db, patient);
    const ownedInvitations = db.familyInvitations
      .filter((item) => item.ownerUserId === user.id)
      .map(({ id, invitedEmail, status, accessLevel, createdAt, expiresAt, acceptedAt, revokedAt }) => ({
        id, invitedEmail, status, accessLevel, createdAt, expiresAt, acceptedAt, revokedAt
      }));
    const incomingInvitations = db.familyInvitations
      .filter((item) => item.invitedEmail === user.email.toLowerCase() && item.status === 'pending')
      .map((item) => ({
        id: item.id,
        patientName: db.patients.find((candidate) => candidate.id === item.patientId)?.name || 'Patient',
        accessLevel: item.accessLevel,
        expiresAt: item.expiresAt
      }));
    sendJson(res, 200, {
      data: {
        patient: { id: patient.id, name: patient.name, country: patient.country },
        self,
        sharedCases,
        appointments: db.appointments
          .filter((item) => item.patientId === patient.id)
          .map(({ id, status, scheduledAt, createdAt, updatedAt }) => ({ id, status, scheduledAt, createdAt, updatedAt })),
        payments: db.payments
          .filter((item) => item.patientId === patient.id)
          .map(({ id, amount, currency, paymentType, status, paidAt, createdAt }) => ({ id, amount, currency, paymentType, status, paidAt, createdAt })),
        onboardingApplications: (db.onboardingApplications || [])
          .filter((item) => item.userId === user.id)
          .map(({ id, type, status, createdAt, reviewedAt }) => ({ id, type, status, createdAt, reviewedAt })),
        familyInvitations: ownedInvitations,
        incomingInvitations
      }
    });
    return true;
  }

  if (key === 'POST /api/v1/patient/family-invitations') {
    const user = await requireUser(req);
    assertRole(user, ['patient']);
    const body = await readBody(req);
    requireFields(body, ['email', 'consentGiven']);
    if (body.consentGiven !== true && body.consentGiven !== 'true') {
      throw portalError('Explicit patient approval is required before inviting a family member.');
    }
    const invitedEmail = normalizeEmail(body.email);
    if (!isEmail(invitedEmail)) throw portalError('Enter a valid email address.');
    if (invitedEmail === user.email.toLowerCase()) throw portalError('You cannot invite your own account.');

    await store.update((db) => {
      db.familyInvitations ||= [];
      const patient = ownPatient(db, user);
      const duplicate = db.familyInvitations.some((item) =>
        item.patientId === patient.id && item.invitedEmail === invitedEmail &&
        ['pending', 'accepted'].includes(item.status) && new Date(item.expiresAt).getTime() > Date.now()
      );
      if (duplicate) throw portalError('An active invitation already exists for this email.', 409);

      const timestamp = now();
      const invitation = {
        id: makeId('family_invitation'),
        patientId: patient.id,
        ownerUserId: user.id,
        invitedEmail,
        invitedUserId: null,
        accessLevel: 'case_status',
        status: 'pending',
        createdAt: timestamp,
        expiresAt: new Date(Date.now() + FAMILY_INVITATION_TTL_DAYS * 86400000).toISOString(),
        acceptedAt: null,
        revokedAt: null
      };
      db.familyInvitations.push(invitation);
      audit(db, user.id, 'created', 'family_invitation', invitation.id, { accessLevel: invitation.accessLevel });
      sendJson(res, 201, {
        data: {
          id: invitation.id,
          invitedEmail: invitation.invitedEmail,
          status: invitation.status,
          accessLevel: invitation.accessLevel,
          expiresAt: invitation.expiresAt
        }
      });
    });
    return true;
  }

  if (parts[2] === 'patient' && parts[3] === 'family-invitations' && parts[4] && req.method === 'POST') {
    const user = await requireUser(req);
    assertRole(user, ['patient']);
    const action = parts[5];
    if (!['accept', 'revoke'].includes(action) || parts.length !== 6) return false;
    await store.update((db) => {
      db.familyInvitations ||= [];
      const invitation = db.familyInvitations.find((item) => item.id === parts[4]);
      if (!invitation) throw portalError('Family invitation not found.', 404);
      const timestamp = now();
      if (action === 'accept') {
        if (invitation.invitedEmail !== user.email.toLowerCase()) throw portalError('This invitation is for another account.', 403);
        if (invitation.status !== 'pending' || new Date(invitation.expiresAt).getTime() <= Date.now()) {
          throw portalError('This invitation is no longer available.', 409);
        }
        invitation.status = 'accepted';
        invitation.invitedUserId = user.id;
        invitation.acceptedAt = timestamp;
        audit(db, user.id, 'accepted', 'family_invitation', invitation.id, { accessLevel: invitation.accessLevel });
      } else {
        if (invitation.ownerUserId !== user.id) throw portalError('Only the patient who created this invitation can revoke it.', 403);
        if (!['pending', 'accepted'].includes(invitation.status)) throw portalError('This invitation is already closed.', 409);
        invitation.status = 'revoked';
        invitation.revokedAt = timestamp;
        audit(db, user.id, 'revoked', 'family_invitation', invitation.id);
      }
      invitation.updatedAt = timestamp;
      sendJson(res, 200, { data: { id: invitation.id, status: invitation.status, updatedAt: timestamp } });
    });
    return true;
  }

  return false;
}
