// Read-only reconciliation of waiting orders against a spreadsheet: evidence by Skyfly ID, then by
// phone + time + name, without inventing matches. Made-up data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchEvidence, parseSheetTime, columnsOf, maskName, maskPhone } from '../src/services/sheetEvidence.js';

const order = (o) => ({ reference: 'LR-AAAA111', idempotency_key: 'idem-aaaaaaaaaaaaaaaa', customer_name: 'Ada Obi', phone: '+2348031110001', total_minor: 3000000, created_at: '2026-10-20T10:00:00Z', ...o });

test('sheet times: ISO, day/month ambiguity resolved towards the order time, 12-hour clock, Lagos time', () => {
  assert.equal(parseSheetTime('2026-10-20T10:00:00.000Z'), Date.parse('2026-10-20T10:00:00Z'));
  // 11:05 Lagos = 10:05 UTC; "05/10" read as 5 October would be 15 days away from a 20 October order... both options exist:
  const near = Date.parse('2026-10-05T10:00:00Z');
  assert.equal(parseSheetTime('05/10/2026 11:05:00', near), Date.parse('2026-10-05T10:05:00Z'));
  assert.equal(parseSheetTime('10/05/2026 11:05:00', near), Date.parse('2026-10-05T10:05:00Z'));
  assert.equal(parseSheetTime('20/10/2026 1:30 PM'), Date.parse('2026-10-20T12:30:00Z'));
  assert.equal(parseSheetTime(''), null);
  assert.equal(parseSheetTime('soon'), null);
});

test('columns are found under the wordings older pages used', () => {
  const c = columnsOf(['Timestamp', 'Full Name', 'Phone Number', 'Address', 'Package', 'Quantity', 'Total', 'orderId', 'skyflyId', 'source']);
  assert.deepEqual([c.time, c.name, c.phone, c.product, c.quantity, c.total, c.orderId, c.skyflyId, c.source], [0, 1, 2, 4, 5, 6, 7, 8, 9]);
  assert.equal(columnsOf(['Business name', 'Customer']).name, 1);
});

test('matching: by Skyfly ID first, then same phone and time, else not found; nothing is matched twice', () => {
  const tabs = [
    { title: 'Skyfly orders', values: [['timestamp', 'fullName', 'phone', 'orderId', 'skyflyId', 'source'], ['2026-10-20T10:00:00Z', 'Ada Obi', '+2348031110001', 'LR-AAAA111', '', '']] },
    { title: 'Sheet1', values: [['Timestamp', 'Full Name', 'Phone', 'Package', 'Total'],
      ['20/10/2026 12:10:00', 'Bola Ade', '08031110002', 'Glow Duo', '30000'], // Bola, 11:10 UTC
      ['01/09/2026 09:00:00', 'Chi Eze', '08031110003', 'Glow Duo', '30000'], // Chi, but six weeks earlier
      ['20/10/2026 13:00:00', 'Stranger', '08039999999', 'Glow Duo', '30000']] }, // no Skyfly order
  ];
  const orders = [
    order({}),
    order({ reference: 'LR-BBBB222', idempotency_key: 'idem-b', customer_name: 'Bola Ade', phone: '+2348031110002', created_at: '2026-10-20T11:00:00Z' }),
    order({ reference: 'LR-CCCC333', idempotency_key: 'idem-c', customer_name: 'Chi Eze', phone: '+2348031110003', created_at: '2026-10-20T12:00:00Z' }),
    order({ reference: 'LR-DDDD444', idempotency_key: 'idem-d', customer_name: 'Dayo Ola', phone: '+2348031110004', created_at: '2026-10-20T12:30:00Z' }),
  ];
  const { results, sheetOnly } = matchEvidence(orders, tabs);
  assert.deepEqual(results.map((r) => r.verdict), ['IN_SHEET_BY_SKYFLY_ID', 'LIKELY_IN_SHEET_SAME_PHONE_AND_TIME', 'SAME_PHONE_DIFFERENT_TIME', 'NOT_FOUND_IN_SHEET']);
  assert.equal(results[1].diffMin, 10);
  assert.equal(results[1].nameMatch, true);
  assert.deepEqual(sheetOnly.map((r) => r.row), [4], 'the stranger row is reported as matching no order');
});

test('masking keeps only a first initial and the last 4 phone digits', () => {
  assert.equal(maskName('Ada Obi'), 'A.');
  assert.equal(maskPhone('+2348031110001'), '…0001');
});
