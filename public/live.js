// The stream carries change notices. Fetching the selected view again also
// recovers changes missed while a phone was asleep or switching networks.
export function observeUpdates({ refresh, status }) {
  let timer;
  let active = true;
  let busy = false;
  const pending = new Map();
  function queue(change) {
    if (!active) return;
    pending.set([change.resource, change.incidentId].join(':'), change);
    clearTimeout(timer);
    timer = setTimeout(flush, 80);
  }
  async function flush() {
    if (!active || busy || document.hidden || !pending.size) return;
    const changes = [...pending.values()];
    pending.clear();
    busy = true;
    try {
      await refresh(changes);
    } finally {
      busy = false;
      if (active && pending.size) timer = setTimeout(flush, 80);
    }
  }
  const fullRefresh = () => queue({ resource: 'all', incidentId: null });
  const onVisible = () => {
    if (!document.hidden) fullRefresh();
  };
  let stream;
  let interval;
  if (window.EventSource) {
    stream = new EventSource('/api/live');
    stream.addEventListener('ready', () => {
      status('live');
      fullRefresh();
    });
    stream.addEventListener('change', (event) => queue(JSON.parse(event.data)));
    stream.onerror = () => status('reconnecting');
  } else {
    status('periodic');
    interval = setInterval(fullRefresh, 5000);
  }
  document.addEventListener('visibilitychange', onVisible);
  return {
    close() {
      active = false;
      stream?.close();
      clearInterval(interval);
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    },
  };
}
