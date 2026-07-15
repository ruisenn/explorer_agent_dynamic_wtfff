const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { AgentRunner } = require('./src/agent');

const host = '127.0.0.1';
const port = Number(process.env.PORT || 3100);
const publicDir = path.join(__dirname, 'public');
const runtimeDir = path.join(__dirname, 'runtime');
const clients = new Set();
let recentEvents = [];
let runner = null;
let lastStatus = { state: 'idle', message: 'Ready', step: 0, frameUrl: null };

fs.mkdirSync(runtimeDir, { recursive: true });

const staticFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/sandbox', ['sandbox.html', 'text/html; charset=utf-8']],
  ['/sandbox.js', ['sandbox.js', 'text/javascript; charset=utf-8']],
]);

function sendJson(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

function sendFile(res, baseDir, fileName, contentType, noStore = false) {
  const filePath = path.join(baseDir, fileName);
  fs.readFile(filePath, (error, content) => {
    if (error) {
      sendJson(res, 404, { error: 'Not found' });
      return;
    }
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': noStore ? 'no-store' : 'public, max-age=60',
    });
    res.end(content);
  });
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 32 * 1024) throw new Error('Request body is too large');
    chunks.push(chunk);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

function broadcast(event) {
  const enriched = { ...event, id: Date.now() + Math.random() };
  if (event.type !== 'frame') {
    recentEvents.push(enriched);
    recentEvents = recentEvents.slice(-100);
  }
  const line = `data: ${JSON.stringify(enriched)}\n\n`;
  for (const client of clients) client.write(line);
}

function currentStatus() {
  return runner ? runner.getStatus() : lastStatus;
}

function isActive() {
  return runner && ['queued', 'running', 'stopping'].includes(runner.getStatus().state);
}

function startRun({ startUrl, goal, useScreenshot }) {
  if (isActive()) return { ok: false, error: 'An Agent run is already active' };
  if (!goal || typeof goal !== 'string') return { ok: false, error: 'Goal is required' };

  let parsedUrl;
  try {
    parsedUrl = new URL(startUrl);
  } catch {
    return { ok: false, error: 'Start URL is invalid' };
  }
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    return { ok: false, error: 'Only HTTP and HTTPS URLs are allowed' };
  }

  recentEvents = [];
  runner = new AgentRunner({
    startUrl: parsedUrl.href,
    goal: goal.trim().slice(0, 1000),
    useScreenshot: useScreenshot !== false,
    runtimeDir,
    onEvent: broadcast,
  });
  runner.run().finally(() => {
    lastStatus = runner.getStatus();
    runner = null;
  });
  return { ok: true };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${host}:${port}`);

  try {
    if (req.method === 'GET' && staticFiles.has(url.pathname)) {
      const [fileName, contentType] = staticFiles.get(url.pathname);
      sendFile(res, publicDir, fileName, contentType);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/runtime/frame.jpg') {
      sendFile(res, runtimeDir, 'frame.jpg', 'image/jpeg', true);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/health') {
      sendJson(res, 200, {
        ok: true,
        agentConfigured: Boolean(
          process.env.OPENAI_BASE_URL && process.env.OPENAI_API_KEY && process.env.OPENAI_MODEL,
        ),
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/status') {
      sendJson(res, 200, currentStatus());
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      for (const event of recentEvents) res.write(`data: ${JSON.stringify(event)}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'snapshot', status: currentStatus() })}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/run') {
      const body = await readJson(req);
      const result = startRun(body);
      sendJson(res, result.ok ? 202 : 400, result);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/stop') {
      if (!isActive()) {
        sendJson(res, 400, { ok: false, error: 'There is no active run' });
        return;
      }
      runner.stop();
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }

    sendJson(res, 404, { error: 'Not found' });
  } catch (error) {
    sendJson(res, 400, { error: error.message || 'Request failed' });
  }
});

server.listen(port, host, () => {
  console.log(`Agent Playwright Demo: http://${host}:${port}`);
});

function shutdown() {
  if (runner) runner.stop();
  for (const client of clients) client.end();
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
