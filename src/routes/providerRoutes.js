import { assertRole, makeId, normalizeEmail, normalizeString, now } from '../domain.js';

export async function handleProviderRoutes(context) {
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

  if (key === 'GET /api/v1/providers') {
    const db = await store.read();
    sendJson(res, 200, { data: db.providers });
    return true;
  }

  if (key === 'POST /api/v1/providers') {
    const user = await requireUser(req);
    assertRole(user, ['admin', 'coordinator']);
    const body = await readBody(req);
    requireFields(body, ['name', 'type', 'city']);
    await store.update((db) => {
      const providerTypes = ['hospital', 'clinic', 'diagnostic_center'];
      const onboardingStatuses = ['invited', 'documents_submitted', 'verified', 'active', 'suspended'];
      const trainingStatuses = ['not_started', 'in_training', 'trained'];
      if (!providerTypes.includes(body.type) || !onboardingStatuses.includes(body.onboardingStatus || 'invited') || !trainingStatuses.includes(body.trainingStatus || 'not_started')) {
        const error = new Error('Provider type, onboarding status, or training status is invalid.');
        error.status = 422;
        throw error;
      }
      const timestamp = now();
      const provider = {
        id: makeId('provider'),
        name: normalizeString(body.name, 255),
        type: normalizeString(body.type, 50),
        city: normalizeString(body.city, 100),
        state: normalizeString(body.state, 100),
        country: normalizeString(body.country || 'Nigeria', 100),
        contactName: normalizeString(body.contactName, 200),
        contactEmail: normalizeEmail(body.contactEmail),
        contactPhone: normalizeString(body.contactPhone, 30),
        onboardingStatus: body.onboardingStatus || 'invited',
        trainingStatus: body.trainingStatus || 'not_started',
        rating: Number(body.rating || 0),
        isActive: body.isActive !== false,
        createdAt: timestamp,
        updatedAt: timestamp
      };
      db.providers.push(provider);
      audit(db, user.id, 'created', 'provider', provider.id);
      sendJson(res, 201, { data: provider });
    });
    return true;
  }

  if (parts[2] === 'providers' && parts[3] && req.method === 'GET' && parts.length === 4) {
    const db = await store.read();
    const provider = db.providers.find((item) => item.id === parts[3]);
    if (!provider) {
      const error = new Error('Provider not found.');
      error.status = 404;
      throw error;
    }
    sendJson(res, 200, { data: provider });
    return true;
  }

  if (parts[2] === 'providers' && parts[3] && req.method === 'PATCH' && parts.length === 4) {
    const user = await requireUser(req);
    assertRole(user, ['admin', 'coordinator']);
    const body = await readBody(req);
    await store.update((db) => {
      const provider = db.providers.find((item) => item.id === parts[3]);
      if (!provider) {
        const error = new Error('Provider not found.');
        error.status = 404;
        throw error;
      }
      const onboardingStatuses = ['invited', 'documents_submitted', 'verified', 'active', 'suspended'];
      const trainingStatuses = ['not_started', 'in_training', 'trained'];
      if (body.onboardingStatus !== undefined && !onboardingStatuses.includes(body.onboardingStatus)) {
        const error = new Error('Invalid provider onboarding status.');
        error.status = 422;
        throw error;
      }
      if (body.trainingStatus !== undefined && !trainingStatuses.includes(body.trainingStatus)) {
        const error = new Error('Invalid provider training status.');
        error.status = 422;
        throw error;
      }
      for (const field of ['name', 'type', 'city', 'state', 'country', 'contactName', 'contactPhone']) {
        if (body[field] !== undefined) provider[field] = normalizeString(body[field], field === 'name' ? 255 : 200);
      }
      if (body.contactEmail !== undefined) provider.contactEmail = normalizeEmail(body.contactEmail);
      if (body.onboardingStatus !== undefined) provider.onboardingStatus = body.onboardingStatus;
      if (body.trainingStatus !== undefined) provider.trainingStatus = body.trainingStatus;
      if (body.isActive !== undefined) provider.isActive = Boolean(body.isActive);
      if (body.rating !== undefined) {
        const rating = Number(body.rating);
        if (!Number.isFinite(rating) || rating < 0 || rating > 5) {
          const error = new Error('Provider rating must be between 0 and 5.');
          error.status = 422;
          throw error;
        }
        provider.rating = rating;
      }
      provider.updatedAt = now();
      audit(db, user.id, 'updated', 'provider', provider.id);
      sendJson(res, 200, { data: provider });
    });
    return true;
  }

  if (parts[2] === 'providers' && parts[3] && parts[4] === 'procedures' && req.method === 'GET') {
    const db = await store.read();
    const provider = db.providers.find((item) => item.id === parts[3]);
    if (!provider) {
      const error = new Error('Provider not found.');
      error.status = 404;
      throw error;
    }
    const procedures = db.providerProcedures
      .filter((item) => item.providerId === provider.id)
      .map((item) => ({ ...item, procedure: db.procedures.find((procedure) => procedure.id === item.procedureId) }));
    sendJson(res, 200, { data: procedures });
    return true;
  }

  if (parts[2] === 'providers' && parts[3] && parts[4] === 'procedures' && req.method === 'POST') {
    const user = await requireUser(req);
    assertRole(user, ['admin', 'coordinator']);
    const body = await readBody(req);
    requireFields(body, ['procedureId']);
    await store.update((db) => {
      const provider = db.providers.find((item) => item.id === parts[3]);
      if (!provider) {
        const error = new Error('Provider not found.');
        error.status = 404;
        throw error;
      }
      const procedure = db.procedures.find((item) => item.id === body.procedureId);
      if (!procedure) {
        const error = new Error('Procedure not found.');
        error.status = 404;
        throw error;
      }
      if (body.availability && !['available', 'limited', 'unavailable'].includes(body.availability)) {
        const error = new Error('Invalid procedure availability.');
        error.status = 422;
        throw error;
      }
      const existing = db.providerProcedures.find((item) => item.providerId === provider.id && item.procedureId === body.procedureId);
      if (existing) {
        Object.assign(existing, {
          availability: body.availability || existing.availability,
          waitingTimeDays: body.waitingTimeDays ?? existing.waitingTimeDays,
          cost: body.cost ?? existing.cost,
          updatedAt: now()
        });
        sendJson(res, 200, { data: existing });
        return;
      }
      const timestamp = now();
      const capability = {
        id: makeId('capability'),
        providerId: provider.id,
        procedureId: body.procedureId,
        availability: body.availability || 'available',
        waitingTimeDays: body.waitingTimeDays ?? null,
        cost: body.cost ?? null,
        createdAt: timestamp,
        updatedAt: timestamp
      };
      db.providerProcedures.push(capability);
      audit(db, user.id, 'created', 'provider_procedure', capability.id);
      sendJson(res, 201, { data: capability });
    });
    return true;
  }

  return false;
}
