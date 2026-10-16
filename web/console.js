const $ = (id) => document.getElementById(id);
const state = { token: null, events: [], reservations: [], pending: null };

function notify(message, isError = false) {
  const notice = $('notice');
  notice.textContent = message;
  notice.hidden = false;
  notice.classList.toggle('error', isError);
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}

async function api(path, { method = 'GET', body, idempotencyKey } = {}) {
  if (!state.token) throw new Error('Connect an API key to continue.');
  const headers = { Authorization: `Bearer ${state.token}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  let response;
  try {
    response = await fetch(path, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error('Network unavailable. Try again with the same reservation request.');
  }
  const payload = await response.json();
  if (!response.ok) {
    if (response.status === 401) disconnect();
    const message = payload.error?.message || `HTTP ${response.status}`;
    const retry = response.headers.get('Retry-After');
    throw new Error(retry ? `${message} (retry in ${retry}s)` : message);
  }
  return payload;
}

function disconnect() {
  state.token = null;
  state.events = [];
  state.reservations = [];
  state.pending = null;
  $('connection-indicator').innerHTML = '<i></i> Disconnected';
  $('disconnect').hidden = true;
  $('reservation-form').hidden = true;
  $('connect-form').hidden = false;
  $('event-count').textContent = '—';
  $('available-count').textContent = '—';
  $('booking-count').textContent = '—';
  $('engine-status').textContent = 'Offline';
  $('events-list').replaceChildren(element('p', 'placeholder', 'Connect with an API key to load events.'));
  $('reservations-list').replaceChildren(element('p', 'placeholder', 'Connect with an API key to load reservations.'));
  $('audit-list').replaceChildren();
}

function pill(text, type = '') {
  return element('span', `badge ${type}`, text);
}

function renderEvents() {
  const container = $('events-list');
  container.replaceChildren();
  const select = $('event-select');
  select.replaceChildren();
  if (!state.events.length) container.append(element('p', 'placeholder', 'No events have been created yet.'));
  for (const event of state.events) {
    const card = element('article', 'event-card');
    const badge = element('div', 'event-mark', '◇');
    const body = element('div', 'event-card-body');
    body.append(element('span', 'event-caption', 'PUBLIC EVENT'), element('h3', '', event.name));
    const progress = element('div', 'progress-track');
    const fill = element('span', 'progress-fill');
    fill.style.width = `${Math.max(0, Math.min(100, event.capacity ? (event.available / event.capacity) * 100 : 0))}%`;
    progress.append(fill);
    const meta = element('div', 'event-meta');
    meta.append(element('span', '', `${event.available} / ${event.capacity} seats available`), pill(event.available ? 'OPEN' : 'SOLD OUT', event.available ? 'positive' : 'negative'));
    body.append(progress, meta);
    card.append(badge, body);
    container.append(card);
    const option = element('option', '', `${event.name} (${event.available} left)`);
    option.value = event.id;
    option.disabled = event.available === 0;
    select.append(option);
  }
  $('event-count').textContent = String(state.events.length);
  $('available-count').textContent = String(state.events.reduce((acc, e) => acc + e.available, 0));
}

function renderReservations() {
  const container = $('reservations-list');
  container.replaceChildren();
  const eventNames = new Map(state.events.map((item) => [item.id, item.name]));
  if (!state.reservations.length) container.append(element('p', 'placeholder', 'No reservations yet.'));
  for (const reservation of state.reservations) {
    const card = element('article', 'booking-card');
    const main = element('div', 'booking-description');
    main.append(
      element('span', 'eyebrow', 'RESERVATION'),
      element('h3', '', eventNames.get(reservation.event_id) || reservation.event_id),
      element('small', '', `${reservation.quantity} seat(s) · ${new Date(reservation.created_at).toLocaleString()}`),
    );
    const controls = element('div', 'booking-controls');
    controls.append(pill(reservation.status.toUpperCase(), reservation.status === 'confirmed' ? 'positive' : 'negative'));
    if (reservation.status === 'confirmed') {
      const cancel = element('button', 'button outline small', 'Cancel booking');
      cancel.type = 'button';
      cancel.addEventListener('click', async () => {
        cancel.disabled = true;
        try {
          await api(`/v1/reservations/${reservation.id}/cancel`, { method: 'POST' });
          notify('Reservation cancelled. Inventory has been restored exactly once.');
          await reload();
        } catch (error) {
          notify(error.message, true);
        } finally {
          cancel.disabled = false;
        }
      });
      controls.append(cancel);
    }
    card.append(main, controls);
    container.append(card);
  }
  $('booking-count').textContent = String(state.reservations.filter((r) => r.status === 'confirmed').length);
}

async function reload() {
  const [events, bookings] = await Promise.all([
    api('/v1/events?limit=100'), api('/v1/reservations?limit=100'),
  ]);
  state.events = events.data;
  state.reservations = bookings.data;
  renderEvents();
  renderReservations();
  $('engine-status').textContent = 'Online';
  $('reservation-form').hidden = false;
}

$('connect-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const raw = $('api-key').value.trim();
  $('api-key').value = '';
  if (!/^rf_[A-Za-z0-9_-]{43}$/.test(raw)) {
    notify('Enter a valid ReserveFlow API key.', true);
    return;
  }
  state.token = raw;
  try {
    await reload();
    $('connect-form').hidden = true;
    $('disconnect').hidden = false;
    $('connection-indicator').innerHTML = '<i></i> Connected';
    notify('Connected. Credentials will be forgotten when the tab is closed or refreshed.');
  } catch (error) {
    disconnect();
    notify(error.message, true);
  }
});

$('disconnect').addEventListener('click', () => {
  disconnect();
  notify('Session cleared from browser memory.');
});
$('refresh').addEventListener('click', async () => {
  try { await reload(); notify('Workspace refreshed.'); }
  catch (error) { notify(error.message, true); }
});

$('reservation-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const eventId = $('event-select').value;
  const quantity = Number($('quantity').value);
  if (!eventId || !Number.isInteger(quantity) || quantity < 1 || quantity > 100) {
    notify('Select an event and enter a quantity between 1 and 100.', true);
    return;
  }
  if (!state.pending || state.pending.event_id !== eventId || state.pending.quantity !== quantity) {
    state.pending = { event_id: eventId, quantity, key: crypto.randomUUID() };
  }
  const submit = $('reservation-form').querySelector('button[type="submit"]');
  submit.disabled = true;
  try {
    await api('/v1/reservations', {
      method: 'POST',
      body: { event_id: state.pending.event_id, quantity: state.pending.quantity },
      idempotencyKey: state.pending.key,
    });
    state.pending = null;
    notify('Reservation confirmed and persisted successfully.');
    await reload();
  } catch (error) {
    notify(`${error.message} Your retry will reuse the same idempotency key.`, true);
  } finally {
    submit.disabled = false;
  }
});

$('event-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const name = $('event-name').value.trim();
  const capacity = Number($('event-capacity').value);
  try {
    await api('/v1/events', { method: 'POST', body: { name, capacity } });
    notify('Event created successfully.');
    $('event-name').value = '';
    await reload();
  } catch (error) { notify(error.message, true); }
});

$('audit-button').addEventListener('click', async () => {
  try {
    const result = await api('/v1/audit?limit=20');
    $('audit-list').replaceChildren();
    for (const record of result.data) {
      $('audit-list').append(element('li', '', `#${record.sequence} · ${record.action} · ${new Date(record.created_at).toLocaleString()}`));
    }
    if (!result.data.length) $('audit-list').append(element('li', '', 'No records found.'));
  } catch (error) { notify(error.message, true); }
});

disconnect();
