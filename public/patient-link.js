export function patientLink(code, incidentId = 'legacy') {
  return `/?incident=${encodeURIComponent(incidentId)}&id=${encodeURIComponent(code)}`;
}
