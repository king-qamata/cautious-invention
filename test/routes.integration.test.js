import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { seedDatabase } from '../src/domain.js';
import { JsonStore } from '../src/storage.js';
import { handleAccountRoutes } from '../src/routes/accountRoutes.js';
import { handleConsultationRoutes } from '../src/routes/consultationRoutes.js';
import { handleLeadReferralRoutes } from '../src/routes/leadReferralRoutes.js';
import { handleDocumentRoutes } from '../src/routes/documentRoutes.js';
import { handleReportRoutes } from '../src/routes/reportRoutes.js';

function mockRes() {
  return {
    status: null,
    payload: null,
    headers: null,
    body: '',
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
      return this;
    },
    destroy() {},
    end(body = '') {
      this.body = String(body);
    }
  };
}

function sendJson(res, status, payload) {
  res.status = status;
  res.payload = payload;
}

async function buildContext(overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'mindset-routes-'));
  const filePath = join(directory, 'data.json');
  const store = new JsonStore(filePath, seedDatabase());
  await store.write(seedDatabase());

  const db = await store.read();
  const coordinator = db.users.find((item) => item.role === 'coordinator');
  const clinician = db.users.find((item) => item.role === 'clinician');
  const patient = db.users.find((item) => item.role === 'patient');

  return {
    directory,
    filePath,
    store,
    coordinator,
    clinician,
    patient,
    sendJson,
    readBody: async () => overrides.body || {},
    requireFields: (body, fields) => {
      for (const field of fields) {
        if (body[field] === undefined || body[field] === '') throw new Error(`${field} is required.`);
      }
    },
    normalizeEmail: (value) => String(value || '').toLowerCase(),
    requireUser: async () => overrides.user || coordinator,
    req: { method: overrides.method || 'GET', headers: {}, url: overrides.url || '/' },
    parts: overrides.parts || [],
    key: overrides.key || '',
    res: mockRes(),
    config: { maxBodyBytes: 1024 * 1024, documentDir: join(directory, 'documents') },
    securityHeaders: (headers) => headers,
    audit: (dbRef, actorId, action, entityType, entityId) => {
      dbRef.auditLogs.push({ actorId, action, entityType, entityId });
    },
    notify: (dbRef, referral, channel, recipient, subject) => {
      dbRef.notificationLogs.push({ referralId: referral?.id || null, channel, recipient, subject });
    },
    expandReferral: (dbRef, referral) => {
      const patientRef = dbRef.patients.find((item) => item.id === referral.patientId) || null;
      return { ...referral, patient: patientRef };
    },
    expandAppointment: (dbRef, appointment) => appointment,
    expandPayment: (dbRef, payment) => payment,
    cleanup: async () => rm(directory, { recursive: true, force: true })
  };
}

test('account routes returns use-cases payload', async () => {
  const ctx = await buildContext({ key: 'GET /api/v1/account/use-cases' });
  try {
    const handled = await handleAccountRoutes({
      req: ctx.req,
      res: ctx.res,
      key: ctx.key,
      store: ctx.store,
      sendJson: ctx.sendJson,
      requireUser: async () => ctx.patient,
      readBody: ctx.readBody,
      requireFields: ctx.requireFields,
      audit: ctx.audit,
      ensureConsultationCollections: (db) => {
        db.consultations ||= [];
        db.consultationClaims ||= [];
        db.biometricVerifications ||= [];
      }
    });
    assert.equal(handled, true);
    assert.equal(ctx.res.status, 200);
    assert.ok(Array.isArray(ctx.res.payload.data.allowedActions));
  } finally {
    await ctx.cleanup();
  }
});

test('account routes returns consolidated workspace payload', async () => {
  const ctx = await buildContext({
    key: 'GET /api/v1/account/workspace',
    url: '/api/v1/account/workspace?includeInbox=true&channel=all&type=all&severity=all&unreadOnly=false&limit=50'
  });
  try {
    const handled = await handleAccountRoutes({
      req: ctx.req,
      res: ctx.res,
      key: ctx.key,
      store: ctx.store,
      sendJson: ctx.sendJson,
      requireUser: async () => ctx.clinician,
      readBody: ctx.readBody,
      requireFields: ctx.requireFields,
      audit: ctx.audit,
      ensureConsultationCollections: (db) => {
        db.consultations ||= [];
        db.consultationClaims ||= [];
        db.biometricVerifications ||= [];
      }
    });

    assert.equal(handled, true);
    assert.equal(ctx.res.status, 200);
    assert.equal(ctx.res.payload.data.role, 'clinician');
    assert.equal(ctx.res.payload.data.roleProfile.defaultAccountScreen, 'operations');
    assert.equal(ctx.res.payload.data.roleProfile.recommendedQueuePreset, 'needs_claim');
    assert.ok(Array.isArray(ctx.res.payload.data.useCases.allowedActions));
    assert.equal(typeof ctx.res.payload.data.notificationSummary.hasUnread, 'boolean');
    assert.ok(Array.isArray(ctx.res.payload.data.notificationPreferences.consultations.preferredChannels));
    assert.ok(Array.isArray(ctx.res.payload.data.notificationInbox.items));
    assert.equal(typeof ctx.res.payload.data.notificationInbox.meta.visibleCount, 'number');
    assert.equal(typeof ctx.res.payload.data.notificationInbox.meta.appliedFilters.unreadOnly, 'boolean');
    assert.equal(typeof ctx.res.payload.data.clinicianAvailabilitySummary.acceptedTierCount, 'number');
    assert.ok(Array.isArray(ctx.res.payload.data.nextActions));
    assert.ok(ctx.res.payload.data.nextActions.length >= 1);
    assert.equal(typeof ctx.res.payload.data.nextActions[0].title, 'string');
    assert.equal(typeof ctx.res.payload.data.nextActions[0].priority, 'string');
  } finally {
    await ctx.cleanup();
  }
});

test('account routes persist next-action state and refresh workspace visibility', async () => {
  const ctx = await buildContext({ key: 'GET /api/v1/account/workspace' });
  try {
    const baseRouteContext = {
      req: ctx.req,
      res: ctx.res,
      store: ctx.store,
      sendJson: ctx.sendJson,
      requireUser: async () => ctx.clinician,
      readBody: ctx.readBody,
      requireFields: ctx.requireFields,
      audit: ctx.audit,
      ensureConsultationCollections: (db) => {
        db.consultations ||= [];
        db.consultationClaims ||= [];
        db.biometricVerifications ||= [];
      }
    };

    let handled = await handleAccountRoutes({
      ...baseRouteContext,
      key: 'GET /api/v1/account/workspace'
    });

    assert.equal(handled, true);
    assert.equal(ctx.res.status, 200);
    const actionId = ctx.res.payload.data.nextActions[0]?.id;
    assert.ok(actionId);

    ctx.req.method = 'POST';
    ctx.readBody = async () => ({ actionId, status: 'snoozed', snoozeMinutes: 120 });
    handled = await handleAccountRoutes({
      ...baseRouteContext,
      readBody: ctx.readBody,
      key: 'POST /api/v1/account/next-actions/state'
    });

    assert.equal(handled, true);
    assert.equal(ctx.res.status, 200);
    assert.equal(ctx.res.payload.data.result.status, 'snoozed');
    assert.equal(ctx.res.payload.data.workspace.nextActions.some((item) => item.id === actionId), false);

    ctx.readBody = async () => ({ actionId, status: 'active' });
    handled = await handleAccountRoutes({
      ...baseRouteContext,
      readBody: ctx.readBody,
      key: 'POST /api/v1/account/next-actions/state'
    });

    assert.equal(handled, true);
    assert.equal(ctx.res.status, 200);
    assert.equal(ctx.res.payload.data.result.status, 'active');
    assert.equal(ctx.res.payload.data.workspace.nextActions.some((item) => item.id === actionId), true);

    ctx.readBody = async () => ({ actionId, status: 'completed' });
    handled = await handleAccountRoutes({
      ...baseRouteContext,
      readBody: ctx.readBody,
      key: 'POST /api/v1/account/next-actions/state'
    });

    assert.equal(handled, true);
    assert.equal(ctx.res.status, 200);
    assert.equal(ctx.res.payload.data.result.status, 'completed');
    assert.equal(ctx.res.payload.data.workspace.nextActions.some((item) => item.id === actionId), false);
  } finally {
    await ctx.cleanup();
  }
});

test('operations workspace route returns consolidated payload with role-aware capabilities', async () => {
  const ctx = await buildContext({
    key: 'GET /api/v1/operations/workspace',
    url: '/api/v1/operations/workspace?includeConsultations=true&includeConsultationComms=true&includeAccountWorkspace=true&consultationSort=claim_expiry&consultationStatus=REQUESTED&interactionType=session_marker&interactionLimit=25&accountNotificationChannel=all&accountNotificationType=all&accountNotificationSeverity=all&accountNotificationUnreadOnly=false&accountNotificationLimit=50'
  });
  try {
    const handled = await handleReportRoutes({
      req: ctx.req,
      res: ctx.res,
      key: ctx.key,
      store: ctx.store,
      sendJson: ctx.sendJson,
      requireUser: async () => ctx.coordinator,
      expandReferral: ctx.expandReferral
    });

    assert.equal(handled, true);
    assert.equal(ctx.res.status, 200);
    assert.equal(ctx.res.payload.data.role, 'coordinator');
    assert.equal(ctx.res.payload.data.capabilities.canViewLeads, true);
    assert.equal(ctx.res.payload.data.capabilities.canViewReports, true);
    assert.ok(Array.isArray(ctx.res.payload.data.leads));
    assert.ok(Array.isArray(ctx.res.payload.data.referrals));
    assert.ok(Array.isArray(ctx.res.payload.data.providers));
    assert.equal(typeof ctx.res.payload.data.reportSummary.leads.total, 'number');
    assert.ok(Array.isArray(ctx.res.payload.data.consultationWorkspace.consultations));
    assert.equal(typeof ctx.res.payload.data.consultationWorkspace.snapshot.requested, 'number');
    assert.equal(ctx.res.payload.data.consultationWorkspace.appliedFilters.sort, 'claim_expiry');
    assert.equal(ctx.res.payload.data.consultationWorkspace.appliedFilters.status, 'REQUESTED');
    assert.equal(typeof ctx.res.payload.data.accountWorkspace.generatedAt, 'string');
    assert.equal(ctx.res.payload.data.accountWorkspace.role, 'coordinator');
    assert.ok(Array.isArray(ctx.res.payload.data.accountWorkspace.useCases.allowedActions));
    assert.ok(Array.isArray(ctx.res.payload.data.accountWorkspace.notificationInbox.items));
    if (ctx.res.payload.data.consultationWorkspace.consultations.length) {
      const comms = ctx.res.payload.data.consultationCommsBootstrap;
      assert.ok(comms);
      assert.equal(typeof comms.consultationId, 'string');
      assert.ok(Array.isArray(comms.sessions));
      assert.ok(Array.isArray(comms.interactions));
      assert.equal(typeof comms.interactionQuery, 'string');
      assert.equal(typeof comms.generatedAt, 'string');
    }
    assert.equal(typeof ctx.res.payload.data.generatedAt, 'string');
  } finally {
    await ctx.cleanup();
  }
});

