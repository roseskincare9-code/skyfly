export const ORDER_STATUSES = [
  { value: 'pending', label: 'Pending' },
  { value: 'confirmed', label: 'Confirmed / Approved' },
  { value: 'processing', label: 'Processing' },
  { value: 'dispatched', label: 'Dispatched' },
  { value: 'delivered', label: 'Delivered' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'returned', label: 'Returned' },
];

export const PAYMENT_STATUSES = [
  { value: 'unpaid', label: 'Unpaid' },
  { value: 'pending', label: 'Payment pending' },
  { value: 'paid', label: 'Paid' },
  { value: 'failed', label: 'Payment failed' },
  { value: 'refunded', label: 'Refunded' },
];

export const STATUS_LABELS = Object.fromEntries(ORDER_STATUSES.map((s) => [s.value, s.label]));
export const STATUS_VALUES = ORDER_STATUSES.map((s) => s.value);
export const PAYMENT_LABELS = Object.fromEntries(PAYMENT_STATUSES.map((s) => [s.value, s.label]));
export const PAYMENT_VALUES = PAYMENT_STATUSES.map((s) => s.value);

// Sales definitions shown on the dashboard.
export const SALES_DEFINITIONS = {
  // Approved by the business and not cancelled or returned.
  confirmed: ['confirmed', 'processing', 'dispatched', 'delivered'],
  delivered: ['delivered'],
  // Not yet confirmed by phone/WhatsApp.
  pipeline: ['pending'],
  lost: ['cancelled', 'returned'],
};

export const LANDING_PAGE_STATUSES = ['draft', 'active', 'paused', 'archived'];
