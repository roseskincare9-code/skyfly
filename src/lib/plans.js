// Skyfly's subscription plans. The monthly price fills in the subscription price when the Super Admin picks
// a plan (it can still be changed per business, e.g. for a discount). Plan-specific limits are not defined
// yet: both plans currently get the same features and the platform's usual limits.
export const PLANS = {
  business_pro: { label: 'Business Pro', priceMinor: 19900000, currency: 'NGN' },
  agency_vip: { label: 'Agency VIP', priceMinor: 39900000, currency: 'NGN' },
};
export const planLabel = (plan) => PLANS[plan]?.label ?? null;
