export function patientLink(code, incidentId = 'legacy', view) {
  const page = view === 'cards-v2' ? '#cards-v2' : '';
  return `/?incident=${encodeURIComponent(incidentId)}&id=${encodeURIComponent(code)}${page}`;
}

export function scannedPatientLink(raw, origin) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin ||
      url.username || url.password || !['/', '/index.html'].includes(url.pathname)) return null;

  const ids = url.searchParams.getAll('id');
  const incidents = url.searchParams.getAll('incident');
  if (ids.length !== 1 || incidents.length > 1) return null;
  const [id] = ids;
  const [incident = 'legacy'] = incidents;
  if (!/^MCI-(?:[0-9]{3}|[1-9][0-9]{3,})$/.test(id) || id === 'MCI-000' ||
      !/^[a-z0-9_-]+$/.test(incident)) return null;
  return patientLink(id, incident, url.hash === '#cards-v2' ? 'cards-v2' : 'cards');
}
