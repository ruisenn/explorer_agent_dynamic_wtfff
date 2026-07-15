const elements = {
  browserFrame: document.querySelector('#browserFrame'),
  clearButton: document.querySelector('#clearButton'),
  connectionDot: document.querySelector('#connectionDot'),
  connectionText: document.querySelector('#connectionText'),
  emptyFrame: document.querySelector('#emptyFrame'),
  goal: document.querySelector('#goal'),
  runButton: document.querySelector('#runButton'),
  runForm: document.querySelector('#runForm'),
  runState: document.querySelector('#runState'),
  startUrl: document.querySelector('#startUrl'),
  statusMessage: document.querySelector('#statusMessage'),
  statusTitle: document.querySelector('#statusTitle'),
  stopButton: document.querySelector('#stopButton'),
  timeline: document.querySelector('#timeline'),
  toast: document.querySelector('#toast'),
  useScreenshot: document.querySelector('#useScreenshot'),
};

const activeStates = new Set(['queued', 'running', 'stopping']);
const seenEvents = new Set();
let toastTimer;

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function showToast(message) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.hidden = false;
  toastTimer = setTimeout(() => {
    elements.toast.hidden = true;
  }, 5000);
}

function setStatus(status = {}) {
  const state = status.state || 'idle';
  const active = activeStates.has(state);
  elements.runState.textContent = state.toUpperCase();
  elements.runState.dataset.state = state;
  elements.statusTitle.textContent = status.goal || '尚未运行';
  elements.statusMessage.textContent = status.message || 'READY';
  elements.runButton.disabled = active;
  elements.stopButton.disabled = !active || state === 'stopping';
  elements.startUrl.disabled = active;
  elements.goal.disabled = active;
  elements.useScreenshot.disabled = active;
  if (status.frameUrl) setFrame(status.frameUrl);
}

function setFrame(url) {
  elements.browserFrame.src = url;
  elements.browserFrame.hidden = false;
  elements.emptyFrame.hidden = true;
}

function targetName(target = {}) {
  return target.testId || target.label || target.name || target.text || target.placeholder || '';
}

function appendEvent(event) {
  if (!['plan', 'action', 'state', 'error'].includes(event.type)) return;
  const empty = elements.timeline.querySelector('.timeline-empty');
  if (empty) empty.remove();

  let title = event.type;
  let detail = event.message || event.error || '';
  if (event.type === 'plan' || event.type === 'action') {
    title = `${event.action?.type || 'action'} · ${targetName(event.action?.target)}`;
    detail = event.action?.reason || event.status || detail;
  }
  if (event.type === 'state') {
    title = event.status?.state || 'state';
    detail = event.status?.message || detail;
  }

  const item = document.createElement('li');
  item.className = 'event';
  item.dataset.kind = event.type;
  if (event.status?.state) item.dataset.state = event.status.state;
  item.innerHTML = `
    <span>${escapeHtml(event.type)}</span>
    <div><strong>${escapeHtml(title)}</strong><p>${escapeHtml(detail)}</p></div>
  `;
  elements.timeline.append(item);
  while (elements.timeline.children.length > 100) elements.timeline.firstElementChild.remove();
  elements.timeline.scrollTop = elements.timeline.scrollHeight;
}

function handleEvent(event) {
  if (event.type === 'snapshot') {
    setStatus(event.status);
    return;
  }
  const key = event.id ? String(event.id) : null;
  if (key && seenEvents.has(key)) return;
  if (key) seenEvents.add(key);
  if (event.type === 'state') setStatus(event.status);
  if (event.type === 'frame') setFrame(event.frameUrl);
  appendEvent(event);
}

async function postJson(url, body = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok || payload.ok === false) throw new Error(payload.error || `Request failed: ${response.status}`);
  return payload;
}

elements.runForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await postJson('/api/run', {
      startUrl: elements.startUrl.value,
      goal: elements.goal.value,
      useScreenshot: elements.useScreenshot.checked,
    });
    setStatus({ state: 'queued', goal: elements.goal.value, message: 'Queued' });
  } catch (error) {
    showToast(error.message);
  }
});

elements.stopButton.addEventListener('click', async () => {
  try {
    await postJson('/api/stop');
  } catch (error) {
    showToast(error.message);
  }
});

elements.clearButton.addEventListener('click', () => {
  elements.timeline.innerHTML = '<li class="timeline-empty">交互记录已清空</li>';
});

const eventSource = new EventSource('/api/events');
eventSource.addEventListener('open', () => {
  elements.connectionDot.classList.add('online');
  elements.connectionText.textContent = '已连接';
});
eventSource.addEventListener('error', () => {
  elements.connectionDot.classList.remove('online');
  elements.connectionText.textContent = '重连中';
});
eventSource.addEventListener('message', (event) => {
  try {
    handleEvent(JSON.parse(event.data));
  } catch (error) {
    console.error(error);
  }
});

fetch('/api/status')
  .then((response) => response.json())
  .then(setStatus)
  .catch((error) => showToast(error.message));