test('consultation routes creates consultation and enforces clinician eligibility on claim', async () => {
  const createCtx = await buildContext({
    key: 'POST /api/v1/consultations',
    method: 'POST',
    user: null,
    body: {
      requestedNeed: 'Consult via integration route test',
      tier: 'priority',
      specialtyId: null,
      procedureId: null
    }
  });

  try {
    const db = await createCtx.store.read();
    const patient = db.users.find((item) => item.role === 'patient');
    const clinician = db.users.find((item) => item.role === 'clinician');
    const dialysis = db.procedures.find((item) => item.name === 'Dialysis');
    createCtx.readBody = async () => ({
      requestedNeed: 'Kidney consultation needed',
      tier: 'priority',
      specialtyId: dialysis.specialtyId,
      procedureId: dialysis.id
    });

    await handleConsultationRoutes({
      req: createCtx.req,
      res: createCtx.res,
      key: createCtx.key,
      parts: [],
      store: createCtx.store,
      sendJson: createCtx.sendJson,
      requireUser: async () => patient,
      readBody: createCtx.readBody,
      requireFields: createCtx.requireFields
    });

    const created = createCtx.res.payload.data;
    assert.equal(createCtx.res.status, 201);

    const claimCtx = await buildContext({
      method: 'POST',
      parts: ['api', 'v1', 'consultations', created.id, 'claim']
    });

    claimCtx.store = createCtx.store;
    claimCtx.req.method = 'POST';

    await assert.rejects(async () => {
      await handleConsultationRoutes({
        req: claimCtx.req,
        res: claimCtx.res,
        key: '',
        parts: claimCtx.parts,
        store: claimCtx.store,
        sendJson: claimCtx.sendJson,
        requireUser: async () => clinician,
        readBody: claimCtx.readBody,
        requireFields: claimCtx.requireFields
      });
    }, /not eligible/);

    await claimCtx.cleanup();
  } finally {
    await createCtx.cleanup();
  }
});

test('consultation routes expose patient medical records to assigned clinician', async () => {
  const ctx = await buildContext({ key: 'POST /api/v1/consultations', method: 'POST' });

  try {
    const db = await ctx.store.read();
    const patient = db.users.find((item) => item.role === 'patient');
    const clinician = db.users.find((item) => item.role === 'clinician');

    ctx.readBody = async () => ({
      requestedNeed: 'Need clinician record visibility',
      tier: 'priority',
      specialtyId: db.procedures[0].specialtyId,
      procedureId: db.procedures[0].id
    });

    let handled = await handleConsultationRoutes({
      req: ctx.req,
      res: ctx.res,
      key: ctx.key,
      parts: [],
      store: ctx.store,
      sendJson: ctx.sendJson,
      requireUser: async () => patient,
      readBody: ctx.readBody,
      requireFields: ctx.requireFields
    });

    assert.equal(handled, true);
    assert.equal(ctx.res.status, 201);
    const consultationId = ctx.res.payload.data.id;

    ctx.key = '';
    ctx.parts = ['api', 'v1', 'consultations', consultationId, 'claim'];
    ctx.req.method = 'POST';
    handled = await handleConsultationRoutes({
      req: ctx.req,
      res: ctx.res,
      key: ctx.key,
      parts: ctx.parts,
      store: ctx.store,
      sendJson: ctx.sendJson,
      requireUser: async () => clinician,
      readBody: ctx.readBody,
      requireFields: ctx.requireFields
    });

    assert.equal(handled, true);
    assert.equal(ctx.res.status, 200);

    await ctx.store.update((dbRef) => {
      dbRef.medicalRecords ||= [];
      dbRef.medicalRecords.push({
        id: 'med_route_1',
        patientId: patient.patientId,
        consultationId,
        sourceSystem: 'openemr_compatible',
        externalRecordId: 'EMR-ROUTE-001',
        recordType: 'lab_result',
        title: 'HbA1c panel',
        summary: 'HbA1c at 6.4% from last quarter.',
        status: 'active',
        recordedAt: '2026-01-01T10:00:00.000Z',
        updatedAt: '2026-01-01T10:00:00.000Z',
        coding: null
      });
    });

    ctx.parts = ['api', 'v1', 'consultations', consultationId, 'patient-medical-records'];
    ctx.req.method = 'GET';
    ctx.req.url = `/api/v1/consultations/${consultationId}/patient-medical-records?limit=10`;
    handled = await handleConsultationRoutes({
      req: ctx.req,
      res: ctx.res,
      key: ctx.key,
      parts: ctx.parts,
      store: ctx.store,
      sendJson: ctx.sendJson,
      requireUser: async () => clinician,
      readBody: ctx.readBody,
      requireFields: ctx.requireFields
    });

    assert.equal(handled, true);
    assert.equal(ctx.res.status, 200);
    assert.equal(ctx.res.payload.data.consultationId, consultationId);
    assert.equal(ctx.res.payload.data.integration.adapter, 'openemr-compatible');
    assert.ok(Array.isArray(ctx.res.payload.data.records));
    assert.ok(ctx.res.payload.data.records.some((item) => item.id === 'med_route_1'));

    const nonAssignedClinician = {
      ...clinician,
      id: 'user_other_clinician',
      email: 'other-clinician@mindset.local'
    };
    await assert.rejects(async () => {
      await handleConsultationRoutes({
        req: ctx.req,
        res: ctx.res,
        key: ctx.key,
        parts: ctx.parts,
        store: ctx.store,
        sendJson: ctx.sendJson,
        requireUser: async () => nonAssignedClinician,
        readBody: ctx.readBody,
        requireFields: ctx.requireFields
      });
    }, /assigned clinician, operations staff, or the patient/);
  } finally {
    await ctx.cleanup();
  }
});

test('lead/referral routes create lead and referral via conversion endpoint', async () => {
  const createLeadCtx = await buildContext({ key: 'POST /api/v1/leads', method: 'POST' });
  try {
    createLeadCtx.readBody = async () => ({
      name: 'Integration Lead',
      phone: '+2348012345678',
      healthcareRequirement: 'Needs follow-up consult',
      consentGiven: true,
      preferredUrgency: 'normal'
    });

    await handleLeadReferralRoutes({
      req: createLeadCtx.req,
      res: createLeadCtx.res,
      key: createLeadCtx.key,
      parts: [],
      store: createLeadCtx.store,
      sendJson: createLeadCtx.sendJson,
      requireUser: async () => createLeadCtx.coordinator,
      readBody: createLeadCtx.readBody,
      requireFields: createLeadCtx.requireFields,
      normalizeEmail: createLeadCtx.normalizeEmail,
      config: createLeadCtx.config,
      securityHeaders: createLeadCtx.securityHeaders,
      audit: createLeadCtx.audit,
      notify: createLeadCtx.notify,
      expandReferral: createLeadCtx.expandReferral,
      expandAppointment: createLeadCtx.expandAppointment,
      expandPayment: createLeadCtx.expandPayment
    });

    assert.equal(createLeadCtx.res.status, 201);
    const leadId = createLeadCtx.res.payload.data.id;

    const db = await createLeadCtx.store.read();
    const procedure = db.procedures[0];

    const convertCtx = await buildContext({
      method: 'POST',
      parts: ['api', 'v1', 'leads', leadId, 'convert-to-referral']
    });
    convertCtx.store = createLeadCtx.store;
    convertCtx.readBody = async () => ({ specialtyId: procedure.specialtyId, procedureId: procedure.id, consentGiven: true });

    await handleLeadReferralRoutes({
      req: convertCtx.req,
      res: convertCtx.res,
      key: '',
      parts: convertCtx.parts,
      store: convertCtx.store,
      sendJson: convertCtx.sendJson,
      requireUser: async () => convertCtx.coordinator,
      readBody: convertCtx.readBody,
      requireFields: convertCtx.requireFields,
      normalizeEmail: convertCtx.normalizeEmail,
      config: convertCtx.config,
      securityHeaders: convertCtx.securityHeaders,
      audit: convertCtx.audit,
      notify: convertCtx.notify,
      expandReferral: convertCtx.expandReferral,
      expandAppointment: convertCtx.expandAppointment,
      expandPayment: convertCtx.expandPayment
    });

    assert.equal(convertCtx.res.status, 201);
    assert.ok(convertCtx.res.payload.data.referralNumber);

    await convertCtx.cleanup();
  } finally {
    await createLeadCtx.cleanup();
  }
});

test('lead routes persist lead source attribution field', async () => {
  const ctx = await buildContext({ key: 'POST /api/v1/leads', method: 'POST' });

  try {
    ctx.readBody = async () => ({
      name: 'Attribution Lead',
      phone: '+2348010002222',
      healthcareRequirement: 'Specialist consultation request',
      consentGiven: true,
      preferredUrgency: 'priority',
      source: 'need_based_portfolio',
      channel: 'social'
    });

    const handled = await handleLeadReferralRoutes({
      req: ctx.req,
      res: ctx.res,
      key: ctx.key,
      parts: [],
      store: ctx.store,
      sendJson: ctx.sendJson,
      requireUser: async () => ctx.coordinator,
      readBody: ctx.readBody,
      requireFields: ctx.requireFields,
      normalizeEmail: ctx.normalizeEmail,
      config: ctx.config,
      securityHeaders: ctx.securityHeaders,
      audit: ctx.audit,
      notify: ctx.notify,
      expandReferral: ctx.expandReferral,
      expandAppointment: ctx.expandAppointment,
      expandPayment: ctx.expandPayment
    });

    assert.equal(handled, true);
    assert.equal(ctx.res.status, 201);
    assert.equal(ctx.res.payload.data.source, 'need_based_portfolio');
    assert.equal(ctx.res.payload.data.channel, 'social');
  } finally {
    await ctx.cleanup();
  }
});

