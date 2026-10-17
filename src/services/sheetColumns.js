// Column names, in the order the landing page has always written them.
export const SHEET_COLUMNS = ['timestamp', 'fullName', 'address', 'phone', 'email', 'package', 'source', 'state', 'quantity', 'notes', 'skyflyId', 'total'];
// Without these the copy is not useful (source also carries the reference used to avoid duplicates).
export const REQUIRED_COLUMNS = ['fullName', 'phone', 'package', 'source'];
