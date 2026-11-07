import { pbkdf2Sync, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

export const roles = ['patient', 'clinician', 'hospital_staff', 'coordinator', 'admin', 'finance'];

export const referralTransitions = {
  draft: ['submitted', 'cancelled'],
  submitted: ['under_review', 'cancelled'],
  under_review: ['matched', 'request_info', 'rejected', 'cancelled'],
  matched: ['sent_to_provider', 'rematch', 'cancelled'],
  sent_to_provider: ['accepted', 'rejected', 'request_info'],
  accepted: ['appointment_scheduled', 'request_info', 'cancelled'],
  request_info: ['resubmitted', 'cancelled'],
  resubmitted: ['under_review', 'accepted', 'rejected'],
  appointment_scheduled: ['patient_attended', 'cancelled'],
  patient_attended: ['service_completed'],
  service_completed: ['closed'],
  rejected: ['rematch', 'closed'],
  rematch: ['matched', 'sent_to_provider', 'cancelled'],
  closed: [],
  cancelled: []
};

export const leadTransitions = {
  new: ['contacted', 'qualified', 'closed_lost'],
  contacted: ['qualified', 'closed_lost'],
  qualified: ['referral_created', 'closed_lost'],
  referral_created: ['provider_matched', 'appointment', 'completed'],
  provider_matched: ['appointment', 'completed'],
  appointment: ['completed', 'closed_lost'],
  completed: [],
  closed_lost: []
};

export const funnelStages = [
  'awareness',
  'landing_page',
  'application',
  'screening',
  'provider_match',
  'booking',
  'consultation',
  'retention'
];

export const consultationTiers = {
  normal: { label: 'Normal', mode: 'Voice-text', price: 1000 },
  priority: { label: 'Priority', mode: 'Voice call', price: 5000 },
  super_priority: { label: 'Super Priority', mode: 'Video call', price: 10000 }
};

export const consultationStates = ['REQUESTED', 'DOCTOR_ACCEPTED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'];

export const consultationTransitions = {
  REQUESTED: ['DOCTOR_ACCEPTED', 'CANCELLED'],
  DOCTOR_ACCEPTED: ['IN_PROGRESS', 'CANCELLED'],
  IN_PROGRESS: ['COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: []
};

const consultationTierOrder = ['normal', 'priority', 'super_priority'];

export function assertConsultationTier(value) {
  if (!Object.hasOwn(consultationTiers, value)) {
    const error = new Error('Consultation tier must be normal, priority, or super_priority.');
    error.status = 422;
    throw error;
  }
  return consultationTiers[value];
}

export function assertConsultationTransition(fromStatus, toStatus) {
  if (!consultationTransitions[fromStatus]?.includes(toStatus)) {
    const error = new Error(`Cannot transition consultation from ${fromStatus} to ${toStatus}.`);
    error.status = 422;
    throw error;
  }
}

export function assertTierEscalation(fromTier, toTier) {
  assertConsultationTier(fromTier);
  assertConsultationTier(toTier);
  if (consultationTierOrder.indexOf(toTier) <= consultationTierOrder.indexOf(fromTier)) {
    const error = new Error('Consultation escalation must move to a higher tier.');
    error.status = 422;
    throw error;
  }
}

export const funnelTransitions = Object.fromEntries(
  funnelStages.map((stage, index) => [stage, funnelStages.slice(index + 1, index + 2)])
);

export function assertFunnelTransition(fromStage, toStage) {
  if (!funnelStages.includes(toStage) || !funnelTransitions[fromStage]?.includes(toStage)) {
    const error = new Error(`Cannot move funnel stage from ${fromStage} to ${toStage}.`);
    error.status = 422;
    throw error;
  }
}

export function now() {
  return new Date().toISOString();
}

export function publicUser(user) {
  if (!user) return null;
  const { passwordHash, telegramChatId, ...safe } = user;
  return safe;
}

export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = pbkdf2Sync(password, salt, 120000, 32, 'sha256').toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password, passwordHash) {
  const [salt, expected] = String(passwordHash || '').split(':');
  if (!salt || !expected) return false;
  const actual = pbkdf2Sync(password, salt, 120000, 32, 'sha256');
  const expectedBuffer = Buffer.from(expected, 'hex');
  return expectedBuffer.length === actual.length && timingSafeEqual(expectedBuffer, actual);
}

export function normalizeString(value, maxLength = 1000) {
  return String(value || '').trim().slice(0, maxLength);
}

export function normalizeEmail(value) {
  return normalizeString(value, 255).toLowerCase();
}

export function consentWasGiven(value) {
  return value === true || value === 'true' || value === 'on' || value === 1 || value === '1';
}

export function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || ''));
}

export function makeToken() {
  return randomBytes(32).toString('hex');
}

