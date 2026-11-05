import { createReadStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

import { canViewReferral, makeId, normalizeString, now } from '../domain.js';

export async function handleDocumentRoutes(context) {
  const {
    req,
    res,
    parts,
    store,
    sendJson,
    requireUser,
    readBody,
    requireFields,
    config,
    securityHeaders,
    audit
  } = context;

  if (parts[2] === 'referrals' && parts[3] && parts[4] === 'documents') {
    const user = await requireUser(req);
    const db = await store.read();
    const referral = db.referrals.find((item) => item.referralNumber === parts[3]);
    if (!referral || !canViewReferral(user, referral)) {
      const error = new Error('Referral not found.');
      error.status = 404;
      throw error;
    }
    if (req.method === 'GET') {
      sendJson(res, 200, { data: db.documents.filter((item) => item.referralId === referral.id) });
      return true;
    }
    if (req.method === 'POST') {
      const body = await readBody(req);
      requireFields(body, ['documentType', 'fileName']);
      await store.update(async (freshDb) => {
        const freshReferral = freshDb.referrals.find((item) => item.id === referral.id);
        const timestamp = now();
        const fileName = normalizeString(body.fileName, 255).replace(/[\\/]/g, '_');
        const contentBase64 = String(body.contentBase64 || '');
        if (contentBase64 && (!/^[A-Za-z0-9+/]*={0,2}$/.test(contentBase64) || contentBase64.length > config.maxBodyBytes)) {
          const error = new Error('Document content must be valid base64 within the request size limit.');
          error.status = 422;
          throw error;
        }

        const documentId = makeId('document');
        const storagePath = contentBase64
          ? `${freshReferral.referralNumber}/${documentId}-${fileName}`
          : normalizeString(body.storagePath || `pending/${freshReferral.referralNumber}/${fileName}`, 500);

        if (contentBase64) {
          await mkdir(dirname(join(config.documentDir, storagePath)), { recursive: true });
          await writeFile(join(config.documentDir, storagePath), Buffer.from(contentBase64, 'base64'), { flag: 'wx' });
        }

        const document = {
          id: documentId,
          referralId: freshReferral.id,
          patientId: freshReferral.patientId,
          documentType: normalizeString(body.documentType, 50),
          fileName,
          storageDisk: contentBase64 ? 'private-local' : 'mvp-metadata',
          storagePath,
          fileSizeBytes: contentBase64 ? Buffer.from(contentBase64, 'base64').length : body.fileSizeBytes || null,
          mimeType: normalizeString(body.mimeType, 100),
          uploadedByUserId: user.id,
          isPublic: false,
          createdAt: timestamp,
          updatedAt: timestamp
        };
        freshDb.documents.push(document);
        audit(freshDb, user.id, 'uploaded_metadata', 'document', document.id);
        sendJson(res, 201, { data: document });
      });
      return true;
    }
  }

  if (parts[2] === 'documents' && parts[3] && parts[4] === 'download' && req.method === 'GET') {
    const user = await requireUser(req);
    const db = await store.read();
    const document = db.documents.find((item) => item.id === parts[3]);
    const referral = document && db.referrals.find((item) => item.id === document.referralId);
    if (!document || !referral || !canViewReferral(user, referral) || document.storageDisk !== 'private-local') {
      const error = new Error('Document not found.');
      error.status = 404;
      throw error;
    }
    const filePath = resolve(config.documentDir, document.storagePath);
    const documentRoot = resolve(config.documentDir);
    if (!filePath.startsWith(`${documentRoot}${sep}`)) {
      const error = new Error('Document not found.');
      error.status = 404;
      throw error;
    }
    res.writeHead(200, securityHeaders({
      'content-type': document.mimeType || 'application/octet-stream',
      'content-disposition': `attachment; filename="${document.fileName.replace(/"/g, '')}"`
    }));
    createReadStream(filePath).on('error', () => res.destroy()).pipe(res);
    return true;
  }

  return false;
}