test('data migration script helper backfills consultation collections and clinician availability', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mindset-migration-'));
  try {
    const filePath = join(directory, 'data.json');
    const legacy = {
      users: [{ id: 'u1', role: 'clinician' }],
      consultations: [{ id: 'c1', tier: 'normal', createdAt: '2026-01-01T00:00:00.000Z' }]
    };
    await import('../src/migrations.js').then(async ({ runDataMigrations }) => {
      const report = runDataMigrations(legacy);
      assert.equal(Array.isArray(legacy.consultationClaims), true);
      assert.equal(Array.isArray(legacy.biometricVerifications), true);
      assert.ok(legacy.consultations[0].consultationNumber);
      assert.equal(legacy.users[0].consultationAvailability.enabled, true);
      assert.ok(report.consultation.touched >= 1);
    });
    await readFile(filePath).catch(() => null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('account routes supports clinician availability get/update', async () => {
  const ctx = await buildContext({ key: 'GET /api/v1/account/clinician-availability' });
  try {
    const db = await ctx.store.read();
    const clinician = db.users.find((item) => item.role === 'clinician');

    let handled = await handleAccountRoutes({
      req: ctx.req,
      res: ctx.res,
      key: ctx.key,
      store: ctx.store,
      sendJson: ctx.sendJson,
      requireUser: async () => clinician,
      readBody: ctx.readBody,
      requireFields: ctx.requireFields,
      audit: ctx.audit,
      ensureConsultationCollections: (dbRef) => {
        dbRef.consultations ||= [];
        dbRef.consultationClaims ||= [];
        dbRef.biometricVerifications ||= [];
      }
    });

    assert.equal(handled, true);
    assert.equal(ctx.res.status, 200);
    assert.equal(ctx.res.payload.data.enabled, true);

    ctx.key = 'PATCH /api/v1/account/clinician-availability';
    ctx.req.method = 'PATCH';
    const nephrology = db.specialties.find((item) => item.name === 'Nephrology');
    const dialysis = db.procedures.find((item) => item.name === 'Dialysis');
    ctx.readBody = async () => ({
      enabled: true,
      acceptedTiers: ['priority', 'super_priority'],
      specialtyIds: [nephrology.id],
      procedureIds: [dialysis.id]
    });

    handled = await handleAccountRoutes({
      req: ctx.req,
      res: ctx.res,
      key: ctx.key,
      store: ctx.store,
      sendJson: ctx.sendJson,
      requireUser: async () => clinician,
      readBody: ctx.readBody,
      requireFields: ctx.requireFields,
      audit: ctx.audit,
      ensureConsultationCollections: (dbRef) => {
        dbRef.consultations ||= [];
        dbRef.consultationClaims ||= [];
        dbRef.biometricVerifications ||= [];
      }
    });

    assert.equal(handled, true);
    assert.equal(ctx.res.status, 200);
    assert.deepEqual(ctx.res.payload.data.procedureIds, [dialysis.id]);
  } finally {
    await ctx.cleanup();
  }
});

test('account routes supports notification preferences get/update', async () => {
  const ctx = await buildContext({ key: 'GET /api/v1/account/notification-preferences' });
  try {
    const db = await ctx.store.read();
    const patient = db.users.find((item) => item.role === 'patient');

    let handled = await handleAccountRoutes({
      req: ctx.req,
      res: ctx.res,
      key: ctx.key,
      store: ctx.store,
      sendJson: ctx.sendJson,
      requireUser: async () => patient,
      readBody: ctx.readBody,
      requireFields: ctx.requireFields,
      audit: ctx.audit,
      ensureConsultationCollections: (dbRef) => {
        dbRef.consultations ||= [];
        dbRef.consultationClaims ||= [];
        dbRef.biometricVerifications ||= [];
      }
    });

    assert.equal(handled, true);
    assert.equal(ctx.res.status, 200);
    assert.deepEqual(ctx.res.payload.data.consultations.preferredChannels, ['sms', 'email']);
    assert.equal(ctx.res.payload.data.consultations.emailCopyEnabled, true);

    ctx.key = 'PATCH /api/v1/account/notification-preferences';
    ctx.req.method = 'PATCH';
    ctx.readBody = async () => ({ consultations: { preferredChannels: ['email', 'in_app'], emailCopyEnabled: false } });

    handled = await handleAccountRoutes({
      req: ctx.req,
      res: ctx.res,
      key: ctx.key,
      store: ctx.store,
      sendJson: ctx.sendJson,
      requireUser: async () => patient,
      readBody: ctx.readBody,
      requireFields: ctx.requireFields,
      audit: ctx.audit,
      ensureConsultationCollections: (dbRef) => {
        dbRef.consultations ||= [];
        dbRef.consultationClaims ||= [];
        dbRef.biometricVerifications ||= [];
      }
    });

    assert.equal(handled, true);
    assert.equal(ctx.res.status, 200);
    assert.deepEqual(ctx.res.payload.data.consultations.preferredChannels, ['email', 'in_app']);
    assert.equal(ctx.res.payload.data.consultations.emailCopyEnabled, false);
  } finally {
    await ctx.cleanup();
  }
});

test('account routes supports notification inbox listing and read updates', async () => {
  const ctx = await buildContext({
    key: 'GET /api/v1/account/notifications',
    method: 'GET'
  });

  try {
    const db = await ctx.store.read();
    const patient = db.users.find((item) => item.role === 'patient');

    await ctx.store.update((dbRef) => {
      dbRef.notificationLogs.push(
        {
          id: 'notification_route_unread',
          referralId: null,
          consultationId: 'consult_route',
          userId: patient.id,
          channel: 'in_app',
          notificationType: 'communication',
          severity: 'warning',
          eventKey: 'consultation_call_waiting_room',
          recipient: `user:${patient.id}`,
          subject: 'Waiting room',
          body: 'Provider is ready for your session.',
          status: 'sent',
          createdAt: '2026-01-01T10:00:00.000Z',
          sentAt: '2026-01-01T10:00:00.000Z',
          updatedAt: '2026-01-01T10:00:00.000Z'
        },
        {
          id: 'notification_route_read',
          referralId: null,
          consultationId: 'consult_route',
          userId: patient.id,
          channel: 'email',
          notificationType: 'consultation',
          severity: 'info',
          eventKey: 'consultation_completed',
          recipient: patient.email,
          subject: 'Summary',
          body: 'Consultation summary sent.',
          status: 'sent',
          readAt: '2026-01-01T10:30:00.000Z',
          createdAt: '2026-01-01T10:20:00.000Z',
          sentAt: '2026-01-01T10:20:00.000Z',
          updatedAt: '2026-01-01T10:30:00.000Z'
        },
        {
          id: 'notification_route_critical',
          referralId: null,
          consultationId: 'consult_route',
          userId: patient.id,
          channel: 'sms',
          notificationType: 'consultation',
          severity: 'critical',
          eventKey: 'consultation_claim_window_expired',
          recipient: patient.phone,
          subject: 'Claim window expired',
          body: 'Escalation team is being notified.',
          status: 'sent',
          createdAt: '2026-01-01T10:40:00.000Z',
          sentAt: '2026-01-01T10:40:00.000Z',
          updatedAt: '2026-01-01T10:40:00.000Z'
        }
      );
    });

    ctx.req.url = '/api/v1/account/notifications?channel=all&unreadOnly=true&limit=20';
    let handled = await handleAccountRoutes({
      req: ctx.req,
      res: ctx.res,
      key: ctx.key,
      store: ctx.store,
      sendJson: ctx.sendJson,
      requireUser: async () => patient,
      readBody: ctx.readBody,
      requireFields: ctx.requireFields,
      audit: ctx.audit,
      ensureConsultationCollections: (dbRef) => {
        dbRef.consultations ||= [];
        dbRef.consultationClaims ||= [];
        dbRef.biometricVerifications ||= [];
      }
    });

    assert.equal(handled, true);
    assert.equal(ctx.res.status, 200);
    assert.equal(ctx.res.payload.data.meta.unreadCount, 2);
    assert.equal(ctx.res.payload.data.meta.visibleUnreadCount, 2);
    assert.equal(ctx.res.payload.data.items.length, 2);
    assert.ok(ctx.res.payload.data.items.some((item) => item.id === 'notification_route_unread'));

    ctx.req.url = '/api/v1/account/notifications?channel=all&type=communication&severity=warning&limit=20';
    handled = await handleAccountRoutes({
      req: ctx.req,
      res: ctx.res,
      key: 'GET /api/v1/account/notifications',
      store: ctx.store,
      sendJson: ctx.sendJson,
      requireUser: async () => patient,
      readBody: ctx.readBody,
      requireFields: ctx.requireFields,
      audit: ctx.audit,
      ensureConsultationCollections: (dbRef) => {
        dbRef.consultations ||= [];
        dbRef.consultationClaims ||= [];
        dbRef.biometricVerifications ||= [];
      }
    });

    assert.equal(handled, true);
    assert.equal(ctx.res.status, 200);
    assert.equal(ctx.res.payload.data.items.length, 1);
    assert.equal(ctx.res.payload.data.items[0].notificationType, 'communication');
    assert.equal(ctx.res.payload.data.items[0].severity, 'warning');

    ctx.key = 'GET /api/v1/account/notifications/summary';
    ctx.req.method = 'GET';
    ctx.req.url = '/api/v1/account/notifications/summary';

    handled = await handleAccountRoutes({
      req: ctx.req,
      res: ctx.res,
      key: ctx.key,
      store: ctx.store,
      sendJson: ctx.sendJson,
      requireUser: async () => patient,
      readBody: ctx.readBody,
      requireFields: ctx.requireFields,
      audit: ctx.audit,
      ensureConsultationCollections: (dbRef) => {
        dbRef.consultations ||= [];
        dbRef.consultationClaims ||= [];
        dbRef.biometricVerifications ||= [];
      }
    });

    assert.equal(handled, true);
    assert.equal(ctx.res.status, 200);
    assert.equal(ctx.res.payload.data.unreadCount, 2);
    assert.equal(ctx.res.payload.data.totalCount, 3);
    assert.equal(ctx.res.payload.data.hasUnread, true);
    assert.equal(ctx.res.payload.data.unreadBySeverity.warning, 1);
    assert.equal(ctx.res.payload.data.unreadBySeverity.critical, 1);

    ctx.key = 'POST /api/v1/account/notifications/read';
    ctx.req.method = 'POST';
    ctx.readBody = async () => ({
      markFiltered: true,
      filters: {
        channel: 'all',
        type: 'communication',
        severity: 'warning',
        unreadOnly: true
      }
    });

    handled = await handleAccountRoutes({
      req: ctx.req,
      res: ctx.res,
      key: ctx.key,
      store: ctx.store,
      sendJson: ctx.sendJson,
      requireUser: async () => patient,
      readBody: ctx.readBody,
      requireFields: ctx.requireFields,
      audit: ctx.audit,
      ensureConsultationCollections: (dbRef) => {
        dbRef.consultations ||= [];
        dbRef.consultationClaims ||= [];
        dbRef.biometricVerifications ||= [];
      }
    });

    assert.equal(handled, true);
    assert.equal(ctx.res.status, 200);
    assert.equal(ctx.res.payload.data.updatedCount, 1);
    assert.equal(ctx.res.payload.data.unreadCount, 1);
    assert.equal(ctx.res.payload.data.appliedFilters.type, 'communication');

    ctx.key = 'GET /api/v1/account/notifications/summary';
    ctx.req.method = 'GET';
    handled = await handleAccountRoutes({
      req: ctx.req,
      res: ctx.res,
      key: ctx.key,
      store: ctx.store,
      sendJson: ctx.sendJson,
      requireUser: async () => patient,
      readBody: ctx.readBody,
      requireFields: ctx.requireFields,
      audit: ctx.audit,
      ensureConsultationCollections: (dbRef) => {
        dbRef.consultations ||= [];
        dbRef.consultationClaims ||= [];
        dbRef.biometricVerifications ||= [];
      }
    });

    assert.equal(handled, true);
    assert.equal(ctx.res.status, 200);
    assert.equal(ctx.res.payload.data.unreadCount, 1);
    assert.equal(ctx.res.payload.data.hasUnread, true);
    assert.equal(ctx.res.payload.data.unreadBySeverity.warning, 0);
    assert.equal(ctx.res.payload.data.unreadBySeverity.critical, 1);

    ctx.key = 'POST /api/v1/account/notifications/read';
    ctx.req.method = 'POST';
    ctx.readBody = async () => ({ markAll: true });

    handled = await handleAccountRoutes({
      req: ctx.req,
      res: ctx.res,
      key: ctx.key,
      store: ctx.store,
      sendJson: ctx.sendJson,
      requireUser: async () => patient,
      readBody: ctx.readBody,
      requireFields: ctx.requireFields,
      audit: ctx.audit,
      ensureConsultationCollections: (dbRef) => {
        dbRef.consultations ||= [];
        dbRef.consultationClaims ||= [];
        dbRef.biometricVerifications ||= [];
      }
    });

    assert.equal(handled, true);
    assert.equal(ctx.res.status, 200);
    assert.equal(ctx.res.payload.data.updatedCount, 1);
    assert.equal(ctx.res.payload.data.unreadCount, 0);

    ctx.key = 'GET /api/v1/account/notifications/summary';
    ctx.req.method = 'GET';
    handled = await handleAccountRoutes({
      req: ctx.req,
      res: ctx.res,
      key: ctx.key,
      store: ctx.store,
      sendJson: ctx.sendJson,
      requireUser: async () => patient,
      readBody: ctx.readBody,
      requireFields: ctx.requireFields,
      audit: ctx.audit,
      ensureConsultationCollections: (dbRef) => {
        dbRef.consultations ||= [];
        dbRef.consultationClaims ||= [];
        dbRef.biometricVerifications ||= [];
      }
    });

    assert.equal(handled, true);
    assert.equal(ctx.res.status, 200);
    assert.equal(ctx.res.payload.data.unreadCount, 0);
    assert.equal(ctx.res.payload.data.hasUnread, false);
  } finally {
    await ctx.cleanup();
  }
});

test('document routes supports upload metadata and rejects unsafe download paths', async () => {
  const ctx = await buildContext({ method: 'POST', parts: ['api', 'v1', 'referrals', 'REF-2026-0001', 'documents'] });
  try {
    const db = await ctx.store.read();
    const patient = db.patients[0];
    const specialty = db.specialties[0];
    const procedure = db.procedures.find((item) => item.specialtyId === specialty.id);
    const referral = {
      id: 'ref_test',
      referralNumber: 'REF-2026-0001',
      patientId: patient.id,
      specialtyId: specialty.id,
      procedureId: procedure.id,
      status: 'submitted',
      assignedProviderId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    await ctx.store.update((dbRef) => {
      dbRef.referrals.push(referral);
    });

    ctx.readBody = async () => ({
      documentType: 'supporting',
      fileName: 'note.txt',
      storagePath: 'pending/REF-2026-0001/note.txt'
    });

    let handled = await handleDocumentRoutes({
      req: ctx.req,
      res: ctx.res,
      key: '',
      parts: ctx.parts,
      store: ctx.store,
      sendJson: ctx.sendJson,
      requireUser: async () => ctx.coordinator,
      readBody: ctx.readBody,
      requireFields: ctx.requireFields,
      config: ctx.config,
      securityHeaders: ctx.securityHeaders,
      audit: ctx.audit
    });

    assert.equal(handled, true);
    assert.equal(ctx.res.status, 201);
    const documentId = ctx.res.payload.data.id;

    await ctx.store.update((dbRef) => {
      const document = dbRef.documents.find((item) => item.id === documentId);
      document.storageDisk = 'private-local';
      document.storagePath = '../escape.txt';
    });

    ctx.req.method = 'GET';
    ctx.parts = ['api', 'v1', 'documents', documentId, 'download'];
    await assert.rejects(async () => {
      handled = await handleDocumentRoutes({
        req: ctx.req,
        res: ctx.res,
        key: '',
        parts: ctx.parts,
        store: ctx.store,
        sendJson: ctx.sendJson,
        requireUser: async () => ctx.coordinator,
        readBody: ctx.readBody,
        requireFields: ctx.requireFields,
        config: ctx.config,
        securityHeaders: ctx.securityHeaders,
        audit: ctx.audit
      });
      assert.equal(handled, true);
    }, /Document not found/);
  } finally {
    await ctx.cleanup();
  }
});

test('consultation session routes enforce tier channel and support open/close lifecycle', async () => {
  const ctx = await buildContext({ key: 'POST /api/v1/consultations', method: 'POST' });
  try {
    const db = await ctx.store.read();
    const patient = db.users.find((item) => item.role === 'patient');
    const clinician = db.users.find((item) => item.role === 'clinician');

    ctx.readBody = async () => ({
      requestedNeed: 'Priority communication session test',
      tier: 'priority',
      requestedCommunicationMode: 'voice_call'
    });

    await handleConsultationRoutes({
      req: ctx.req,
      res: ctx.res,
      key: ctx.key,
      parts: [],
      store: ctx.store,
      sendJson: ctx.sendJson,
      requireUser: async () => patient,
      readBody: ctx.readBody,
      requireFields: ctx.requireFields
    });

    const consultation = ctx.res.payload.data;

    await handleConsultationRoutes({
      req: { ...ctx.req, method: 'POST' },
      res: ctx.res,
      key: '',
      parts: ['api', 'v1', 'consultations', consultation.id, 'claim'],
      store: ctx.store,
      sendJson: ctx.sendJson,
      requireUser: async () => clinician,
      readBody: async () => ({}),
      requireFields: ctx.requireFields
    });

    await handleConsultationRoutes({
      req: { ...ctx.req, method: 'POST' },
      res: ctx.res,
      key: '',
      parts: ['api', 'v1', 'consultations', consultation.id, 'start'],
      store: ctx.store,
      sendJson: ctx.sendJson,
      requireUser: async () => clinician,
      readBody: async () => ({}),
      requireFields: ctx.requireFields
    });

    await handleConsultationRoutes({
      req: { ...ctx.req, method: 'POST' },
      res: ctx.res,
      key: '',
      parts: ['api', 'v1', 'consultations', consultation.id, 'sessions'],
      store: ctx.store,
      sendJson: ctx.sendJson,
      requireUser: async () => clinician,
      readBody: async () => ({ channel: 'video_call' }),
      requireFields: ctx.requireFields
    });

    assert.equal(ctx.res.status, 201);
    assert.equal(ctx.res.payload.data.channel, 'video_call');
    const firstSession = ctx.res.payload.data;

    await assert.rejects(async () => {
      await handleConsultationRoutes({
        req: { ...ctx.req, method: 'POST' },
        res: ctx.res,
        key: '',
        parts: ['api', 'v1', 'consultations', consultation.id, 'sessions'],
        store: ctx.store,
        sendJson: ctx.sendJson,
        requireUser: async () => clinician,
        readBody: async () => ({ channel: 'voice_call' }),
        requireFields: ctx.requireFields
      });
    }, /already exists/);

    await handleConsultationRoutes({
      req: { ...ctx.req, method: 'POST' },
      res: ctx.res,
      key: '',
      parts: ['api', 'v1', 'consultations', consultation.id, 'sessions', firstSession.id, 'close'],
      store: ctx.store,
      sendJson: ctx.sendJson,
      requireUser: async () => clinician,
      readBody: async () => ({ reason: 'switch_channel' }),
      requireFields: ctx.requireFields
    });

    assert.equal(ctx.res.status, 200);
    assert.equal(ctx.res.payload.data.status, 'completed');

    await handleConsultationRoutes({
      req: { ...ctx.req, method: 'POST' },
      res: ctx.res,
      key: '',
      parts: ['api', 'v1', 'consultations', consultation.id, 'sessions'],
      store: ctx.store,
      sendJson: ctx.sendJson,
      requireUser: async () => clinician,
      readBody: async () => ({ channel: 'voice_call' }),
      requireFields: ctx.requireFields
    });

    assert.equal(ctx.res.status, 201);
    const session = ctx.res.payload.data;

    await handleConsultationRoutes({
      req: { ...ctx.req, method: 'POST' },
      res: ctx.res,
      key: '',
      parts: ['api', 'v1', 'consultations', consultation.id, 'sessions', session.id, 'close'],
      store: ctx.store,
      sendJson: ctx.sendJson,
      requireUser: async () => clinician,
      readBody: async () => ({ reason: 'finished' }),
      requireFields: ctx.requireFields
    });

    assert.equal(ctx.res.status, 200);
    assert.equal(ctx.res.payload.data.status, 'completed');
  } finally {
    await ctx.cleanup();
  }
});

test('consultation routes require reasons for cancel and session close endpoints', async () => {
  const ctx = await buildContext({ key: 'POST /api/v1/consultations', method: 'POST' });
  try {
    const db = await ctx.store.read();
    const patient = db.users.find((item) => item.role === 'patient');
    const clinician = db.users.find((item) => item.role === 'clinician');

    ctx.readBody = async () => ({
      requestedNeed: 'Reason enforcement integration test',
      tier: 'priority',
      requestedCommunicationMode: 'voice_call'
    });

    await handleConsultationRoutes({
      req: ctx.req,
      res: ctx.res,
      key: ctx.key,
      parts: [],
      store: ctx.store,
      sendJson: ctx.sendJson,
      requireUser: async () => patient,
      readBody: ctx.readBody,
      requireFields: ctx.requireFields
    });

    const consultation = ctx.res.payload.data;

    await assert.rejects(async () => {
      await handleConsultationRoutes({
        req: { ...ctx.req, method: 'POST' },
        res: ctx.res,
        key: '',
        parts: ['api', 'v1', 'consultations', consultation.id, 'cancel'],
        store: ctx.store,
        sendJson: ctx.sendJson,
        requireUser: async () => patient,
        readBody: async () => ({ reason: '  ' }),
        requireFields: ctx.requireFields
      });
    }, /Cancellation reason is required/);

    await handleConsultationRoutes({
      req: { ...ctx.req, method: 'POST' },
      res: ctx.res,
      key: '',
      parts: ['api', 'v1', 'consultations', consultation.id, 'claim'],
      store: ctx.store,
      sendJson: ctx.sendJson,
      requireUser: async () => clinician,
      readBody: async () => ({}),
      requireFields: ctx.requireFields
    });

    await handleConsultationRoutes({
      req: { ...ctx.req, method: 'POST' },
      res: ctx.res,
      key: '',
      parts: ['api', 'v1', 'consultations', consultation.id, 'start'],
      store: ctx.store,
      sendJson: ctx.sendJson,
      requireUser: async () => clinician,
      readBody: async () => ({}),
      requireFields: ctx.requireFields
    });

    await handleConsultationRoutes({
      req: { ...ctx.req, method: 'POST' },
      res: ctx.res,
      key: '',
      parts: ['api', 'v1', 'consultations', consultation.id, 'sessions'],
      store: ctx.store,
      sendJson: ctx.sendJson,
      requireUser: async () => clinician,
      readBody: async () => ({ channel: 'voice_call' }),
      requireFields: ctx.requireFields
    });

    const session = ctx.res.payload.data;
    await assert.rejects(async () => {
      await handleConsultationRoutes({
        req: { ...ctx.req, method: 'POST' },
        res: ctx.res,
        key: '',
        parts: ['api', 'v1', 'consultations', consultation.id, 'sessions', session.id, 'close'],
        store: ctx.store,
        sendJson: ctx.sendJson,
        requireUser: async () => clinician,
        readBody: async () => ({ reason: '' }),
        requireFields: ctx.requireFields
      });
    }, /Session close reason is required/);
  } finally {
    await ctx.cleanup();
  }
});

test('consultation SLA route returns operational alerts payload', async () => {
  const ctx = await buildContext({ key: 'GET /api/v1/operations/consultation-sla' });
  try {
    const handled = await handleConsultationRoutes({
      req: ctx.req,
      res: ctx.res,
      key: ctx.key,
      parts: [],
      store: ctx.store,
      sendJson: ctx.sendJson,
      requireUser: async () => ctx.coordinator,
      readBody: ctx.readBody,
      requireFields: ctx.requireFields
    });

    assert.equal(handled, true);
    assert.equal(ctx.res.status, 200);
    assert.ok(typeof ctx.res.payload.data.acceptanceWindowSeconds === 'number');
    assert.ok(typeof ctx.res.payload.data.medianClaimTimeSeconds === 'number');
    assert.ok(typeof ctx.res.payload.data.p90ClaimTimeSeconds === 'number');
    assert.ok(typeof ctx.res.payload.data.holdReleaseRatePercent === 'number');
    assert.ok(ctx.res.payload.data.riskDistribution);
    assert.ok(typeof ctx.res.payload.data.riskDistribution.critical === 'number');
    assert.ok(typeof ctx.res.payload.data.riskDistribution.warning === 'number');
    assert.ok(typeof ctx.res.payload.data.riskDistribution.stable === 'number');
    assert.ok(typeof ctx.res.payload.data.criticalRiskPercent === 'number');
    assert.ok(typeof ctx.res.payload.data.interactionsLast24h === 'number');
    assert.ok(ctx.res.payload.data.interactionBreakdownLast24h);
    assert.ok(typeof ctx.res.payload.data.interactionBreakdownLast24h.patientMessages === 'number');
    assert.ok(typeof ctx.res.payload.data.interactionBreakdownLast24h.clinicianMessages === 'number');
    assert.ok(typeof ctx.res.payload.data.interactionBreakdownLast24h.sessionMarkers === 'number');
    assert.ok(typeof ctx.res.payload.data.interactionBreakdownLast24h.clinicalNotes === 'number');
    assert.ok(typeof ctx.res.payload.data.activeSessions === 'number');
    assert.ok(typeof ctx.res.payload.data.interactionsPerActiveSessionLast24h === 'number');
    assert.ok(ctx.res.payload.data.alerts);
    assert.ok(Array.isArray(ctx.res.payload.data.alerts.alerts));
    assert.ok(Array.isArray(ctx.res.payload.data.alerts.alertDetails));
    assert.ok(typeof ctx.res.payload.data.alerts.claims.conflictsLast24h === 'number');
    assert.ok(['ok', 'warning', 'critical'].includes(ctx.res.payload.data.alerts.highestSeverity));
    if (ctx.res.payload.data.alerts.alertDetails.length) {
      assert.ok(typeof ctx.res.payload.data.alerts.alertDetails[0].remediation === 'string');
    }
  } finally {
    await ctx.cleanup();
  }
});

test('consultation session interaction routes support channel-specific events', async () => {
  const ctx = await buildContext({ key: 'POST /api/v1/consultations', method: 'POST' });
  try {
    const db = await ctx.store.read();
    const patient = db.users.find((item) => item.role === 'patient');
    const clinician = db.users.find((item) => item.role === 'clinician');

    ctx.readBody = async () => ({
      requestedNeed: 'Interaction route integration test',
      tier: 'priority',
      requestedCommunicationMode: 'voice_call'
    });

    await handleConsultationRoutes({
      req: ctx.req,
      res: ctx.res,
      key: ctx.key,
      parts: [],
      store: ctx.store,
      sendJson: ctx.sendJson,
      requireUser: async () => patient,
      readBody: ctx.readBody,
      requireFields: ctx.requireFields
    });

    const consultation = ctx.res.payload.data;

    await handleConsultationRoutes({
      req: { ...ctx.req, method: 'POST' },
      res: ctx.res,
      key: '',
      parts: ['api', 'v1', 'consultations', consultation.id, 'claim'],
      store: ctx.store,
      sendJson: ctx.sendJson,
      requireUser: async () => clinician,
      readBody: async () => ({}),
      requireFields: ctx.requireFields
    });

    await handleConsultationRoutes({
      req: { ...ctx.req, method: 'POST' },
      res: ctx.res,
      key: '',
      parts: ['api', 'v1', 'consultations', consultation.id, 'start'],
      store: ctx.store,
      sendJson: ctx.sendJson,
      requireUser: async () => clinician,
      readBody: async () => ({}),
      requireFields: ctx.requireFields
    });

    await handleConsultationRoutes({
      req: { ...ctx.req, method: 'POST' },
      res: ctx.res,
      key: '',
      parts: ['api', 'v1', 'consultations', consultation.id, 'sessions'],
      store: ctx.store,
      sendJson: ctx.sendJson,
      requireUser: async () => clinician,
      readBody: async () => ({ channel: 'voice_call' }),
      requireFields: ctx.requireFields
    });

    const session = ctx.res.payload.data;

    await handleConsultationRoutes({
      req: { ...ctx.req, method: 'POST' },
      res: ctx.res,
      key: '',
      parts: ['api', 'v1', 'consultations', consultation.id, 'sessions', session.id, 'interactions'],
      store: ctx.store,
      sendJson: ctx.sendJson,
      requireUser: async () => clinician,
      readBody: async () => ({ interactionType: 'session_marker', marker: 'connected' }),
      requireFields: ctx.requireFields
    });

    assert.equal(ctx.res.status, 201);
    assert.equal(ctx.res.payload.data.interactionType, 'session_marker');

    await handleConsultationRoutes({
      req: { ...ctx.req, method: 'GET' },
      res: ctx.res,
      key: '',
      parts: ['api', 'v1', 'consultations', consultation.id, 'sessions', session.id, 'interactions'],
      store: ctx.store,
      sendJson: ctx.sendJson,
      requireUser: async () => clinician,
      readBody: ctx.readBody,
      requireFields: ctx.requireFields
    });

    assert.equal(ctx.res.status, 200);
    assert.ok(Array.isArray(ctx.res.payload.data));
    assert.equal(ctx.res.payload.data[0].marker, 'connected');
  } finally {
    await ctx.cleanup();
  }
});

test('consultation session call-config route returns signaling and ICE details for active call sessions', async () => {
  const ctx = await buildContext({ key: 'POST /api/v1/consultations', method: 'POST' });
  try {
    const db = await ctx.store.read();
    const patient = db.users.find((item) => item.role === 'patient');
    const clinician = db.users.find((item) => item.role === 'clinician');
    let iceClaims = null;

    ctx.readBody = async () => ({
      requestedNeed: 'Call config route integration test',
      tier: 'priority',
      requestedCommunicationMode: 'voice_call'
    });

    await handleConsultationRoutes({
      req: ctx.req,
      res: ctx.res,
      key: ctx.key,
      parts: [],
      store: ctx.store,
      sendJson: ctx.sendJson,
      requireUser: async () => patient,
      readBody: ctx.readBody,
      requireFields: ctx.requireFields
    });

    const consultation = ctx.res.payload.data;

    await handleConsultationRoutes({
      req: { ...ctx.req, method: 'POST' },
      res: ctx.res,
      key: '',
      parts: ['api', 'v1', 'consultations', consultation.id, 'claim'],
      store: ctx.store,
      sendJson: ctx.sendJson,
      requireUser: async () => clinician,
      readBody: async () => ({}),
      requireFields: ctx.requireFields
    });

    await handleConsultationRoutes({
      req: { ...ctx.req, method: 'POST' },
      res: ctx.res,
      key: '',
      parts: ['api', 'v1', 'consultations', consultation.id, 'start'],
      store: ctx.store,
      sendJson: ctx.sendJson,
      requireUser: async () => clinician,
      readBody: async () => ({}),
      requireFields: ctx.requireFields
    });

    await handleConsultationRoutes({
      req: { ...ctx.req, method: 'POST' },
      res: ctx.res,
      key: '',
      parts: ['api', 'v1', 'consultations', consultation.id, 'sessions'],
      store: ctx.store,
      sendJson: ctx.sendJson,
      requireUser: async () => clinician,
      readBody: async () => ({ channel: 'voice_call' }),
      requireFields: ctx.requireFields
    });

    const session = ctx.res.payload.data;

    await handleConsultationRoutes({
      req: { ...ctx.req, method: 'GET' },
      res: ctx.res,
      key: '',
      parts: ['api', 'v1', 'consultations', consultation.id, 'sessions', session.id, 'call-config'],
      store: ctx.store,
      sendJson: ctx.sendJson,
      requireUser: async () => clinician,
      readBody: ctx.readBody,
      requireFields: ctx.requireFields,
      createCallSignalToken: ({ consultationId, sessionId, userId }) => ({
        token: `${consultationId}:${sessionId}:${userId}`,
        expiresAt: '2099-01-01T00:00:00.000Z'
      }),
      buildCallSignalingUrl: (req, claims) => `ws://localhost${claims.consultationId}/${claims.sessionId}?signalToken=${claims.signalToken}`,
      getCallIceServers: (claims) => {
        iceClaims = claims;
        return {
          iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }],
          turnCredentialMode: 'ephemeral',
          turnCredentialExpiresAt: '2099-01-01T00:05:00.000Z'
        };
      }
    });

    assert.equal(ctx.res.status, 200);
    assert.equal(ctx.res.payload.data.channel, 'voice_call');
    assert.equal(ctx.res.payload.data.callState, 'idle');
    assert.equal(ctx.res.payload.data.consultationId, consultation.id);
    assert.equal(ctx.res.payload.data.sessionId, session.id);
    assert.equal(ctx.res.payload.data.selfUserId, clinician.id);
    assert.equal(ctx.res.payload.data.mediaConstraints.audio, true);
    assert.equal(ctx.res.payload.data.mediaConstraints.video, false);
    assert.equal(ctx.res.payload.data.turnCredentialMode, 'ephemeral');
    assert.equal(ctx.res.payload.data.turnCredentialExpiresAt, '2099-01-01T00:05:00.000Z');
    assert.ok(Array.isArray(ctx.res.payload.data.iceServers));
    assert.ok(String(ctx.res.payload.data.signalingUrl).includes('signalToken='));
    assert.equal(iceClaims?.consultationId, consultation.id);
    assert.equal(iceClaims?.sessionId, session.id);
    assert.equal(iceClaims?.userId, clinician.id);
  } finally {
    await ctx.cleanup();
  }
});

test('consultation call-state route supports waiting_room/provider_ready transitions and retrieval', async () => {
  const ctx = await buildContext({ key: 'POST /api/v1/consultations', method: 'POST' });
  try {
    const db = await ctx.store.read();
    const patient = db.users.find((item) => item.role === 'patient');
    const clinician = db.users.find((item) => item.role === 'clinician');

    ctx.readBody = async () => ({
      requestedNeed: 'Call state route integration test',
      tier: 'priority',
      requestedCommunicationMode: 'voice_call'
    });

    await handleConsultationRoutes({
      req: ctx.req,
      res: ctx.res,
      key: ctx.key,
      parts: [],
      store: ctx.store,
      sendJson: ctx.sendJson,
      requireUser: async () => patient,
      readBody: ctx.readBody,
      requireFields: ctx.requireFields
    });

    const consultation = ctx.res.payload.data;

    await handleConsultationRoutes({
      req: { ...ctx.req, method: 'POST' },
      res: ctx.res,
      key: '',
      parts: ['api', 'v1', 'consultations', consultation.id, 'claim'],
      store: ctx.store,
      sendJson: ctx.sendJson,
      requireUser: async () => clinician,
      readBody: async () => ({}),
      requireFields: ctx.requireFields
    });

    await handleConsultationRoutes({
      req: { ...ctx.req, method: 'POST' },
      res: ctx.res,
      key: '',
      parts: ['api', 'v1', 'consultations', consultation.id, 'start'],
      store: ctx.store,
      sendJson: ctx.sendJson,
      requireUser: async () => clinician,
      readBody: async () => ({}),
      requireFields: ctx.requireFields
    });

    await handleConsultationRoutes({
      req: { ...ctx.req, method: 'POST' },
      res: ctx.res,
      key: '',
      parts: ['api', 'v1', 'consultations', consultation.id, 'sessions'],
      store: ctx.store,
      sendJson: ctx.sendJson,
      requireUser: async () => clinician,
      readBody: async () => ({ channel: 'voice_call' }),
      requireFields: ctx.requireFields
    });

    const session = ctx.res.payload.data;

    await handleConsultationRoutes({
      req: { ...ctx.req, method: 'POST' },
      res: ctx.res,
      key: '',
      parts: ['api', 'v1', 'consultations', consultation.id, 'sessions', session.id, 'call-state'],
      store: ctx.store,
      sendJson: ctx.sendJson,
      requireUser: async () => clinician,
      readBody: async () => ({ state: 'waiting_room', reason: 'provider_joined' }),
      requireFields: ctx.requireFields
    });

    assert.equal(ctx.res.status, 200);
    assert.equal(ctx.res.payload.data.state, 'waiting_room');

    await handleConsultationRoutes({
      req: { ...ctx.req, method: 'POST' },
      res: ctx.res,
      key: '',
      parts: ['api', 'v1', 'consultations', consultation.id, 'sessions', session.id, 'call-state'],
      store: ctx.store,
      sendJson: ctx.sendJson,
      requireUser: async () => clinician,
      readBody: async () => ({ state: 'provider_ready', reason: 'provider_ready_button' }),
      requireFields: ctx.requireFields
    });

    assert.equal(ctx.res.status, 200);
    assert.equal(ctx.res.payload.data.state, 'provider_ready');

    await handleConsultationRoutes({
      req: { ...ctx.req, method: 'GET' },
      res: ctx.res,
      key: '',
      parts: ['api', 'v1', 'consultations', consultation.id, 'sessions', session.id, 'call-state'],
      store: ctx.store,
      sendJson: ctx.sendJson,
      requireUser: async () => clinician,
      readBody: ctx.readBody,
      requireFields: ctx.requireFields
    });

    assert.equal(ctx.res.status, 200);
    assert.equal(ctx.res.payload.data.state, 'provider_ready');
    assert.ok(Array.isArray(ctx.res.payload.data.history));

    await assert.rejects(async () => {
      await handleConsultationRoutes({
        req: { ...ctx.req, method: 'POST' },
        res: ctx.res,
        key: '',
        parts: ['api', 'v1', 'consultations', consultation.id, 'sessions', session.id, 'call-state'],
        store: ctx.store,
        sendJson: ctx.sendJson,
        requireUser: async () => patient,
        readBody: async () => ({ state: 'provider_ready', reason: 'patient_attempt' }),
        requireFields: ctx.requireFields
      });
    }, /Only clinicians or operations staff/);
  } finally {
    await ctx.cleanup();
  }
});

test('consultation session call-config route rejects non-call channels', async () => {
  const ctx = await buildContext({ key: 'POST /api/v1/consultations', method: 'POST' });
  try {
    const db = await ctx.store.read();
    const patient = db.users.find((item) => item.role === 'patient');
    const clinician = db.users.find((item) => item.role === 'clinician');

    ctx.readBody = async () => ({
      requestedNeed: 'Voice text route guard test',
      tier: 'normal',
      requestedCommunicationMode: 'voice_text'
    });

    await handleConsultationRoutes({
      req: ctx.req,
      res: ctx.res,
      key: ctx.key,
      parts: [],
      store: ctx.store,
      sendJson: ctx.sendJson,
      requireUser: async () => patient,
      readBody: ctx.readBody,
      requireFields: ctx.requireFields
    });

    const consultation = ctx.res.payload.data;

    await handleConsultationRoutes({
      req: { ...ctx.req, method: 'POST' },
      res: ctx.res,
      key: '',
      parts: ['api', 'v1', 'consultations', consultation.id, 'claim'],
      store: ctx.store,
      sendJson: ctx.sendJson,
      requireUser: async () => clinician,
      readBody: async () => ({}),
      requireFields: ctx.requireFields
    });

    await handleConsultationRoutes({
      req: { ...ctx.req, method: 'POST' },
      res: ctx.res,
      key: '',
      parts: ['api', 'v1', 'consultations', consultation.id, 'start'],
      store: ctx.store,
      sendJson: ctx.sendJson,
      requireUser: async () => clinician,
      readBody: async () => ({}),
      requireFields: ctx.requireFields
    });

    await handleConsultationRoutes({
      req: { ...ctx.req, method: 'POST' },
      res: ctx.res,
      key: '',
      parts: ['api', 'v1', 'consultations', consultation.id, 'sessions'],
      store: ctx.store,
      sendJson: ctx.sendJson,
      requireUser: async () => clinician,
      readBody: async () => ({ channel: 'voice_text' }),
      requireFields: ctx.requireFields
    });

    const session = ctx.res.payload.data;

    await assert.rejects(async () => {
      await handleConsultationRoutes({
        req: { ...ctx.req, method: 'GET' },
        res: ctx.res,
        key: '',
        parts: ['api', 'v1', 'consultations', consultation.id, 'sessions', session.id, 'call-config'],
        store: ctx.store,
        sendJson: ctx.sendJson,
        requireUser: async () => clinician,
        readBody: ctx.readBody,
        requireFields: ctx.requireFields,
        createCallSignalToken: () => ({ token: 'ignored', expiresAt: '2099-01-01T00:00:00.000Z' }),
        buildCallSignalingUrl: () => 'ws://localhost/realtime?signalToken=ignored',
        getCallIceServers: () => []
      });
    }, /Call transport is only available/);
  } finally {
    await ctx.cleanup();
  }
});

test('consultation interaction routes support type, actorRole, and limit query filters', async () => {
  const ctx = await buildContext({ key: 'POST /api/v1/consultations', method: 'POST' });
  try {
    const db = await ctx.store.read();
    const patient = db.users.find((item) => item.role === 'patient');
    const clinician = db.users.find((item) => item.role === 'clinician');

    ctx.readBody = async () => ({
      requestedNeed: 'Interaction query route integration test',
      tier: 'normal',
      requestedCommunicationMode: 'voice_text'
    });

    await handleConsultationRoutes({
      req: ctx.req,
      res: ctx.res,
      key: ctx.key,
      parts: [],
      store: ctx.store,
      sendJson: ctx.sendJson,
      requireUser: async () => patient,
      readBody: ctx.readBody,
      requireFields: ctx.requireFields
    });

    const consultation = ctx.res.payload.data;

    await handleConsultationRoutes({
      req: { ...ctx.req, method: 'POST' },
      res: ctx.res,
      key: '',
      parts: ['api', 'v1', 'consultations', consultation.id, 'claim'],
      store: ctx.store,
      sendJson: ctx.sendJson,
      requireUser: async () => clinician,
      readBody: async () => ({}),
      requireFields: ctx.requireFields
    });

    await handleConsultationRoutes({
      req: { ...ctx.req, method: 'POST' },
      res: ctx.res,
      key: '',
      parts: ['api', 'v1', 'consultations', consultation.id, 'start'],
      store: ctx.store,
      sendJson: ctx.sendJson,
      requireUser: async () => clinician,
      readBody: async () => ({}),
      requireFields: ctx.requireFields
    });

    await handleConsultationRoutes({
      req: { ...ctx.req, method: 'POST' },
      res: ctx.res,
      key: '',
      parts: ['api', 'v1', 'consultations', consultation.id, 'sessions'],
      store: ctx.store,
      sendJson: ctx.sendJson,
      requireUser: async () => clinician,
      readBody: async () => ({ channel: 'voice_text' }),
      requireFields: ctx.requireFields
    });

    const session = ctx.res.payload.data;

    await handleConsultationRoutes({
      req: { ...ctx.req, method: 'POST' },
      res: ctx.res,
      key: '',
      parts: ['api', 'v1', 'consultations', consultation.id, 'sessions', session.id, 'interactions'],
      store: ctx.store,
      sendJson: ctx.sendJson,
      requireUser: async () => patient,
      readBody: async () => ({ interactionType: 'patient_message', message: 'Patient update' }),
      requireFields: ctx.requireFields
    });

    await handleConsultationRoutes({
      req: { ...ctx.req, method: 'POST' },
      res: ctx.res,
      key: '',
      parts: ['api', 'v1', 'consultations', consultation.id, 'sessions', session.id, 'interactions'],
      store: ctx.store,
      sendJson: ctx.sendJson,
      requireUser: async () => clinician,
      readBody: async () => ({ interactionType: 'clinician_message', message: 'Clinician update' }),
      requireFields: ctx.requireFields
    });

    await handleConsultationRoutes({
      req: {
        ...ctx.req,
        method: 'GET',
        url: `/api/v1/consultations/${consultation.id}/sessions/${session.id}/interactions?type=clinician_message&actorRole=clinician&limit=1`
      },
      res: ctx.res,
      key: '',
      parts: ['api', 'v1', 'consultations', consultation.id, 'sessions', session.id, 'interactions'],
      store: ctx.store,
      sendJson: ctx.sendJson,
      requireUser: async () => clinician,
      readBody: ctx.readBody,
      requireFields: ctx.requireFields
    });

    assert.equal(ctx.res.status, 200);
    assert.ok(Array.isArray(ctx.res.payload.data));
    assert.equal(ctx.res.payload.data.length, 1);
    assert.equal(ctx.res.payload.data[0].interactionType, 'clinician_message');
    assert.equal(ctx.res.payload.data[0].createdByRole, 'clinician');
  } finally {
    await ctx.cleanup();
  }
});

test('consultation interaction routes accept human-readable interactionType labels', async () => {
  const ctx = await buildContext({ key: 'POST /api/v1/consultations', method: 'POST' });
  try {
    const db = await ctx.store.read();
    const patient = db.users.find((item) => item.role === 'patient');
    const clinician = db.users.find((item) => item.role === 'clinician');

    ctx.readBody = async () => ({
      requestedNeed: 'Interaction label normalization route test',
      tier: 'priority',
      requestedCommunicationMode: 'voice_call'
    });

    await handleConsultationRoutes({
      req: ctx.req,
      res: ctx.res,
      key: ctx.key,
      parts: [],
      store: ctx.store,
      sendJson: ctx.sendJson,
      requireUser: async () => patient,
      readBody: ctx.readBody,
      requireFields: ctx.requireFields
    });

    const consultation = ctx.res.payload.data;

    await handleConsultationRoutes({
      req: { ...ctx.req, method: 'POST' },
      res: ctx.res,
      key: '',
      parts: ['api', 'v1', 'consultations', consultation.id, 'claim'],
      store: ctx.store,
      sendJson: ctx.sendJson,
      requireUser: async () => clinician,
      readBody: async () => ({}),
      requireFields: ctx.requireFields
    });

    await handleConsultationRoutes({
      req: { ...ctx.req, method: 'POST' },
      res: ctx.res,
      key: '',
      parts: ['api', 'v1', 'consultations', consultation.id, 'start'],
      store: ctx.store,
      sendJson: ctx.sendJson,
      requireUser: async () => clinician,
      readBody: async () => ({}),
      requireFields: ctx.requireFields
    });

    await handleConsultationRoutes({
      req: { ...ctx.req, method: 'POST' },
      res: ctx.res,
      key: '',
      parts: ['api', 'v1', 'consultations', consultation.id, 'sessions'],
      store: ctx.store,
      sendJson: ctx.sendJson,
      requireUser: async () => clinician,
      readBody: async () => ({ channel: 'voice_call' }),
      requireFields: ctx.requireFields
    });

    const session = ctx.res.payload.data;

    await handleConsultationRoutes({
      req: { ...ctx.req, method: 'POST' },
      res: ctx.res,
      key: '',
      parts: ['api', 'v1', 'consultations', consultation.id, 'sessions', session.id, 'interactions'],
      store: ctx.store,
      sendJson: ctx.sendJson,
      requireUser: async () => clinician,
      readBody: async () => ({ interactionType: 'Session Marker', marker: 'connected' }),
      requireFields: ctx.requireFields
    });

    assert.equal(ctx.res.status, 201);
    assert.equal(ctx.res.payload.data.interactionType, 'session_marker');
  } finally {
    await ctx.cleanup();
  }
});

test('consultation events route returns aggregated timeline', async () => {
  const ctx = await buildContext({ key: 'POST /api/v1/consultations', method: 'POST' });
  try {
    const db = await ctx.store.read();
    const patient = db.users.find((item) => item.role === 'patient');
    const clinician = db.users.find((item) => item.role === 'clinician');

    ctx.readBody = async () => ({
      requestedNeed: 'Events route integration test',
      tier: 'normal',
      requestedCommunicationMode: 'voice_text'
    });

    await handleConsultationRoutes({
      req: ctx.req,
      res: ctx.res,
      key: ctx.key,
      parts: [],
      store: ctx.store,
      sendJson: ctx.sendJson,
      requireUser: async () => patient,
      readBody: ctx.readBody,
      requireFields: ctx.requireFields
    });

    const consultation = ctx.res.payload.data;

    await handleConsultationRoutes({
      req: { ...ctx.req, method: 'POST' },
      res: ctx.res,
      key: '',
      parts: ['api', 'v1', 'consultations', consultation.id, 'claim'],
      store: ctx.store,
      sendJson: ctx.sendJson,
      requireUser: async () => clinician,
      readBody: async () => ({}),
      requireFields: ctx.requireFields
    });

    await handleConsultationRoutes({
      req: { ...ctx.req, method: 'GET' },
      res: ctx.res,
      key: '',
      parts: ['api', 'v1', 'consultations', consultation.id, 'events'],
      store: ctx.store,
      sendJson: ctx.sendJson,
      requireUser: async () => clinician,
      readBody: ctx.readBody,
      requireFields: ctx.requireFields
    });

    assert.equal(ctx.res.status, 200);
    assert.ok(Array.isArray(ctx.res.payload.data));
    assert.ok(ctx.res.payload.data.some((item) => item.kind === 'state_transition'));
    assert.ok(ctx.res.payload.data.some((item) => item.kind === 'claim'));
  } finally {
    await ctx.cleanup();
  }
});

test('consultation events route supports kind query filter', async () => {
  const ctx = await buildContext({ key: 'POST /api/v1/consultations', method: 'POST' });
  try {
    const db = await ctx.store.read();
    const patient = db.users.find((item) => item.role === 'patient');
    const clinician = db.users.find((item) => item.role === 'clinician');

    ctx.readBody = async () => ({
      requestedNeed: 'Events filter route integration test',
      tier: 'priority',
      requestedCommunicationMode: 'voice_call'
    });

    await handleConsultationRoutes({
      req: ctx.req,
      res: ctx.res,
      key: ctx.key,
      parts: [],
      store: ctx.store,
      sendJson: ctx.sendJson,
      requireUser: async () => patient,
      readBody: ctx.readBody,
      requireFields: ctx.requireFields
    });

    const consultation = ctx.res.payload.data;

    await handleConsultationRoutes({
      req: { ...ctx.req, method: 'POST' },
      res: ctx.res,
      key: '',
      parts: ['api', 'v1', 'consultations', consultation.id, 'claim'],
      store: ctx.store,
      sendJson: ctx.sendJson,
      requireUser: async () => clinician,
      readBody: async () => ({}),
      requireFields: ctx.requireFields
    });

    await handleConsultationRoutes({
      req: { ...ctx.req, method: 'POST' },
      res: ctx.res,
      key: '',
      parts: ['api', 'v1', 'consultations', consultation.id, 'start'],
      store: ctx.store,
      sendJson: ctx.sendJson,
      requireUser: async () => clinician,
      readBody: async () => ({}),
      requireFields: ctx.requireFields
    });

    await handleConsultationRoutes({
      req: { ...ctx.req, method: 'POST' },
      res: ctx.res,
      key: '',
      parts: ['api', 'v1', 'consultations', consultation.id, 'sessions'],
      store: ctx.store,
      sendJson: ctx.sendJson,
      requireUser: async () => clinician,
      readBody: async () => ({ channel: 'voice_call' }),
      requireFields: ctx.requireFields
    });

    const session = ctx.res.payload.data;

    await handleConsultationRoutes({
      req: { ...ctx.req, method: 'POST' },
      res: ctx.res,
      key: '',
      parts: ['api', 'v1', 'consultations', consultation.id, 'sessions', session.id, 'interactions'],
      store: ctx.store,
      sendJson: ctx.sendJson,
      requireUser: async () => clinician,
      readBody: async () => ({ interactionType: 'session_marker', marker: 'connected' }),
      requireFields: ctx.requireFields
    });

    await handleConsultationRoutes({
      req: {
        ...ctx.req,
        method: 'GET',
        url: `/api/v1/consultations/${consultation.id}/events?kind=interaction&limit=5`
      },
      res: ctx.res,
      key: '',
      parts: ['api', 'v1', 'consultations', consultation.id, 'events'],
      store: ctx.store,
      sendJson: ctx.sendJson,
      requireUser: async () => clinician,
      readBody: ctx.readBody,
      requireFields: ctx.requireFields
    });

    assert.equal(ctx.res.status, 200);
    assert.ok(Array.isArray(ctx.res.payload.data));
    assert.ok(ctx.res.payload.data.length >= 1);
    assert.ok(ctx.res.payload.data.every((item) => item.kind === 'interaction'));
  } finally {
    await ctx.cleanup();
  }
});

test('consultations route supports sort query parameter', async () => {
  const ctx = await buildContext({ key: 'POST /api/v1/consultations', method: 'POST' });
  try {
    const db = await ctx.store.read();
    const patient = db.users.find((item) => item.role === 'patient');
    const coordinator = db.users.find((item) => item.role === 'coordinator');

    ctx.readBody = async () => ({
      requestedNeed: 'Sort query route test normal',
      tier: 'normal'
    });
    await handleConsultationRoutes({
      req: ctx.req,
      res: ctx.res,
      key: 'POST /api/v1/consultations',
      parts: [],
      store: ctx.store,
      sendJson: ctx.sendJson,
      requireUser: async () => patient,
      readBody: ctx.readBody,
      requireFields: ctx.requireFields
    });

    ctx.readBody = async () => ({
      requestedNeed: 'Sort query route test super priority',
      tier: 'super_priority'
    });
    await handleConsultationRoutes({
      req: ctx.req,
      res: ctx.res,
      key: 'POST /api/v1/consultations',
      parts: [],
      store: ctx.store,
      sendJson: ctx.sendJson,
      requireUser: async () => patient,
      readBody: ctx.readBody,
      requireFields: ctx.requireFields
    });

    await handleConsultationRoutes({
      req: {
        ...ctx.req,
        method: 'GET',
        url: '/api/v1/consultations?sort=urgency'
      },
      res: ctx.res,
      key: 'GET /api/v1/consultations',
      parts: [],
      store: ctx.store,
      sendJson: ctx.sendJson,
      requireUser: async () => coordinator,
      readBody: ctx.readBody,
      requireFields: ctx.requireFields
    });

    assert.equal(ctx.res.status, 200);
    assert.ok(Array.isArray(ctx.res.payload.data));
    assert.ok(ctx.res.payload.data.length >= 2);
    assert.equal(ctx.res.payload.data[0].tier, 'super_priority');

    await handleConsultationRoutes({
      req: {
        ...ctx.req,
        method: 'GET',
        url: '/api/v1/consultations?sort=risk_score'
      },
      res: ctx.res,
      key: 'GET /api/v1/consultations',
      parts: [],
      store: ctx.store,
      sendJson: ctx.sendJson,
      requireUser: async () => coordinator,
      readBody: ctx.readBody,
      requireFields: ctx.requireFields
    });

    assert.equal(ctx.res.status, 200);
    assert.ok(Array.isArray(ctx.res.payload.data));
    assert.ok(typeof ctx.res.payload.data[0].riskSummary?.score === 'number');
  } finally {
    await ctx.cleanup();
  }
});

test('consultations route supports status, tier, and search query filters', async () => {
  const ctx = await buildContext({ key: 'POST /api/v1/consultations', method: 'POST' });
  try {
    const db = await ctx.store.read();
    const patient = db.users.find((item) => item.role === 'patient');
    const coordinator = db.users.find((item) => item.role === 'coordinator');
    const clinician = db.users.find((item) => item.role === 'clinician');

    ctx.readBody = async () => ({
      requestedNeed: 'Consultation route filter token-charlie',
      tier: 'priority'
    });
    await handleConsultationRoutes({
      req: ctx.req,
      res: ctx.res,
      key: 'POST /api/v1/consultations',
      parts: [],
      store: ctx.store,
      sendJson: ctx.sendJson,
      requireUser: async () => patient,
      readBody: ctx.readBody,
      requireFields: ctx.requireFields
    });
    const consultation = ctx.res.payload.data;

    await handleConsultationRoutes({
      req: { ...ctx.req, method: 'POST' },
      res: ctx.res,
      key: '',
      parts: ['api', 'v1', 'consultations', consultation.id, 'claim'],
      store: ctx.store,
      sendJson: ctx.sendJson,
      requireUser: async () => clinician,
      readBody: async () => ({}),
      requireFields: ctx.requireFields
    });

    await handleConsultationRoutes({
      req: { ...ctx.req, method: 'POST' },
      res: ctx.res,
      key: '',
      parts: ['api', 'v1', 'consultations', consultation.id, 'start'],
      store: ctx.store,
      sendJson: ctx.sendJson,
      requireUser: async () => clinician,
      readBody: async () => ({}),
      requireFields: ctx.requireFields
    });

    await handleConsultationRoutes({
      req: {
        ...ctx.req,
        method: 'GET',
        url: '/api/v1/consultations?status=IN_PROGRESS&tier=priority&search=token-charlie'
      },
      res: ctx.res,
      key: 'GET /api/v1/consultations',
      parts: [],
      store: ctx.store,
      sendJson: ctx.sendJson,
      requireUser: async () => coordinator,
      readBody: ctx.readBody,
      requireFields: ctx.requireFields
    });

    assert.equal(ctx.res.status, 200);
    assert.ok(Array.isArray(ctx.res.payload.data));
    assert.ok(ctx.res.payload.data.length >= 1);
    assert.ok(ctx.res.payload.data.every((item) => item.status === 'IN_PROGRESS'));
    assert.ok(ctx.res.payload.data.every((item) => item.tier === 'priority'));
    assert.ok(ctx.res.payload.data.every((item) => String(item.requestedNeed || '').toLowerCase().includes('token-charlie')));
  } finally {
    await ctx.cleanup();
  }
});

test('consultations workspace route returns queue and operational snapshot in one payload', async () => {
  const ctx = await buildContext({ key: 'POST /api/v1/consultations', method: 'POST' });
  try {
    const db = await ctx.store.read();
    const patient = db.users.find((item) => item.role === 'patient');
    const coordinator = db.users.find((item) => item.role === 'coordinator');

    ctx.readBody = async () => ({
      requestedNeed: 'Workspace endpoint integration test token-delta',
      tier: 'priority'
    });

    await handleConsultationRoutes({
      req: ctx.req,
      res: ctx.res,
      key: 'POST /api/v1/consultations',
      parts: [],
      store: ctx.store,
      sendJson: ctx.sendJson,
      requireUser: async () => patient,
      readBody: ctx.readBody,
      requireFields: ctx.requireFields
    });

    await handleConsultationRoutes({
      req: {
        ...ctx.req,
        method: 'GET',
        url: '/api/v1/consultations/workspace?sort=risk_score&status=REQUESTED&search=token-delta'
      },
      res: ctx.res,
      key: 'GET /api/v1/consultations/workspace',
      parts: ['api', 'v1', 'consultations', 'workspace'],
      store: ctx.store,
      sendJson: ctx.sendJson,
      requireUser: async () => coordinator,
      readBody: ctx.readBody,
      requireFields: ctx.requireFields
    });

    assert.equal(ctx.res.status, 200);
    assert.ok(Array.isArray(ctx.res.payload.data.consultations));
    assert.ok(ctx.res.payload.data.consultations.length >= 1);
    assert.ok(ctx.res.payload.data.consultations.every((item) => item.status === 'REQUESTED'));
    assert.ok(ctx.res.payload.data.consultations.every((item) => String(item.requestedNeed || '').toLowerCase().includes('token-delta')));
    assert.ok(typeof ctx.res.payload.data.generatedAt === 'string');
    assert.ok(ctx.res.payload.data.appliedFilters);
    assert.equal(ctx.res.payload.data.appliedFilters.sort, 'risk_score');
    assert.equal(ctx.res.payload.data.appliedFilters.status, 'REQUESTED');
    assert.equal(ctx.res.payload.data.appliedFilters.tier, 'all');
    assert.equal(ctx.res.payload.data.appliedFilters.search, 'token-delta');
    assert.ok(ctx.res.payload.data.meta);
    assert.equal(typeof ctx.res.payload.data.meta.visibleCount, 'number');
    assert.equal(typeof ctx.res.payload.data.meta.totalCount, 'number');
    assert.ok(ctx.res.payload.data.meta.totalCount >= ctx.res.payload.data.meta.visibleCount);
    assert.ok(ctx.res.payload.data.snapshot);
    assert.ok(typeof ctx.res.payload.data.snapshot.requested === 'number');
    assert.ok(ctx.res.payload.data.snapshot.alerts);
    assert.ok(Array.isArray(ctx.res.payload.data.snapshot.alerts.alerts));
  } finally {
    await ctx.cleanup();
  }
});

test('consultation events export route returns csv payload', async () => {
  const ctx = await buildContext({ key: 'POST /api/v1/consultations', method: 'POST' });
  try {
    const db = await ctx.store.read();
    const patient = db.users.find((item) => item.role === 'patient');
    const clinician = db.users.find((item) => item.role === 'clinician');

    ctx.readBody = async () => ({
      requestedNeed: 'Events export route test',
      tier: 'priority',
      requestedCommunicationMode: 'voice_call'
    });
    await handleConsultationRoutes({
      req: ctx.req,
      res: ctx.res,
      key: 'POST /api/v1/consultations',
      parts: [],
      store: ctx.store,
      sendJson: ctx.sendJson,
      requireUser: async () => patient,
      readBody: ctx.readBody,
      requireFields: ctx.requireFields
    });
    const consultation = ctx.res.payload.data;

    await handleConsultationRoutes({
      req: { ...ctx.req, method: 'POST' },
      res: ctx.res,
      key: '',
      parts: ['api', 'v1', 'consultations', consultation.id, 'claim'],
      store: ctx.store,
      sendJson: ctx.sendJson,
      requireUser: async () => clinician,
      readBody: async () => ({}),
      requireFields: ctx.requireFields
    });

    await handleConsultationRoutes({
      req: { ...ctx.req, method: 'POST' },
      res: ctx.res,
      key: '',
      parts: ['api', 'v1', 'consultations', consultation.id, 'start'],
      store: ctx.store,
      sendJson: ctx.sendJson,
      requireUser: async () => clinician,
      readBody: async () => ({}),
      requireFields: ctx.requireFields
    });

    await handleConsultationRoutes({
      req: { ...ctx.req, method: 'POST' },
      res: ctx.res,
      key: '',
      parts: ['api', 'v1', 'consultations', consultation.id, 'sessions'],
      store: ctx.store,
      sendJson: ctx.sendJson,
      requireUser: async () => clinician,
      readBody: async () => ({ channel: 'voice_call' }),
      requireFields: ctx.requireFields
    });
    const session = ctx.res.payload.data;

    await handleConsultationRoutes({
      req: { ...ctx.req, method: 'POST' },
      res: ctx.res,
      key: '',
      parts: ['api', 'v1', 'consultations', consultation.id, 'sessions', session.id, 'interactions'],
      store: ctx.store,
      sendJson: ctx.sendJson,
      requireUser: async () => clinician,
      readBody: async () => ({ interactionType: 'session_marker', marker: 'connected' }),
      requireFields: ctx.requireFields
    });

    ctx.res.body = '';
    await handleConsultationRoutes({
      req: {
        ...ctx.req,
        method: 'GET',
        url: `/api/v1/consultations/${consultation.id}/events/export?format=csv&kind=interaction&limit=5`
      },
      res: ctx.res,
      key: '',
      parts: ['api', 'v1', 'consultations', consultation.id, 'events', 'export'],
      store: ctx.store,
      sendJson: ctx.sendJson,
      requireUser: async () => clinician,
      readBody: ctx.readBody,
      requireFields: ctx.requireFields
    });

    assert.equal(ctx.res.status, 200);
    assert.ok(ctx.res.headers['content-type'].includes('text/csv'));
    assert.ok(ctx.res.headers['content-disposition'].includes('.csv'));
    assert.ok(ctx.res.body.startsWith('at,kind,message,actorId'));
    assert.ok(ctx.res.body.includes('interaction'));
  } finally {
    await ctx.cleanup();
  }
});

test('consultation interactions export route returns csv payload', async () => {
  const ctx = await buildContext({ key: 'POST /api/v1/consultations', method: 'POST' });
  try {
    const db = await ctx.store.read();
    const patient = db.users.find((item) => item.role === 'patient');
    const clinician = db.users.find((item) => item.role === 'clinician');

    ctx.readBody = async () => ({
      requestedNeed: 'Interaction export route test',
      tier: 'normal',
      requestedCommunicationMode: 'voice_text'
    });

    await handleConsultationRoutes({
      req: ctx.req,
      res: ctx.res,
      key: ctx.key,
      parts: [],
      store: ctx.store,
      sendJson: ctx.sendJson,
      requireUser: async () => patient,
      readBody: ctx.readBody,
      requireFields: ctx.requireFields
    });

    const consultation = ctx.res.payload.data;

    await handleConsultationRoutes({
      req: { ...ctx.req, method: 'POST' },
      res: ctx.res,
      key: '',
      parts: ['api', 'v1', 'consultations', consultation.id, 'claim'],
      store: ctx.store,
      sendJson: ctx.sendJson,
      requireUser: async () => clinician,
      readBody: async () => ({}),
      requireFields: ctx.requireFields
    });

    await handleConsultationRoutes({
      req: { ...ctx.req, method: 'POST' },
      res: ctx.res,
      key: '',
      parts: ['api', 'v1', 'consultations', consultation.id, 'start'],
      store: ctx.store,
      sendJson: ctx.sendJson,
      requireUser: async () => clinician,
      readBody: async () => ({}),
      requireFields: ctx.requireFields
    });

    await handleConsultationRoutes({
      req: { ...ctx.req, method: 'POST' },
      res: ctx.res,
      key: '',
      parts: ['api', 'v1', 'consultations', consultation.id, 'sessions'],
      store: ctx.store,
      sendJson: ctx.sendJson,
      requireUser: async () => clinician,
      readBody: async () => ({ channel: 'voice_text' }),
      requireFields: ctx.requireFields
    });

    const session = ctx.res.payload.data;

    await handleConsultationRoutes({
      req: { ...ctx.req, method: 'POST' },
      res: ctx.res,
      key: '',
      parts: ['api', 'v1', 'consultations', consultation.id, 'sessions', session.id, 'interactions'],
      store: ctx.store,
      sendJson: ctx.sendJson,
      requireUser: async () => patient,
      readBody: async () => ({ interactionType: 'patient_message', message: 'Patient export message' }),
      requireFields: ctx.requireFields
    });

    await handleConsultationRoutes({
      req: {
        ...ctx.req,
        method: 'GET',
        url: `/api/v1/consultations/${consultation.id}/sessions/${session.id}/interactions/export?format=csv&type=patient_message&limit=5`
      },
      res: ctx.res,
      key: '',
      parts: ['api', 'v1', 'consultations', consultation.id, 'sessions', session.id, 'interactions', 'export'],
      store: ctx.store,
      sendJson: ctx.sendJson,
      requireUser: async () => clinician,
      readBody: ctx.readBody,
      requireFields: ctx.requireFields
    });

    assert.equal(ctx.res.status, 200);
    assert.ok(ctx.res.headers);
    assert.equal(ctx.res.headers['content-type'], 'text/csv; charset=utf-8');
    assert.ok(String(ctx.res.headers['content-disposition'] || '').includes('-interactions.csv'));
    assert.ok(typeof ctx.res.body === 'string');
    assert.ok(ctx.res.body.includes('interactionType'));
    assert.ok(ctx.res.body.includes('patient_message'));
  } finally {
    await ctx.cleanup();
  }
});

test('consultation interactions export route returns json payload', async () => {
  const ctx = await buildContext({ key: 'POST /api/v1/consultations', method: 'POST' });
  try {
    const db = await ctx.store.read();
    const patient = db.users.find((item) => item.role === 'patient');
    const clinician = db.users.find((item) => item.role === 'clinician');

    ctx.readBody = async () => ({
      requestedNeed: 'Interaction export json route test',
      tier: 'normal',
      requestedCommunicationMode: 'voice_text'
    });

    await handleConsultationRoutes({
      req: ctx.req,
      res: ctx.res,
      key: ctx.key,
      parts: [],
      store: ctx.store,
      sendJson: ctx.sendJson,
      requireUser: async () => patient,
      readBody: ctx.readBody,
      requireFields: ctx.requireFields
    });

    const consultation = ctx.res.payload.data;

    await handleConsultationRoutes({
      req: { ...ctx.req, method: 'POST' },
      res: ctx.res,
      key: '',
      parts: ['api', 'v1', 'consultations', consultation.id, 'claim'],
      store: ctx.store,
      sendJson: ctx.sendJson,
      requireUser: async () => clinician,
      readBody: async () => ({}),
      requireFields: ctx.requireFields
    });

    await handleConsultationRoutes({
      req: { ...ctx.req, method: 'POST' },
      res: ctx.res,
      key: '',
      parts: ['api', 'v1', 'consultations', consultation.id, 'start'],
      store: ctx.store,
      sendJson: ctx.sendJson,
      requireUser: async () => clinician,
      readBody: async () => ({}),
      requireFields: ctx.requireFields
    });

    await handleConsultationRoutes({
      req: { ...ctx.req, method: 'POST' },
      res: ctx.res,
      key: '',
      parts: ['api', 'v1', 'consultations', consultation.id, 'sessions'],
      store: ctx.store,
      sendJson: ctx.sendJson,
      requireUser: async () => clinician,
      readBody: async () => ({ channel: 'voice_text' }),
      requireFields: ctx.requireFields
    });

    const session = ctx.res.payload.data;

    await handleConsultationRoutes({
      req: { ...ctx.req, method: 'POST' },
      res: ctx.res,
      key: '',
      parts: ['api', 'v1', 'consultations', consultation.id, 'sessions', session.id, 'interactions'],
      store: ctx.store,
      sendJson: ctx.sendJson,
      requireUser: async () => clinician,
      readBody: async () => ({ interactionType: 'clinical_note', message: 'Escalation note for JSON export.' }),
      requireFields: ctx.requireFields
    });

    await handleConsultationRoutes({
      req: {
        ...ctx.req,
        method: 'GET',
        url: `/api/v1/consultations/${consultation.id}/sessions/${session.id}/interactions/export?format=json&type=clinical_note&limit=5`
      },
      res: ctx.res,
      key: '',
      parts: ['api', 'v1', 'consultations', consultation.id, 'sessions', session.id, 'interactions', 'export'],
      store: ctx.store,
      sendJson: ctx.sendJson,
      requireUser: async () => clinician,
      readBody: ctx.readBody,
      requireFields: ctx.requireFields
    });

    assert.equal(ctx.res.status, 200);
    assert.ok(ctx.res.headers);
    assert.equal(ctx.res.headers['content-type'], 'application/json; charset=utf-8');
    assert.ok(typeof ctx.res.body === 'string');
    const parsed = JSON.parse(ctx.res.body);
    assert.ok(Array.isArray(parsed));
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].interactionType, 'clinical_note');
  } finally {
    await ctx.cleanup();
  }
});

