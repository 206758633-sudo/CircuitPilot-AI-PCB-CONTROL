export function startRegistrationHandshake({
  client,
  service,
  isRegistered,
  intervalMs = 500,
  maxAttempts = 20,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  now = Date.now,
}) {
  let attempts = 0;
  let timer = null;
  let stopped = false;

  const stop = () => {
    stopped = true;
    if (timer) clearIntervalFn(timer);
    timer = null;
  };

  const send = () => {
    if (stopped || isRegistered() || client.readyState !== 1) {
      stop();
      return;
    }
    attempts += 1;
    client.send(JSON.stringify({ type: 'handshake', service, clientType: 'eda', timestamp: now() }));
    if (attempts >= maxAttempts) stop();
  };

  send();
  if (!stopped && !isRegistered()) timer = setIntervalFn(send, intervalMs);
  return { stop, send, get attempts() { return attempts; } };
}
