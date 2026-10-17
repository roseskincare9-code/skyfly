// Column names, in the order the landing page has always written them.
// orderId (the order reference, e.g. LR-AB12CD3) and status (when copied) were added last, so
// sheets made before them keep working; the Apps Script adds them to an existing column row.
export const SHEET_COLUMNS = ['timestamp', 'fullName', 'address', 'phone', 'email', 'package', 'source', 'state', 'quantity', 'notes', 'skyflyId', 'total', 'orderId', 'status'];
// The tab Skyfly writes to (created when missing); a spreadsheet's other tabs are left alone.
export const SKYFLY_TAB = 'Skyfly Orders';
// Without these the copy is not useful (source also carries the reference used to avoid duplicates).
export const REQUIRED_COLUMNS = ['fullName', 'phone', 'package', 'source'];
