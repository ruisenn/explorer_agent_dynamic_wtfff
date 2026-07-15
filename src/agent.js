const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const ACTIONS = new Set(['click', 'fill', 'select', 'wait', 'finish']);
const TARGET_KEYS = new Set(['testId', 'role', 'name', 'label', 'text', 'placeholder']);
const SYSTEM_PROMPT = `You are a browser interaction planner.
Return exactly one JSON object and no markdown.
Allowed actions:
{"type":"click","target":{"role":"button","name":"Continue"},"reason":"..."}
{"type":"fill","target":{"label":"Name"},"value":"Example","reason":"..."}
{"type":"select","target":{"label":"Priority"},"value":"high","reason":"..."}
{"type":"wait","value":500,"reason":"..."}
{"type":"finish","summary":"..."}
Targets may only use testId, role, name, label, text, or placeholder.
Prefer testId, role/name, and label. Never return CSS, XPath, JavaScript, file paths, credentials, or more than one action.
Use finish only after the visible page proves the task is complete.`;

class AgentRunner {
  constructor(options) {
    Object.assign(this, options);
    this.stopRequested = false;
    this.history = [];
    this.step = 0;
    this.state = 'queued';
    this.message = 'Queued';
    this.frameVersion = 0;
    fs.mkdirSync(this.runtimeDir, { recursive: true });
  }

  getStatus() {
    return {
      state: this.state,
      message: this.message,
      startUrl: this.startUrl,
      goal: this.goal,
      step: this.step,
      frameUrl: this.frameVersion ? `/runtime/frame.jpg?v=${this.frameVersion}` : null,
    };
  }

  stop() {
    this.stopRequested = true;
    this.state = 'stopping';
    this.message = 'Stopping after the current operation';
    this.emit({ type: 'state', status: this.getStatus() });
  }

  emit(event) {
    this.onEvent({ ...event, at: new Date().toISOString() });
  }

  async run() {
    let browser;

    try {
      this.state = 'running';
      this.message = 'Launching Playwright';
      this.emit({ type: 'state', status: this.getStatus() });

      browser = await chromium.launch(this.launchOptions());
      const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
      const page = await context.newPage();
      page.setDefaultTimeout(5000);
      page.setDefaultNavigationTimeout(15000);

      page.on('console', (entry) => {
        if (entry.type() === 'error') this.emit({ type: 'error', message: entry.text().slice(0, 300) });
      });
      page.on('pageerror', (error) => this.emit({ type: 'error', message: error.message.slice(0, 300) }));

      await page.goto(this.startUrl, { waitUntil: 'domcontentloaded' });
      await this.capture(page);

      for (this.step = 1; this.step <= 15; this.step += 1) {
        if (this.stopRequested) throw new Error('Stopped by operator');

        const observation = await this.observe(page);
        const action = this.validateAction(await this.plan(observation));
        this.emit({ type: 'plan', step: this.step, action: this.publicAction(action) });

        if (action.type === 'finish') {
          this.state = 'completed';
          this.message = action.summary || 'Task completed';
          this.emit({ type: 'state', status: this.getStatus() });
          break;
        }

        await this.execute(page, action);
        await this.capture(page);
        this.history.push({ step: this.step, action: this.publicAction(action) });
        this.emit({ type: 'action', step: this.step, status: 'succeeded', action: this.publicAction(action) });

        if (this.step === 15) throw new Error('Maximum action count reached');
      }

      await context.close();
    } catch (error) {
      this.state = this.stopRequested ? 'stopped' : 'failed';
      this.message = this.safeError(error);
      this.emit({ type: 'state', status: this.getStatus(), error: this.message });
    } finally {
      if (browser) await browser.close().catch(() => {});
    }
  }

  launchOptions() {
    const options = { headless: process.env.HEADLESS !== 'false' };
    if (process.env.PLAYWRIGHT_EXECUTABLE_PATH) {
      options.executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH;
    } else if (process.env.PLAYWRIGHT_CHANNEL) {
      options.channel = process.env.PLAYWRIGHT_CHANNEL;
    }
    return options;
  }

  async capture(page) {
    const filePath = path.join(this.runtimeDir, 'frame.jpg');
    await page.screenshot({ path: filePath, type: 'jpeg', quality: 72 });
    this.frameVersion = Date.now();
    this.emit({ type: 'frame', frameUrl: `/runtime/frame.jpg?v=${this.frameVersion}` });
  }

  async observe(page) {
    const visibleText = await page.locator('body').innerText().catch(() => '');
    const elements = await page
      .locator('button, input, select, textarea, a')
      .evaluateAll((nodes) =>
        nodes.slice(0, 100).map((node) => {
          const explicitLabel = node.id
            ? document.querySelector(`label[for="${CSS.escape(node.id)}"]`)
            : null;
          const wrappingLabel = node.closest('label');
          const type = node.getAttribute('type') || node.tagName.toLowerCase();
          const value = 'value' in node ? String(node.value || '') : '';
          const sensitive = ['password', 'email'].includes(type);
          return {
            tag: node.tagName.toLowerCase(),
            type,
            testId: node.getAttribute('data-testid') || undefined,
            role: node.getAttribute('role') || undefined,
            name:
              node.getAttribute('aria-label') ||
              explicitLabel?.textContent?.trim() ||
              wrappingLabel?.textContent?.trim() ||
              node.textContent?.trim().slice(0, 100) ||
              undefined,
            placeholder: node.getAttribute('placeholder') || undefined,
            value: sensitive && value ? '[REDACTED]' : value.slice(0, 120),
            hasValue: Boolean(value),
            disabled: 'disabled' in node ? Boolean(node.disabled) : false,
          };
        }),
      )
      .catch(() => []);

    const screenshot = this.useScreenshot
      ? await fs.promises.readFile(path.join(this.runtimeDir, 'frame.jpg'))
      : null;

    return {
      url: page.url(),
      title: await page.title().catch(() => ''),
      visibleText: visibleText.slice(0, 6000),
      elements,
      screenshotDataUrl: screenshot ? `data:image/jpeg;base64,${screenshot.toString('base64')}` : null,
    };
  }