test('consultation session switch and ensure-active routes manage active comms layer', async () => {
  const ctx = await buildContext({ key: 'POST /api/v1/consultations', method: 'POST' });
  try {
    const db = await ctx.store.read();
    const patient = db.users.find((item) => item.role === 'patient');
    const clinician = db.users.find((item) => item.role === 'clinician');

    ctx.readBody = async () => ({
      requestedNeed: 'Session switch and ensure-active route integration test',
      tier: 'priority',
      requestedCommunicationMode: 'voice_call'
    });

    await handleConsultationRoutes({
      req: ctx.req,
      res: ctx.res,
      key: ctx.key,
      parts: [],
      store: ctx.store,
      sendJson: ctx.sendJson,
      requireUser: async () => patient,
      readBody: ctx.readBody,
      requireFields: ctx.requireFields
    });
    const consultation = ctx.res.payload.data;

    await handleConsultationRoutes({
      req: { ...ctx.req, method: 'POST' },
      res: ctx.res,
      key: '',
      parts: ['api', 'v1', 'consultations', consultation.id, 'claim'],
      store: ctx.store,
      sendJson: ctx.sendJson,
      requireUser: async () => clinician,
      readBody: async () => ({}),
      requireFields: ctx.requireFields
    });

    await handleConsultationRoutes({
      req: { ...ctx.req, method: 'POST' },
      res: ctx.res,
      key: '',
      parts: ['api', 'v1', 'consultations', consultation.id, 'start'],
      store: ctx.store,
      sendJson: ctx.sendJson,
      requireUser: async () => clinician,
      readBody: async () => ({ channel: 'voice_call' }),
      requireFields: ctx.requireFields
    });

    assert.equal(ctx.res.status, 200);
    assert.equal(ctx.res.payload.data.activeCommunicationLayer, 'voice_call');

    await handleConsultationRoutes({
      req: { ...ctx.req, method: 'POST' },
      res: ctx.res,
      key: '',
      parts: ['api', 'v1', 'consultations', consultation.id, 'sessions', 'switch'],
      store: ctx.store,
      sendJson: ctx.sendJson,
      requireUser: async () => clinician,
      readBody: async () => ({ targetChannel: 'video_call', reason: 'route_integration_switch' }),
      requireFields: ctx.requireFields
    });

    assert.equal(ctx.res.status, 200);
    assert.equal(ctx.res.payload.data.switched, true);
    assert.equal(ctx.res.payload.data.consultation.activeCommunicationLayer, 'video_call');

    await handleConsultationRoutes({
      req: { ...ctx.req, method: 'POST' },
      res: ctx.res,
      key: '',
      parts: ['api', 'v1', 'consultations', consultation.id, 'sessions', 'ensure-active'],
      store: ctx.store,
      sendJson: ctx.sendJson,
      requireUser: async () => clinician,
      readBody: async () => ({}),
      requireFields: ctx.requireFields
    });

    assert.equal(ctx.res.status, 200);
    assert.equal(ctx.res.payload.data.autoProvisioned, false);
    assert.equal(ctx.res.payload.data.consultation.activeCommunicationLayer, 'video_call');
  } finally {
    await ctx.cleanup();
  }
});
