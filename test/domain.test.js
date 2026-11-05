import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { assertConsultationTier, assertFunnelTransition, assertProcedureForSpecialty, canViewReferral, consentWasGiven, hashPassword, recommendProviders, referralTransitions, seedDatabase, verifyPassword } from '../src/domain.js';
import { JsonStore } from '../src/storage.js';

test('password hashes verify only with the original password', () => {
  const hash = hashPassword('secret');
  assert.equal(verifyPassword('secret', hash), true);
  assert.equal(verifyPassword('wrong', hash), false);
  assert.equal(verifyPassword('secret', 'invalid-hash'), false);
});

test('referral workflow prevents direct closure from submitted', () => {
  assert.equal(referralTransitions.submitted.includes('closed'), false);
  assert.equal(referralTransitions.service_completed.includes('closed'), true);
});

test('provider recommendations rank eligible available providers', () => {
  const db = seedDatabase();
  const dialysis = db.procedures.find((procedure) => procedure.name === 'Dialysis');
  const referral = {
    patientId: db.patients[0].id,
    procedureId: dialysis.id
  };

  const recommendations = recommendProviders(db, referral);

  assert.equal(recommendations.length, 2);
  assert.equal(recommendations[0].name, 'Lagoon Specialist Hospital');
  assert.ok(recommendations[0].score > recommendations[1].score);
});

test('referral access keeps finance users outside clinical records', () => {
  const db = seedDatabase();
  const referral = { patientId: db.patients[0].id, referrerClinicianId: null, assignedProviderId: null };
  assert.equal(canViewReferral({ role: 'finance' }, referral), false);
  assert.equal(canViewReferral({ role: 'coordinator' }, referral), true);
});

test('procedure validation prevents specialty mismatches', () => {
  const db = seedDatabase();
  const cardiology = db.specialties.find((specialty) => specialty.name === 'Cardiology');
  const dialysis = db.procedures.find((procedure) => procedure.name === 'Dialysis');
  assert.throws(() => assertProcedureForSpecialty(db, cardiology.id, dialysis.id), /does not belong/);
});

test('lead consent accepts browser form values but rejects missing consent', () => {
  assert.equal(consentWasGiven(true), true);
  assert.equal(consentWasGiven('on'), true);
  assert.equal(consentWasGiven('false'), false);
  assert.equal(consentWasGiven(undefined), false);
});

test('patient funnel only advances one stage at a time', () => {
  assert.doesNotThrow(() => assertFunnelTransition('application', 'screening'));
  assert.throws(() => assertFunnelTransition('application', 'booking'), /Cannot move funnel stage/);
});

test('consultation tiers reject unsupported urgency values', () => {
  assert.equal(assertConsultationTier('priority').price, 5000);
  assert.throws(() => assertConsultationTier('urgent'), /Consultation tier/);
});

test('failed store updates do not block later updates', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mindset-store-'));
  const filePath = join(directory, 'data.json');
  const store = new JsonStore(filePath, { values: [] });

  await assert.rejects(store.update(() => {
    throw new Error('expected failure');
  }), /expected failure/);

  await store.update((db) => {
    db.values.push('recovered');
  });

  const data = JSON.parse(await readFile(filePath, 'utf8'));
  assert.deepEqual(data.values, ['recovered']);
  await rm(directory, { recursive: true, force: true });
});