export function makeId(prefix) {
  return `${prefix}_${randomUUID()}`;
}

export function nextConsultationNumber(db) {
  const year = new Date().getUTCFullYear();
  const consultations = db.consultations || [];
  const count = consultations.filter((consultation) => consultation.consultationNumber?.startsWith(`CON-${year}-`)).length + 1;
  return `CON-${year}-${String(count).padStart(4, '0')}`;
}

export function nextReferralNumber(db) {
  const year = new Date().getUTCFullYear();
  const count = db.referrals.filter((referral) => referral.referralNumber.startsWith(`REF-${year}-`)).length + 1;
  return `REF-${year}-${String(count).padStart(4, '0')}`;
}

export function assertRole(user, allowed) {
  if (!user || !allowed.includes(user.role)) {
    const error = new Error('You do not have permission to perform this action.');
    error.status = 403;
    throw error;
  }
}

export function canViewReferral(user, referral) {
  if (['admin', 'coordinator'].includes(user.role)) return true;
  if (user.role === 'patient' && referral.patientId === user.patientId) return true;
  if (user.role === 'clinician' && referral.referrerClinicianId === user.id) return true;
  if (user.role === 'hospital_staff' && referral.assignedProviderId === user.providerId) return true;
  return false;
}

export function canViewConsultation(user, consultation) {
  if (!user || !consultation) return false;
  if (['admin', 'coordinator', 'finance'].includes(user.role)) return true;
  if (user.role === 'patient' && consultation.patientId === user.patientId) return true;
  if (user.role === 'clinician') {
    if (consultation.assignedClinicianId === user.id) return true;
    if (consultation.status === 'REQUESTED') return true;
  }
  return false;
}

export function findProcedure(db, procedureId) {
  return db.procedures.find((procedure) => procedure.id === procedureId) || null;
}

export function assertProcedureForSpecialty(db, specialtyId, procedureId) {
  const specialty = db.specialties.find((item) => item.id === specialtyId);
  const procedure = findProcedure(db, procedureId);
  if (!specialty || !procedure || procedure.specialtyId !== specialty.id) {
    const error = new Error('The selected procedure does not belong to the selected specialty.');
    error.status = 422;
    throw error;
  }
  return procedure;
}

