// A Google service account key file uploaded by the platform owner (Platform admin → Google key),
// stored encrypted with SKYFLY_ENCRYPTION_KEY like every other third-party secret. It is used
// instead of the server setting, and is never shown again (only its email and project).
import { encrypt, decrypt } from '../lib/secrets.js';
import { readServiceAccount } from './googleSheetsApi.js';
import { savePlatformSetting } from './tenancy.js';

const SETTING = 'google_service_account';

export async function storedGoogleKey(pool, key) {
  const { rows: [r] } = await pool.query('SELECT value, updated_at FROM platform_settings WHERE key = $1', [SETTING]);
  if (!r) return null;
  if (!key) return { account: null, problem: 'SKYFLY_ENCRYPTION_KEY is not set, so the uploaded key cannot be read', savedAt: r.updated_at };
  try {
    return { ...readServiceAccount(decrypt(key, r.value?.enc)), savedAt: r.updated_at };
  } catch {
    return { account: null, problem: 'the uploaded key cannot be decrypted (SKYFLY_ENCRYPTION_KEY was changed); upload it again', savedAt: r.updated_at };
  }
}

export const saveGoogleKey = (pool, key, text) => savePlatformSetting(pool, SETTING, { enc: encrypt(key, text) });
export const removeGoogleKey = (pool) => pool.query('DELETE FROM platform_settings WHERE key = $1', [SETTING]);