  async plan(observation) {
    const apiBase = process.env.OPENAI_BASE_URL?.replace(/\/+$/, '');
    const apiKey = process.env.OPENAI_API_KEY;
    const model = process.env.OPENAI_MODEL;

    if (!apiBase || !apiKey || !model) {
      throw new Error('OPENAI_BASE_URL, OPENAI_API_KEY and OPENAI_MODEL are required');
    }

    const summary = JSON.stringify({
      goal: this.goal,
      page: {
        url: observation.url,
        title: observation.title,
        visibleText: observation.visibleText,
        elements: observation.elements,
      },
      recentActions: this.history.slice(-6),
    });
    const userContent = observation.screenshotDataUrl
      ? [
          { type: 'text', text: summary },
          { type: 'image_url', image_url: { url: observation.screenshotDataUrl } },
        ]
      : summary;

    const response = await fetch(`${apiBase}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'User-Agent': process.env.OPENAI_USER_AGENT || 'AgentBrowserDemo/1.0',
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userContent },
        ],
      }),
      signal: AbortSignal.timeout(Number(process.env.OPENAI_TIMEOUT_MS || 60000)),
    });

    const raw = await response.text();
    if (!response.ok) throw new Error(`Model API ${response.status}: ${raw.slice(0, 260)}`);

    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      throw new Error('Model API returned invalid JSON');
    }

    const content = payload?.choices?.[0]?.message?.content;
    const text = Array.isArray(content)
      ? content.map((part) => part.text || '').join('')
      : String(content || '');
    const match = text.match(/```(?:json)?\s*([\s\S]*?)```/i) || text.match(/(\{[\s\S]*\})/);
    if (!match) throw new Error('Model did not return a JSON action');

    try {
      return JSON.parse(match[1]);
    } catch {
      throw new Error('Model returned malformed action JSON');
    }
  }

  validateAction(action) {
    if (!action || typeof action !== 'object' || !ACTIONS.has(action.type)) {
      throw new Error('Unsupported model action');
    }

    if (action.target) {
      for (const [key, value] of Object.entries(action.target)) {
        if (!TARGET_KEYS.has(key) || typeof value !== 'string' || value.length > 200) {
          throw new Error(`Invalid target field: ${key}`);
        }
      }
    }

    if (['fill', 'select'].includes(action.type) && String(action.value || '').length > 500) {
      throw new Error('Action value is too long');
    }
    if (action.type === 'wait') {
      action.value = Math.min(Math.max(Number(action.value) || 250, 50), 2000);
    }
    return action;
  }

  locatorCandidates(page, target = {}) {
    const candidates = [];
    if (target.testId) candidates.push(page.getByTestId(target.testId));
    if (target.label) candidates.push(page.getByLabel(target.label, { exact: false }));
    if (target.role) {
      candidates.push(page.getByRole(target.role, target.name ? { name: target.name, exact: false } : {}));
    }
    if (target.placeholder) candidates.push(page.getByPlaceholder(target.placeholder, { exact: false }));
    if (target.text) candidates.push(page.getByText(target.text, { exact: false }));
    if (target.name && !target.role) candidates.push(page.getByText(target.name, { exact: false }));
    return candidates;
  }

  async resolveLocator(page, target) {
    for (const candidate of this.locatorCandidates(page, target)) {
      if ((await candidate.count().catch(() => 0)) > 0) return candidate.first();
    }
    throw new Error(`Target not found: ${JSON.stringify(target)}`);
  }

  async execute(page, action) {
    if (action.type === 'wait') {
      await page.waitForTimeout(action.value);
      return;
    }

    const locator = await this.resolveLocator(page, action.target);
    if (action.type === 'click') await locator.click();
    if (action.type === 'fill') await locator.fill(String(action.value || ''));
    if (action.type === 'select') await locator.selectOption(String(action.value || ''));
  }

  publicAction(action) {
    const result = {
      type: action.type,
      target: action.target,
      reason: action.reason,
      summary: action.summary,
    };
    if (action.type === 'wait') result.value = action.value;
    if (action.type === 'select') result.value = action.value;
    if (action.type === 'fill') result.value = '[INPUT REDACTED]';
    return Object.fromEntries(Object.entries(result).filter(([, value]) => value !== undefined));
  }

  safeError(error) {
    return String(error?.message || error || 'Unknown error')
      .replace(/\u001b\[[0-9;]*m/g, '')
      .replace(process.env.OPENAI_API_KEY || '__NO_KEY__', '[REDACTED]')
      .slice(0, 500);
  }
}

module.exports = { AgentRunner };
