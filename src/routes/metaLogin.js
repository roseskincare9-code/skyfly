// Meta sends the owner back here after Facebook Login (the one fixed address registered in Skyfly's Meta app).
// The state ties the return to the same signed-in user and business that started it, once, within 10 minutes;
// only that business's own owner (not a Super Admin visiting) may connect its accounts.
import { Router } from 'express';
import { asyncHandler } from '../lib/http.js';
import { audit } from '../lib/audit.js';
import { workspaceAccess } from '../services/tenancy.js';
import { useLoginState, finishLogin } from '../services/metaLogin.js';
import { MetaError } from '../services/metaAds.js';

export function metaLoginCallbackRoutes({ pool, config }) {
  const router = Router();
  router.get('/meta/oauth/callback', asyncHandler(async (req, res) => {
    const userId = req.session.userId;
    const businessId = userId ? await useLoginState(pool, { state: req.query.state, userId }) : null;
    const access = businessId ? await workspaceAccess(pool, userId, businessId) : null;
    if (!access || access.role !== 'owner') {
      return res.status(400).render('error', { message: 'This Facebook sign-in link has expired or was not started from your account. Open AI Media Buyer → Advertising Settings and click "Connect with Facebook" again.' });
    }
    const settings = `/businesses/${businessId}/media-buyer?tab=settings`;
    req.business = access.business;
    if (req.query.error || !req.query.code) {
      await audit(pool, req, { action: 'media_buyer.facebook_login_cancelled', businessId, details: { reason: String(req.query.error_reason ?? req.query.error ?? 'no code').slice(0, 100) } });
      return res.redirect(`${settings}&done=fb_cancelled`);
    }
    try {
      await finishLogin(pool, config, { businessId, userId, code: String(req.query.code) });
      await audit(pool, req, { action: 'media_buyer.facebook_login_completed', businessId });
      return res.redirect(`${settings}&done=fb_pick#facebook-accounts`);
    } catch (err) {
      if (!(err instanceof MetaError)) throw err;
      await audit(pool, req, { action: 'media_buyer.meta_connect_failed', businessId, details: { via: 'facebook_login', error: err.message } });
      return res.redirect(`${settings}&fb_error=${encodeURIComponent(err.message.slice(0, 300))}`);
    }
  }));
  return router;
}
