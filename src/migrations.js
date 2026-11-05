import { consultationTiers, hashPassword, makeId, now } from './domain.js';

function withArray(data, key) {
  if (!Array.isArray(data[key])) data[key] = [];
}

function userByEmail(data, email) {
  return data.users.find((user) => String(user.email || '').toLowerCase() === email.toLowerCase()) || null;
}

function ensureDemoUsers(data) {
  withArray(data, 'users');
  withArray(data, 'patients');
  withArray(data, 'providers');

  const timestamp = now();
  const created = [];

  if (!userByEmail(data, 'admin@mindset.local')) {
    data.users.push({
      id: makeId('user'),
      email: 'admin@mindset.local',
      passwordHash: hashPassword('password'),
      firstName: 'Admin',
      lastName: 'User',
      phone: '',
      role: 'admin',
      createdAt: timestamp,
      updatedAt: timestamp
    });
    created.push('admin@mindset.local');
  }

  if (!userByEmail(data, 'coordinator@mindset.local')) {
    data.users.push({
      id: makeId('user'),
      email: 'coordinator@mindset.local',
      passwordHash: hashPassword('password'),
      firstName: 'Referral',
      lastName: 'Coordinator',
      phone: '',
      role: 'coordinator',
      createdAt: timestamp,
      updatedAt: timestamp
    });
    created.push('coordinator@mindset.local');
  }

  if (!userByEmail(data, 'patient@mindset.local')) {
    let patient = data.patients.find((item) => String(item.email || '').toLowerCase() === 'patient@mindset.local') || null;
    const patientUserId = makeId('user');
    if (!patient) {
      patient = {
        id: makeId('patient'),
        userId: patientUserId,
        name: 'Demo Patient',
        email: 'patient@mindset.local',
        phone: '+2348000000000',
        city: 'Lagos',
        state: 'Lagos',
        country: 'Nigeria',
        consentGiven: true,
        createdAt: timestamp,
        updatedAt: timestamp
      };
      data.patients.push(patient);
    } else {
      patient.userId = patient.userId || patientUserId;
      patient.updatedAt = timestamp;
    }

    data.users.push({
      id: patient.userId,
      email: 'patient@mindset.local',
      passwordHash: hashPassword('password'),
      firstName: 'Demo',
      lastName: 'Patient',
      phone: patient.phone || '+2348000000000',
      role: 'patient',
      patientId: patient.id,
      createdAt: timestamp,
      updatedAt: timestamp
    });
    created.push('patient@mindset.local');
  }

  if (!userByEmail(data, 'clinician@mindset.local')) {
    const defaultProvider =
      data.providers.find((item) => String(item.contactEmail || '').toLowerCase() === 'provider-a@mindset.local') ||
      data.providers.find((item) => String(item.name || '').toLowerCase().includes('lagoon')) ||
      data.providers[0] ||
      null;

    data.users.push({
      id: makeId('user'),
      email: 'clinician@mindset.local',
      passwordHash: hashPassword('password'),
      firstName: 'Demo',
      lastName: 'Clinician',
      phone: '+2348033333333',
      role: 'clinician',
      providerId: defaultProvider?.id || null,
      consultationAvailability: {
        enabled: true,
        acceptedTiers: ['normal', 'priority', 'super_priority'],
        specialtyIds: [],
        procedureIds: []
      },
      createdAt: timestamp,
      updatedAt: timestamp
    });
    created.push('clinician@mindset.local');
  }

  return created;
}

