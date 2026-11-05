import { handleBillingRoutes } from './billingRoutes.js';
import { handleDocumentRoutes } from './documentRoutes.js';
import { handleLeadRoutes } from './leadRoutes.js';
import { handleReferralRoutes } from './referralRoutes.js';

export async function handleLeadReferralRoutes(context) {
  if (await handleLeadRoutes(context)) return true;
  if (await handleReferralRoutes(context)) return true;
  if (await handleDocumentRoutes(context)) return true;
  if (await handleBillingRoutes(context)) return true;
  return false;
}
