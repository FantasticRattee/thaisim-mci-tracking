export function patientLink(code, incidentId = 'legacy', view) {
  const page = view === 'cards-v2' ? '#cards-v2' : '';
  return `/?incident=${encodeURIComponent(incidentId)}&id=${encodeURIComponent(code)}${page}`;
}
