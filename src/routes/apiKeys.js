import { Router } from 'express';
import { asyncHandler } from '../lib/http.js';
import { newApiKey } from '../lib/apiKeys.js';
import { audit } from '../lib/audit.js';

export function apiKeyRoutes({ pool }) {
  const router = Router({ mergeParams: true });

  async function render(req, res, newKey = null, status = 200) {
    const { rows } = await pool.query(
      'SELECT id, name, key_prefix, created_at, last_used_at, revoked_at FROM api_keys WHERE business_id = $1 ORDER BY created_at DESC',
      [req.business.id],
    );
    res.set('Cache-Control', 'no-store');
    res.status(status).render('api-keys', { keys: rows, newKey, active: 'apikeys' });
  }

  router.get('/', asyncHandler((req, res) => render(req, res)));

  // The full key is shown once, right after creation; only its hash is stored.
  router.post('/', asyncHandler(async (req, res) => {
    const name = String(req.body.name ?? '').trim().slice(0, 100) || 'API key';
    const { key, prefix, hash } = newApiKey();
    const { rows } = await pool.query(
      'INSERT INTO api_keys (business_id, name, key_prefix, key_hash, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [req.business.id, name, prefix, hash, req.session.userId],
    );
    await audit(pool, req, { action: 'api_key.created', businessId: req.business.id, entityType: 'api_key', entityId: rows[0].id, details: { name, prefix } });
    return render(req, res, key, 201);
  }));

  router.post('/:keyId/revoke', asyncHandler(async (req, res) => {
    const { rowCount } = await pool.query(
      'UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND business_id = $2 AND revoked_at IS NULL',
      [req.params.keyId, req.business.id],
    );
    if (rowCount) await audit(pool, req, { action: 'api_key.revoked', businessId: req.business.id, entityType: 'api_key', entityId: req.params.keyId });
    res.redirect(`${res.locals.base}/api-keys`);
  }));

  return router;
}