export function recommendProviders(db, referral, limit = 5) {
  const patient = db.patients.find((item) => item.id === referral.patientId);
  return db.providers
    .filter((provider) => provider.isActive && provider.onboardingStatus === 'active')
    .map((provider) => {
      const capability = db.providerProcedures.find(
        (item) => item.providerId === provider.id && item.procedureId === referral.procedureId
      );
      if (!capability || capability.availability === 'unavailable') return null;
      let score = 40;
      const scoreBreakdown = [{ factor: 'eligible_procedure', points: 40 }];
      if (provider.city && patient?.city && provider.city.toLowerCase() === patient.city.toLowerCase()) {
        score += 25;
        scoreBreakdown.push({ factor: 'same_city', points: 25 });
      }
      if (capability.availability === 'available') {
        score += 20;
        scoreBreakdown.push({ factor: 'available', points: 20 });
      }
      if (capability.availability === 'limited') {
        score += 8;
        scoreBreakdown.push({ factor: 'limited_availability', points: 8 });
      }
      const ratingPoints = Math.round((Number(provider.rating) || 0) * 3);
      if (ratingPoints) {
        score += ratingPoints;
        scoreBreakdown.push({ factor: 'provider_rating', points: ratingPoints });
      }
      const waitPenalty = Math.min(Number(capability.waitingTimeDays) || 0, 30);
      if (waitPenalty) {
        score -= waitPenalty;
        scoreBreakdown.push({ factor: 'waiting_days', points: -waitPenalty });
      }
      return { ...provider, match: capability, score, scoreBreakdown };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export function seedDatabase() {
  const createdAt = now();
  const adminId = makeId('user');
  const coordinatorId = makeId('user');
  const patientUserId = makeId('user');
  const patientId = makeId('patient');
  const cardiologyId = makeId('specialty');
  const nephrologyId = makeId('specialty');
  const echoId = makeId('procedure');
  const dialysisId = makeId('procedure');
  const providerA = makeId('provider');
  const providerB = makeId('provider');
  const clinicianUserId = makeId('user');

  return {
    users: [
      {
        id: adminId,
        email: 'admin@mindset.local',
        passwordHash: hashPassword('password'),
        firstName: 'Admin',
        lastName: 'User',
        phone: '',
        role: 'admin',
        createdAt,
        updatedAt: createdAt
      },
      {
        id: coordinatorId,
        email: 'coordinator@mindset.local',
        passwordHash: hashPassword('password'),
        firstName: 'Referral',
        lastName: 'Coordinator',
        phone: '',
        role: 'coordinator',
        createdAt,
        updatedAt: createdAt
      },
      {
        id: patientUserId,
        email: 'patient@mindset.local',
        passwordHash: hashPassword('password'),
        firstName: 'Demo',
        lastName: 'Patient',
        phone: '+2348000000000',
        role: 'patient',
        patientId,
        createdAt,
        updatedAt: createdAt
      },
      {
        id: clinicianUserId,
        email: 'clinician@mindset.local',
        passwordHash: hashPassword('password'),
        firstName: 'Demo',
        lastName: 'Clinician',
        phone: '+2348033333333',
        role: 'clinician',
        providerId: providerA,
        consultationAvailability: {
          enabled: true,
          acceptedTiers: ['normal', 'priority', 'super_priority'],
          specialtyIds: [cardiologyId],
          procedureIds: [echoId]
        },
        createdAt,
        updatedAt: createdAt
      }
    ],
    verificationChallenges: [],
    sessions: [],
    patients: [
      {
        id: patientId,
        userId: patientUserId,
        name: 'Demo Patient',
        email: 'patient@mindset.local',
        phone: '+2348000000000',
        city: 'Lagos',
        state: 'Lagos',
        country: 'Nigeria',
        consentGiven: true,
        createdAt,
        updatedAt: createdAt
      }
    ],
    leads: [],
    onboardingApplications: [],
    familyInvitations: [],
    specialties: [
      { id: cardiologyId, name: 'Cardiology', description: 'Heart and cardiovascular care', createdAt, updatedAt: createdAt },
      { id: nephrologyId, name: 'Nephrology', description: 'Kidney care and dialysis support', createdAt, updatedAt: createdAt }
    ],
    procedures: [
      { id: echoId, specialtyId: cardiologyId, name: 'Echocardiography', description: 'Heart ultrasound assessment', createdAt, updatedAt: createdAt },
      { id: dialysisId, specialtyId: nephrologyId, name: 'Dialysis', description: 'Renal replacement therapy', createdAt, updatedAt: createdAt }
    ],
    providers: [
      {
        id: providerA,
        name: 'Lagoon Specialist Hospital',
        type: 'hospital',
        city: 'Lagos',
        state: 'Lagos',
        country: 'Nigeria',
        contactName: 'Provider Desk',
        contactEmail: 'provider-a@mindset.local',
        contactPhone: '+2348011111111',
        onboardingStatus: 'active',
        trainingStatus: 'trained',
        rating: 4.6,
        isActive: true,
        createdAt,
        updatedAt: createdAt
      },
      {
        id: providerB,
        name: 'Abuja Renal Centre',
        type: 'clinic',
        city: 'Abuja',
        state: 'FCT',
        country: 'Nigeria',
        contactName: 'Referral Officer',
        contactEmail: 'provider-b@mindset.local',
        contactPhone: '+2348022222222',
        onboardingStatus: 'active',
        trainingStatus: 'in_training',
        rating: 4.3,
        isActive: true,
        createdAt,
        updatedAt: createdAt
      }
    ],
    providerProcedures: [
      { id: makeId('capability'), providerId: providerA, procedureId: echoId, availability: 'available', waitingTimeDays: 2, cost: 85000, createdAt, updatedAt: createdAt },
      { id: makeId('capability'), providerId: providerA, procedureId: dialysisId, availability: 'limited', waitingTimeDays: 5, cost: 120000, createdAt, updatedAt: createdAt },
      { id: makeId('capability'), providerId: providerB, procedureId: dialysisId, availability: 'available', waitingTimeDays: 1, cost: 95000, createdAt, updatedAt: createdAt }
    ],
    referrals: [],
    referralStatusHistory: [],
    documents: [],
    medicalRecords: [
      {
        id: makeId('medical_record'),
        patientId,
        consultationId: null,
        sourceSystem: 'openemr_compatible',
        externalRecordId: 'EMR-BASELINE-001',
        recordType: 'problem_list',
        title: 'Hypertension history',
        summary: 'Known hypertension with prior elevated blood pressure episodes.',
        status: 'active',
        recordedAt: createdAt,
        updatedAt: createdAt,
        coding: { icd10: 'I10' }
      },
      {
        id: makeId('medical_record'),
        patientId,
        consultationId: null,
        sourceSystem: 'openemr_compatible',
        externalRecordId: 'EMR-BASELINE-002',
        recordType: 'medication',
        title: 'Current medication',
        summary: 'Amlodipine 5mg once daily.',
        status: 'active',
        recordedAt: createdAt,
        updatedAt: createdAt,
        coding: null
      }
    ],
    appointments: [],
    payments: [],
    consultations: [],
    consultationSessions: [],
    consultationClaims: [],
    consultationInteractions: [],
    biometricVerifications: [],
    notificationLogs: [],
    auditLogs: []
  };
}
