// Append-only record of security-relevant and business actions. Never logs secrets.
export async function audit(db, req, { action, businessId = null, entityType = null, entityId = null, details = null }) {
  await db.query(
    `INSERT INTO audit_log (business_id, user_id, action, entity_type, entity_id, details, ip)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [businessId, req?.session?.userId ?? null, action, entityType, entityId === null ? null : String(entityId),
      details ? JSON.stringify(details) : null, req?.ip ?? null],
  );
}
