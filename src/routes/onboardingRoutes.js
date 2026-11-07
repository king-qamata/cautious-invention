import { assertRole, makeId, normalizeString, now } from '../domain.js';

function onboardingError(message, status = 422) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function getApplication(db, id) {
  const application = db.onboardingApplications.find((item) => item.id === id);
  if (!application) throw onboardingError('Onboarding application not found.', 404);
  return application;
}

export async function handleOnboardingRoutes(context) {
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

  if (key === 'GET /api/v1/onboarding/providers') {
    const user = await requireUser(req);
    assertRole(user, ['patient']);
    const db = await store.read();
    sendJson(res, 200, {
      data: db.providers
        .filter((provider) => provider.isActive && provider.onboardingStatus === 'active')
        .map(({ id, name, type, city, country }) => ({ id, name, type, city, country }))
    });
    return true;
  }

  if (key === 'POST /api/v1/onboarding/clinician' || key === 'POST /api/v1/onboarding/provider-staff') {
    const user = await requireUser(req);
    if (user.verifiedAt === null) throw onboardingError('Verify your account before applying.', 403);
    if (user.role !== 'patient') throw onboardingError('Only patient accounts may submit onboarding applications.', 403);
    const body = await readBody(req);
    const applicationType = key.endsWith('/clinician') ? 'clinician' : 'provider_staff';
    const fields = applicationType === 'clinician'
      ? ['providerId', 'professionalTitle', 'licenseNumber']
      : ['providerId', 'jobTitle'];
    requireFields(body, fields);
    const professionalTitle = normalizeString(body.professionalTitle, 120);
    const licenseNumber = normalizeString(body.licenseNumber, 120);
    const jobTitle = normalizeString(body.jobTitle, 120);
    if (applicationType === 'clinician' && (!professionalTitle || !licenseNumber)) {
      throw onboardingError('Professional title and license number are required.');
    }
    if (applicationType === 'provider_staff' && !jobTitle) throw onboardingError('Job title is required.');
    if (applicationType === 'clinician' && body.specialtyIds !== undefined && !Array.isArray(body.specialtyIds)) {
      throw onboardingError('Specialties must be provided as a list.');
    }

    await store.update((db) => {
      db.onboardingApplications ||= [];
      const provider = db.providers.find((item) => item.id === body.providerId && item.isActive && item.onboardingStatus === 'active');
      if (!provider) throw onboardingError('Choose an active approved provider organization.');
      const existing = db.onboardingApplications.find((item) =>
        item.userId === user.id && item.type === applicationType && item.status === 'pending'
      );
      if (existing) throw onboardingError('An application of this type is already awaiting review.', 409);
      const requestedSpecialtyIds = applicationType === 'clinician' ? [...new Set(body.specialtyIds || [])] : [];
      if (requestedSpecialtyIds.some((id) => !db.specialties.some((item) => item.id === id))) {
        throw onboardingError('One or more selected specialties are not available.');
      }

      const timestamp = now();
      const application = {
        id: makeId('onboarding'),
        userId: user.id,
        type: applicationType,
        providerId: provider.id,
        professionalTitle: applicationType === 'clinician' ? professionalTitle : null,
        licenseNumber: applicationType === 'clinician' ? licenseNumber : null,
        jobTitle: applicationType === 'provider_staff' ? jobTitle : null,
        specialtyIds: requestedSpecialtyIds,
        status: 'pending',
        reviewedByUserId: null,
        reviewedAt: null,
        createdAt: timestamp,
        updatedAt: timestamp
      };
      db.onboardingApplications.push(application);
      audit(db, user.id, 'submitted', 'onboarding_application', application.id, { type: applicationType });
      sendJson(res, 201, { data: { id: application.id, type: application.type, status: application.status, createdAt: timestamp } });
    });
    return true;
  }

  if (key === 'GET /api/v1/onboarding/applications') {
    const user = await requireUser(req);
    assertRole(user, ['admin']);
    const db = await store.read();
    db.onboardingApplications ||= [];
    sendJson(res, 200, {
      data: db.onboardingApplications
        .slice()
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map((item) => ({
          ...item,
          applicant: (() => {
            const applicant = db.users.find((candidate) => candidate.id === item.userId);
            return applicant ? {
              id: applicant.id,
              firstName: applicant.firstName,
              lastName: applicant.lastName,
              email: applicant.email,
              phone: applicant.phone
            } : null;
          })(),
          provider: db.providers.find((provider) => provider.id === item.providerId) || null
        }))
    });
    return true;
  }

  if (parts[2] === 'onboarding' && parts[3] === 'applications' && parts[4] && req.method === 'PATCH') {
    const admin = await requireUser(req);
    assertRole(admin, ['admin']);
    const body = await readBody(req);
    requireFields(body, ['status']);
    if (!['approved', 'rejected'].includes(body.status)) throw onboardingError('Choose approved or rejected.');

    await store.update((db) => {
      db.onboardingApplications ||= [];
      const application = getApplication(db, parts[4]);
      if (application.status !== 'pending') throw onboardingError('This application has already been reviewed.', 409);
      const applicant = db.users.find((item) => item.id === application.userId);
      if (!applicant) throw onboardingError('Applicant account no longer exists.', 409);
      const timestamp = now();
      if (body.status === 'approved') {
        const providerId = body.providerId || application.providerId;
        const provider = db.providers.find((item) => item.id === providerId && item.isActive && item.onboardingStatus === 'active');
        if (!provider) throw onboardingError('An active approved provider organization is required to approve this application.');
        application.providerId = provider.id;
        applicant.role = application.type === 'clinician' ? 'clinician' : 'hospital_staff';
        applicant.providerId = provider.id;
        if (application.type === 'clinician') {
          applicant.consultationAvailability = {
            enabled: false,
            acceptedTiers: [],
            specialtyIds: application.specialtyIds,
            procedureIds: []
          };
        }
        applicant.updatedAt = timestamp;
      }
      application.status = body.status;
      application.reviewedByUserId = admin.id;
      application.reviewedAt = timestamp;
      application.updatedAt = timestamp;
      audit(db, admin.id, body.status, 'onboarding_application', application.id, { type: application.type, userId: applicant.id });
      sendJson(res, 200, {
        data: {
          id: application.id,
          type: application.type,
          status: application.status,
          reviewedAt: application.reviewedAt,
          user: {
            id: applicant.id,
            role: applicant.role,
            providerId: applicant.providerId || null
          }
        }
      });
    });
    return true;
  }

  return false;
}
