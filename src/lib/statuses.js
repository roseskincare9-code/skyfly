export const ORDER_STATUSES = [
  { value: 'new', label: 'New' },
  { value: 'pending_confirmation', label: 'Pending confirmation' },
  { value: 'confirmed', label: 'Confirmed' },
  { value: 'processing', label: 'Processing' },
  { value: 'dispatched', label: 'Dispatched' },
  { value: 'delivered', label: 'Delivered' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'returned', label: 'Returned' },
];

export const STATUS_LABELS = Object.fromEntries(ORDER_STATUSES.map((s) => [s.value, s.label]));
export const STATUS_VALUES = ORDER_STATUSES.map((s) => s.value);

// Sales definitions shown on the dashboard.
export const SALES_DEFINITIONS = {
  // Customer has confirmed and the order has not been cancelled or returned.
  confirmed: ['confirmed', 'processing', 'dispatched', 'delivered'],
  // Goods handed over to the customer.
  delivered: ['delivered'],
  // Not yet confirmed by phone/WhatsApp.
  pipeline: ['new', 'pending_confirmation'],
  lost: ['cancelled', 'returned'],
};

export const LANDING_PAGE_STATUSES = ['draft', 'active', 'paused', 'archived'];