function migrateConsultationShape(data) {
  withArray(data, 'consultations');
  withArray(data, 'consultationSessions');
  withArray(data, 'consultationClaims');
  withArray(data, 'consultationInteractions');
  withArray(data, 'biometricVerifications');
  withArray(data, 'payments');
  withArray(data, 'referrals');
  withArray(data, 'documents');
  withArray(data, 'medicalRecords');

  let touched = 0;
  for (const consultation of data.consultations) {
    if (!Array.isArray(consultation.statusHistory)) {
      consultation.statusHistory = [];
      touched += 1;
    }
    if (!Array.isArray(consultation.escalationHistory)) {
      consultation.escalationHistory = [];
      touched += 1;
    }
    if (!consultation.consultationNumber) {
      consultation.consultationNumber = `CON-LEGACY-${String(consultation.id || makeId('consultation')).slice(-8)}`;
      touched += 1;
    }
    if (!consultation.claimWindowEndsAt) {
      consultation.claimWindowEndsAt = consultation.createdAt || now();
      touched += 1;
    }
    if (!consultation.communicationMode || !consultation.amountNgn) {
      const tierName = consultation.tier || 'normal';
      const tier = consultationTiers[tierName] || consultationTiers.normal;
      consultation.tier = tierName;
      consultation.communicationMode = consultation.communicationMode || tier.mode;
      consultation.amountNgn = consultation.amountNgn || tier.price;
      touched += 1;
    }
    if (consultation.specialtyId === undefined) {
      consultation.specialtyId = null;
      touched += 1;
    }
    if (consultation.procedureId === undefined) {
      consultation.procedureId = null;
      touched += 1;
    }

    if (consultation.status === 'IN_PROGRESS' && !consultation.activeCommunicationLayer) {
      const activeSession = data.consultationSessions.find(
        (session) => session.consultationId === consultation.id && session.status === 'active'
      );
      if (activeSession) {
        consultation.activeCommunicationLayer = activeSession.channel;
        consultation.communicationMode = activeSession.channel;
        touched += 1;
      } else {
        const timestamp = consultation.updatedAt || consultation.createdAt || now();
        const fallbackChannel =
          consultation.requestedCommunicationMode ||
          consultation.communicationMode ||
          'voice_text';
        const session = {
          id: makeId('consultation_session'),
          consultationId: consultation.id,
          channel: fallbackChannel,
          status: 'active',
          startedByUserId: consultation.assignedClinicianId || consultation.requestedByUserId || 'system',
          endedByUserId: null,
          participantRoles: ['patient', 'clinician'],
          metadata: { source: 'migration_auto_active_layer' },
          startedAt: timestamp,
          endedAt: null,
          createdAt: timestamp,
          updatedAt: timestamp
        };
        data.consultationSessions.push(session);
        consultation.activeCommunicationLayer = fallbackChannel;
        consultation.communicationMode = fallbackChannel;
        touched += 1;
      }
    }
  }

  for (const session of data.consultationSessions) {
    if (!['voice_call', 'video_call'].includes(session.channel)) continue;
    const timestamp = session.updatedAt || session.startedAt || session.createdAt || now();
    if (!session.callState) {
      session.callState = 'idle';
      touched += 1;
    }
    if (!session.callStateUpdatedAt) {
      session.callStateUpdatedAt = timestamp;
      touched += 1;
    }
    if (session.callStateReason === undefined) {
      session.callStateReason = null;
      touched += 1;
    }
    if (!Array.isArray(session.callStateHistory)) {
      session.callStateHistory = [];
      touched += 1;
    }
  }

  let availabilityTouched = 0;
  withArray(data, 'users');
  for (const user of data.users) {
    if (user.role !== 'clinician') continue;
    if (user.consultationAvailability) continue;
    user.consultationAvailability = {
      enabled: true,
      acceptedTiers: ['normal', 'priority', 'super_priority'],
      specialtyIds: [],
      procedureIds: []
    };
    availabilityTouched += 1;
  }

  return {
    touched,
    availabilityTouched,
    collectionsBackfilled: ['consultations', 'consultationSessions', 'consultationClaims', 'consultationInteractions', 'biometricVerifications']
  };
}

export function runDataMigrations(data) {
  const consultation = migrateConsultationShape(data);
  const demoUsersCreated = ensureDemoUsers(data);
  return {
    consultation,
    demoUsersCreated,
    migratedAt: now()
  };
}
