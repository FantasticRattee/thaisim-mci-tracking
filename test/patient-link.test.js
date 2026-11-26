import test from 'node:test';
import assert from 'node:assert/strict';
import { patientLink, scannedPatientLink } from '../public/patient-link.js';

const origin = 'https://practice.example';

test('camera and image scans route to the incident and card printed on each V1 or V2 QR', () => {
  for (const [id, incident, view] of [
    ['MCI-001', 'legacy'],
    ['MCI-010', 'inc-20cf2492'],
    ['MCI-1000000', 'inc-12345678-1234-1234-1234-123456789abc', 'cards-v2'],
  ]) {
    const printed = patientLink(id, incident, view);
    assert.equal(scannedPatientLink(origin + printed, origin), printed);
  }
  assert.equal(scannedPatientLink(origin + '/?id=MCI-001', origin), patientLink('MCI-001', 'legacy'));
});

test('scanning an unrelated QR or an ambiguous card leaves the current chart alone', () => {
  for (const raw of [
    'MCI-001', 'https://another.example/?id=MCI-001', origin + '/api/other?id=MCI-001',
    origin + '/?incident=&id=MCI-001', origin + '/?id=MCI-001&id=MCI-002',
    origin + '/?id=MCI-0001', origin + '/?id=MCI-000', origin + '/#cards-v2',
  ]) {
    assert.equal(scannedPatientLink(raw, origin), null);
  }
});
