const RESOURCES = new Set(['patients', 'staff', 'stock', 'incidents']);
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function pathOf(req) {
  return (
    String(req.path || req.url || '')
      .split('?')[0]
      .replace(/\/+$/, '') || '/'
  );
}

function resourcesFor(req) {
  if (!WRITE_METHODS.has(req.method)) return [];
  const path = pathOf(req);
  if (path === '/session' || path === '/presence') return [];
  if (path === '/register' || /(?:^|\/)(?:staff|accounts)(?:\/|$)/.test(path))
    return ['staff'];
  if (/(?:^|\/)patients(?:\/|$)/.test(path)) return ['patients'];
  if (/(?:^|\/)stock(?:\/|$)/.test(path)) return ['stock'];
  if (/(?:^|\/)incidents(?:\/|$)/.test(path)) return ['incidents'];
  return [];
}

function responseIncidentId(payload) {
  const candidates = [
    payload?.incident?.id,
    payload?.patient?.incidentId,
    payload?.incidentId,
  ];
  return candidates.find((value) => typeof value === 'string' && value) || null;
}

function writeSse(res, event, data) {
  if (!res.writableEnded && !res.destroyed) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
}

export function createLiveUpdates({ heartbeatMs = 25_000 } = {}) {
  const subscribers = new Set();
  let heartbeat = null;

  const stopHeartbeat = () => {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
  };
  const startHeartbeat = () => {
    if (heartbeat || heartbeatMs <= 0) return;
    heartbeat = setInterval(() => {
      for (const subscriber of subscribers) {
        if (!subscriber.res.writableEnded && !subscriber.res.destroyed)
          subscriber.res.write(': heartbeat\n\n');
      }
    }, heartbeatMs);
    heartbeat.unref?.();
  };
  const remove = (subscriber) => {
    subscribers.delete(subscriber);
    if (!subscribers.size) stopHeartbeat();
  };

  function notify(resource, incidentId = null) {
    if (!RESOURCES.has(resource)) return;
    const data = { resource, incidentId: incidentId || null };
    for (const subscriber of subscribers)
      writeSse(subscriber.res, 'change', data);
  }

  function observe(req, res, next) {
    const resources = resourcesFor(req);
    if (!resources.length) return next();
    let payload = null;
    const json = res.json.bind(res);
    res.json = (body) => {
      payload = body;
      return json(body);
    };
    res.once('finish', () => {
      if (res.statusCode < 200 || res.statusCode >= 300) return;
      const incidentId =
        responseIncidentId(payload) ||
        req.get('X-Incident-ID') ||
        req.query.incident ||
        'legacy';
      for (const resource of resources)
        notify(resource, resource === 'staff' ? null : incidentId);
    });
    next();
  }

  function subscribe(req, res) {
    res.status(200).set({
      'Cache-Control': 'no-cache, no-store',
      Connection: 'keep-alive',
      'Content-Type': 'text/event-stream; charset=utf-8',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();
    const subscriber = { req, res };
    subscribers.add(subscriber);
    const expiry = req.sessionExpiresAt
      ? setTimeout(
          () => res.end(),
          Math.max(1, req.sessionExpiresAt - Date.now()),
        )
      : null;
    expiry?.unref();
    const cleanup = () => {
      clearTimeout(expiry);
      remove(subscriber);
    };
    req.once('close', cleanup);
    res.once('close', cleanup);
    writeSse(res, 'ready', { ready: true });
    startHeartbeat();
  }

  function close() {
    stopHeartbeat();
    for (const subscriber of [...subscribers]) {
      remove(subscriber);
      subscriber.res.end();
    }
  }

  return { observe, subscribe, notify, close };
}
