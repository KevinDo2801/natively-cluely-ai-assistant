import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { buildAutoApprovalResponse } from './codexPluginAutoApproval.mjs';
import { buildMediaBlock, collectMediaFromNotification, recoverAgentMessageText } from './codexNotificationMedia.mjs';

// Developer instructions handed to the managed App Server thread. Both variants
// keep the same hard bans (no shell, no local files, no delegation); they differ
// only in whether an app connector may be used WITHOUT the user naming it.
// The permissive variant is paired with the auto-approval path: it is only used
// when the user opted into "approve plugin actions automatically", so nobody is
// silently granted connector writes they did not ask for.
const CODEX_DEVELOPER_INSTRUCTIONS_BASE =
  'Ask only for details required by the connector. Once the required details are known, call the connector directly. '
  // Live capture 2026-10: a Canva turn produced an image item and the model
  // answered "Đã vẽ chú chó hình vuông như trên" while the chat showed nothing —
  // the chat only displays what the model WRITES, and connector artifacts used to
  // be dropped. Requiring the URL in the reply is the cheap half of the fix (the
  // other half appends any URL the connector returned, see codexNotificationMedia).
  + 'When a connector produces something the user must SEE or OPEN (an image, a design, a file, a page), '
  + 'always include its full https URL in your reply — as a markdown image for media, as a markdown link otherwise. '
  // Live 2026-10: with only the "as above" ban, the model invented a UI instead —
  // "Canva đã mở phần tạo thiết kế ngay trong cuộc trò chuyện. Hãy chọn phong cách
  // trong khung Canva" — describing a panel that does not exist, so the user was
  // told to click something they could not see. Nothing renders inside the chat
  // except what Natively draws itself, so claiming a connector UI is open there is
  // always false.
  + 'Never claim that a panel, editor, frame, widget, preview, or connector UI has opened in this chat: '
  + 'no connector interface is ever rendered inside the conversation. If a connector produced an artifact, give its URL; '
  + 'if it produced nothing you can link, say that plainly instead of describing a screen the user cannot see. '
  + 'Never say "shown above", "as above" or "the attached file": the chat only displays what you write. '
  + 'Do not claim to have sent, saved, or uploaded anything unless a connector confirmed it in this turn. '
  + 'Do not claim that a browser is unavailable when an app connector is selected. '
  + 'Do not call shell tools, run commands, read local files, or delegate work.';
const CODEX_DEVELOPER_INSTRUCTIONS_EXPLICIT_APP =
  'You are the text response provider inside Natively. You may call an enabled app connector only when the user explicitly mentions that app. '
  + 'Do not ask for an extra prose confirmation because Natively shows the connector approval UI. '
  + CODEX_DEVELOPER_INSTRUCTIONS_BASE;
const CODEX_DEVELOPER_INSTRUCTIONS_AUTO_APPROVED_APP =
  'You are the text response provider inside Natively. You may call any enabled app connector that matches the user\'s request, even when the user does not name it; '
  + 'when several connectors could fit, pick the one whose name, description, or capabilities match the request best. '
  + 'Natively approves connector actions automatically, so never ask the user for permission or a prose confirmation — perform the action and report the result. '
  + CODEX_DEVELOPER_INSTRUCTIONS_BASE;

/**
 * How long a plugin interaction may wait for a decision, and the floor for a
 * connector turn's total silence budget. One number for both so the renderer's
 * card timer and the App Server's idle timer cannot disagree about how long the
 * user has to answer.
 */
const PLUGIN_INTERACTION_TIMEOUT_MS = 5 * 60_000;

/**
 * NATIVELY_CODEX_DEBUG_NOTIFICATIONS=1 logs every raw App Server notification
 * (method + truncated params). Off by default: it is verbose, and it exists so a
 * connector turn can be diagnosed from `natively_debug.log` alone — which item
 * methods the App Server emits and where an artifact URL lives — instead of
 * guessing at the schema.
 */
const DEBUG_NOTIFICATIONS = process.env.NATIVELY_CODEX_DEBUG_NOTIFICATIONS === '1';

export interface CodexModelInfo {
  id: string;
  name: string;
  isDefault: boolean;
  efforts: string[];
  defaultEffort?: string;
}

export interface CodexAppInfo {
  id: string;
  name: string;
  description?: string;
  logoUrl?: string;
  installUrl?: string;
  isAccessible: boolean;
  isEnabled: boolean;
  callable: boolean;
  canToggle?: boolean;
  marketplaceName?: string;
  pluginName?: string;
  pluginDisplayNames: string[];
}

export interface CodexPluginInteractionRequest {
  requestId: string;
  kind: 'user_input' | 'elicitation';
  app?: { id: string; name: string };
  message?: string;
  serverName?: string;
  mode?: string;
  url?: string;
  questions?: Array<{
    id: string;
    header: string;
    question: string;
    isOther: boolean;
    isSecret: boolean;
    options?: Array<{ label: string; description: string }>;
  }>;
  requestedSchema?: unknown;
}

export interface CodexPluginInteractionResponse {
  action: 'accept' | 'decline' | 'cancel';
  values?: Record<string, unknown>;
}

/** The official client owns credentials; Natively never reads or copies its tokens. */
export class CodexAppServerService extends EventEmitter {
  private static instance: CodexAppServerService;
  static getInstance(): CodexAppServerService {
    return this.instance ??= new CodexAppServerService();
  }
  private child?: ChildProcessWithoutNullStreams;
  private starting?: Promise<void>;
  private sequence = 0;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private status = { signedIn: false, email: undefined as string | undefined };
  private models?: CodexModelInfo[];
  private apps?: CodexAppInfo[];
  private appsLoading?: Promise<CodexAppInfo[]>;
  private appsCatalogLimited = false;
  private appsCatalogSource: 'app-directory' | 'plugin-marketplace' | 'installed-only' = 'app-directory';
  private executable = 'codex';
  private loginId?: string;
  private interactionSequence = 0;
  private pluginInteractions = new Map<string, {
    rpcId: string | number;
    method: 'item/tool/requestUserInput' | 'mcpServer/elicitation/request';
    params: any;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private threadApps = new Map<string, { id: string; name: string }>();
  /**
   * Settings → Plugins → "Approve plugin actions automatically". OFF at the
   * service level (safe default for any direct construction, e.g. tests or a
   * background recovery instance); the app turns it on from the persisted
   * setting at IPC wiring time. When ON, confirm-only plugin interactions are
   * answered here instead of waiting for a click, and connector turns may be
   * started even when the user did not name the plugin.
   */
  private autoApprovePlugins = false;

  getStatus() { return { ...this.status }; }
  getAutoApprovePlugins() { return this.autoApprovePlugins; }
  setAutoApprovePlugins(enabled: boolean) { this.autoApprovePlugins = enabled === true; }
  /**
   * True while a plugin interaction (approval / elicitation) is waiting for an
   * answer. The live-deadline guard holds a turn's first-useful budget while this
   * is true: a card the user has not clicked yet is not a stalled provider, and
   * letting the guard fire would abort the turn AND cancel the very interaction
   * the user was about to approve.
   */
  hasPendingInteraction(threadId?: string): boolean {
    if (this.pluginInteractions.size === 0) return false;
    if (!threadId) return true;
    for (const pending of this.pluginInteractions.values()) {
      if (String(pending.params?.threadId || '') === threadId) return true;
    }
    return false;
  }
  getAppsCatalogStatus() { return { limited: this.appsCatalogLimited, source: this.appsCatalogSource }; }
  adoptAppsCatalog(apps: CodexAppInfo[]) {
    this.apps = apps.map(app => ({ ...app, pluginDisplayNames: [...app.pluginDisplayNames] }));
    this.appsCatalogLimited = false;
    this.appsCatalogSource = 'app-directory';
  }

  private static normalizeAppName(value: unknown): string {
    return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  }

  static resolveExecutable(configured = 'codex'): string {
    if (configured !== 'codex') {
      if (path.isAbsolute(configured) && fs.existsSync(configured) && !/\.(cmd|bat|ps1)$/i.test(configured)) return configured;
      throw new Error('Choose the Codex executable, not a shell script, in Settings → AI Providers.');
    }
    if (process.platform !== 'win32') return 'codex';
    const desktop = path.join(process.env.LOCALAPPDATA || '', 'OpenAI', 'Codex', 'bin');
    if (fs.existsSync(desktop)) {
      const candidates = fs.readdirSync(desktop).map(dir => path.join(desktop, dir, 'codex.exe')).filter(file => fs.existsSync(file));
      candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
      if (candidates[0]) return candidates[0];
    }
    const npm = path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@openai');
    for (const root of [path.join(npm, 'codex-win32-x64'), path.join(npm, 'codex', 'node_modules', '@openai', 'codex-win32-x64')]) {
      const file = path.join(root, 'vendor', 'x86_64-pc-windows-msvc', 'codex', 'codex.exe');
      if (fs.existsSync(file)) return file;
    }
    for (const dir of (process.env.PATH || '').split(path.delimiter)) {
      const file = path.join(dir, 'codex.exe');
      if (fs.existsSync(file)) return file;
    }
    throw new Error('Codex CLI was not found. Install Codex, then reconnect in Settings → AI Providers.');
  }

  static buildSpawnEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    const environment = { ...source };
    for (const key of Object.keys(environment)) {
      const inheritedCodexHostState = key.startsWith('CODEX_') && key !== 'CODEX_HOME';
      if (inheritedCodexHostState
        || key.startsWith('ELECTRON_')
        || key === 'NODE_ENV'
        || key === 'NODE_OPTIONS'
        || key.startsWith('NODE_REPL_')) {
        delete environment[key];
      }
    }
    return environment;
  }

  async connect(configured = 'codex'): Promise<void> {
    if (this.starting) return this.starting;
    if (this.child && this.executable === configured) return;
    if (this.child) this.close();
    this.executable = configured;
    this.starting = this.start().finally(() => { this.starting = undefined; });
    return this.starting;
  }

  private async start() {
    const executable = CodexAppServerService.resolveExecutable(this.executable);
    // This provider answers chat prompts. Disable agent execution/integrations;
    // use an empty directory so repository instructions cannot contaminate chat.
    const cwd = path.join(os.tmpdir(), 'natively-codex-chat');
    fs.mkdirSync(cwd, { recursive: true });
    const args = ['app-server', '--stdio', '-c', 'mcp_servers={}', '-c', 'web_search="disabled"',
      '-c', 'features.shell_tool=false', '-c', 'features.unified_exec=false',
      '-c', 'features.apps=true', '-c', 'features.multi_agent=false',
      '-c', 'features.code_mode=false', '-c', 'project_doc_max_bytes=0'];
    const child = spawn(executable, args, {
      cwd,
      env: CodexAppServerService.buildSpawnEnvironment(),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 16 * 1024 * 1024) { this.fail(new Error('Codex sent an oversized protocol message.')); child.kill(); return; }
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        try { this.receive(JSON.parse(line)); } catch { /* stdout may contain startup notices */ }
      }
    });
    // Drain stderr, but never forward prompts or authentication data to app logs.
    child.stderr.on('data', () => {});
    child.on('error', error => this.fail(new Error(`Could not start Codex: ${error.message}`)));
    child.on('exit', () => {
      if (this.child === child) { this.child = undefined; this.models = undefined; this.apps = undefined; this.appsCatalogLimited = false; this.appsCatalogSource = 'app-directory'; this.fail(new Error('Codex disconnected. Please retry.')); }
    });
    try {
      await this.request('initialize', { clientInfo: { name: 'natively', version: '1.0.0' }, capabilities: { experimentalApi: true } });
      this.send({ method: 'initialized', params: {} });
      await this.readAccount(false);
    } catch (error) { this.close(); throw error; }
  }

  private send(message: unknown) {
    if (!this.child?.stdin.writable) throw new Error('Codex is not connected.');
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }
  request(method: string, params: unknown, timeout = 30_000): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex ${method} timed out.`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); } catch (error) {
        clearTimeout(timer); this.pending.delete(id); reject(error);
      }
    });
  }
  private receive(message: any) {
    if (message.id !== undefined && !message.method) {
      const waiting = this.pending.get(message.id);
      if (waiting) {
        this.pending.delete(message.id); clearTimeout(waiting.timer);
        if (message.error) waiting.reject(new Error(message.error.message || 'Codex request failed.'));
        else waiting.resolve(message.result);
      }
      return;
    }
    if (message.id !== undefined) {
      const appApproval = message.method === 'item/tool/requestUserInput'
        || message.method === 'mcpServer/elicitation/request';
      if (appApproval) {
        const requestId = `plugin-interaction-${++this.interactionSequence}`;
        const params = message.params || {};
        const app = this.threadApps.get(String(params.threadId || ''));
        const request: CodexPluginInteractionRequest = message.method === 'item/tool/requestUserInput'
          ? {
              requestId,
              kind: 'user_input',
              app,
              questions: Array.isArray(params.questions)
                ? params.questions.map((question: any) => ({
                    id: String(question?.id || ''),
                    header: String(question?.header || 'Confirmation'),
                    question: String(question?.question || 'Continue with this plugin action?'),
                    isOther: question?.isOther === true,
                    isSecret: question?.isSecret === true,
                    options: Array.isArray(question?.options)
                      ? question.options.map((option: any) => ({
                          label: String(option?.label || ''),
                          description: String(option?.description || ''),
                        })).filter((option: { label: string }) => option.label.length > 0)
                      : undefined,
                  })).filter((question: { id: string }) => question.id.length > 0)
                : [],
            }
          : {
              requestId,
              kind: 'elicitation',
              app,
              message: String(params.message || 'Continue with this plugin action?'),
              serverName: typeof params.serverName === 'string' ? params.serverName : undefined,
              mode: typeof params.mode === 'string' ? params.mode : undefined,
              url: typeof params.url === 'string' && /^https:\/\//i.test(params.url) ? params.url : undefined,
              requestedSchema: params.requestedSchema,
            };
        // Reset the active stream's idle deadline. The JSON-RPC request stays
        // pending until it is answered — by the auto-approval policy below or by
        // the user through the renderer card.
        this.emit('notification', message);
        if (this.autoApprovePlugins) {
          // Only confirm-only interactions are answered here; anything that
          // needs user data returns null and still reaches the card below.
          const auto = buildAutoApprovalResponse(request);
          if (auto) {
            this.sendInteractionResult(
              { rpcId: message.id, method: message.method, params },
              { action: auto.action, values: auto.values },
            );
            this.emit('plugin-interaction-closed', requestId);
            return;
          }
        }
        const timer = setTimeout(() => {
          void this.resolvePluginInteraction(requestId, { action: 'cancel' }).catch(() => {});
        }, PLUGIN_INTERACTION_TIMEOUT_MS);
        this.pluginInteractions.set(requestId, {
          rpcId: message.id,
          method: message.method,
          params,
          timer,
        });
        // Surface the interaction to the renderer.
        this.emit('plugin-interaction', request);
        return;
      }
      this.send({
        id: message.id,
        error: {
          code: -32601,
          message: 'Agent tools and non-plugin approvals are not available in Natively chat.',
        },
      });
      return;
    }
    if (message.method === 'account/login/completed') {
      const p = message.params;
      if (p.success) void this.readAccount(false).then(status => this.emit('login:complete', status)).catch(error => this.emit('login:failed', error));
      else this.emit('login:failed', new Error(p.error || 'Codex sign-in failed.'));
      this.loginId = undefined;
    }
    if (message.method === 'account/updated') {
      this.models = undefined;
      this.apps = undefined;
      this.appsCatalogLimited = false;
      this.appsCatalogSource = 'app-directory';
      void this.readAccount(false).catch(() => {});
    }
    // `app/list` already waits for both the accessible and directory sources.
    // App Server emits `app/list/updated` while that request is in flight; if
    // we broadcast it as an invalidation, every overlay renderer immediately
    // starts another catalog request and can create a self-sustaining refresh
    // storm. OAuth completion is a real external state change and still needs
    // a reload.
    if (message.method === 'mcpServer/oauthLogin/completed') {
      this.apps = undefined;
      this.appsCatalogLimited = false;
      this.appsCatalogSource = 'app-directory';
      this.emit('apps:changed');
    }
    this.emit('notification', message);
  }
  private fail(error: Error) {
    for (const waiting of this.pending.values()) { clearTimeout(waiting.timer); waiting.reject(error); }
    this.pending.clear();
    for (const [requestId, interaction] of this.pluginInteractions) {
      clearTimeout(interaction.timer);
      this.emit('plugin-interaction-closed', requestId);
    }
    this.pluginInteractions.clear();
    this.threadApps.clear();
    this.emit('disconnected', error);
  }
  close() {
    const child = this.child; this.child = undefined; this.models = undefined; this.apps = undefined; this.appsCatalogLimited = false; this.appsCatalogSource = 'app-directory';
    this.fail(new Error('Codex connection closed.'));
    child?.stdin.end(); child?.kill();
  }
  private async readAccount(refreshToken: boolean) {
    const result = await this.request('account/read', { refreshToken });
    this.status = { signedIn: result.account?.type === 'chatgpt', email: result.account?.email };
    return this.getStatus();
  }
  async refresh(configured = 'codex') { await this.connect(configured); this.models = undefined; return this.readAccount(true); }
  async startLogin() {
    await this.connect(this.executable);
    if (this.loginId) await this.request('account/login/cancel', { loginId: this.loginId }).catch(() => {});
    const result = await this.request('account/login/start', { type: 'chatgpt' });
    this.loginId = result.loginId;
    return result as { authUrl: string; loginId: string };
  }
  async signOut() { await this.connect(this.executable); await this.request('account/logout', {}); this.status = { signedIn: false, email: undefined }; this.models = undefined; this.apps = undefined; this.appsCatalogLimited = false; this.appsCatalogSource = 'app-directory'; this.emit('signed-out'); }
  async listModels(configured = 'codex', force = false): Promise<CodexModelInfo[]> {
    await this.connect(configured);
    if (!this.status.signedIn) throw new Error('Sign in with ChatGPT in Settings → AI Providers.');
    if (this.models && !force) return this.models;
    const models: CodexModelInfo[] = [];
    let cursor: string | null = null;
    do {
      const result = await this.request('model/list', { limit: 100, includeHidden: false, cursor });
      for (const model of result.data || []) models.push({ id: model.model, name: model.displayName || model.model, isDefault: !!model.isDefault, efforts: (model.supportedReasoningEfforts || []).map((e: any) => e.reasoningEffort), defaultEffort: model.defaultReasoningEffort });
      cursor = result.nextCursor;
    } while (cursor);
    this.models = models;
    return models;
  }

  /**
   * Send the renderer's (or the auto-approval policy's) decision back over
   * JSON-RPC. Shapes are per method: requestUserInput answers each question id,
   * elicitation carries an accept/decline/cancel action with optional content.
   */
  private sendInteractionResult(
    pending: { rpcId: string | number; method: 'item/tool/requestUserInput' | 'mcpServer/elicitation/request'; params: any },
    response: CodexPluginInteractionResponse,
  ): void {
    if (pending.method === 'item/tool/requestUserInput') {
      const answers: Record<string, { answers: string[] }> = {};
      if (response.action === 'accept') {
        for (const question of Array.isArray(pending.params?.questions) ? pending.params.questions : []) {
          const id = String(question?.id || '');
          if (!id) continue;
          const value = response.values?.[id];
          const values = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
          answers[id] = { answers: values.map(item => String(item)) };
        }
      }
      this.send({ id: pending.rpcId, result: { answers } });
      return;
    }

    this.send({
      id: pending.rpcId,
      result: {
        action: response.action,
        content: response.action === 'accept' ? (response.values || {}) : null,
        _meta: null,
      },
    });
  }

  async resolvePluginInteraction(
    requestId: string,
    response: CodexPluginInteractionResponse,
  ): Promise<void> {
    const pending = this.pluginInteractions.get(requestId);
    if (!pending) throw new Error('This plugin confirmation is no longer active.');
    this.pluginInteractions.delete(requestId);
    clearTimeout(pending.timer);

    try {
      this.sendInteractionResult(pending, response);
    } finally {
      this.emit('plugin-interaction-closed', requestId);
    }
  }

  private cancelPluginInteractionsForThread(threadId: string) {
    for (const [requestId, pending] of this.pluginInteractions) {
      if (String(pending.params?.threadId || '') !== threadId) continue;
      void this.resolvePluginInteraction(requestId, { action: 'cancel' }).catch(() => {});
    }
  }

  async listApps(configured = 'codex', force = false): Promise<CodexAppInfo[]> {
    // Overlay, Settings, and auxiliary renderer windows often mount together.
    // Share one App Server directory request so they do not simultaneously
    // hit ChatGPT with several multi-thousand-item catalog fetches.
    if (this.appsLoading) return this.appsLoading;
    const loading = this.loadApps(configured, force).finally(() => {
      if (this.appsLoading === loading) this.appsLoading = undefined;
    });
    this.appsLoading = loading;
    return loading;
  }

  private async loadApps(configured: string, force: boolean): Promise<CodexAppInfo[]> {
    await this.connect(configured);
    if (!this.status.signedIn) throw new Error('Sign in with ChatGPT in Settings → AI Providers.');
    if (this.apps && !force) return this.apps;

    // `app/list.forceRefetch=true` bypasses Codex's local directory cache and
    // may hit ChatGPT's Cloudflare browser challenge, which rejects the
    // headless App Server request with an HTML 403 response. Once a catalog is
    // loaded, Refresh only needs the cheap installed/callable state update.
    if (this.apps && force && !this.appsCatalogLimited) {
      const installedResult = await this.request('app/installed', { forceRefresh: true }, 60_000);
      const installed = new Map<string, any>(
        (Array.isArray(installedResult?.apps) ? installedResult.apps : []).map((app: any) => [app.id, app]),
      );
      this.apps = this.apps.map(app => {
        const runtime = installed.get(app.id);
        return runtime
          ? { ...app, isEnabled: runtime.enabled !== false, callable: runtime.callable === true }
          : app;
      });
      return this.apps;
    }

    const catalog: any[] = [];
    let cursor: string | null = null;
    const seenCursors = new Set<string>();
    do {
      let result: any;
      try {
        result = await this.request('app/list', {
          cursor,
          // The account directory contains several thousand apps. App Server
          // accepts this size and returns it in one request; batches of 100
          // triggered Cloudflare after dozens of consecutive requests.
          limit: 5_000,
          // Always use Codex's authenticated directory cache. A forced fetch
          // can be redirected to an interactive Cloudflare challenge.
          forceRefetch: false,
        }, 30_000);
      } catch (error: any) {
        const message = String(error?.message || error || 'Unknown error');
        if (/403 Forbidden|failed to list apps|<html[\s>]/i.test(message)) {
          const installedResult = await this.request('app/installed', { forceRefresh: false }, 30_000);
          const fallbackApps = (Array.isArray(installedResult?.apps) ? installedResult.apps : [])
            .map((app: any): CodexAppInfo => ({
              id: String(app.id || ''),
              name: String(app.runtimeName || app.id || 'Connected plugin'),
              description: 'Connected through Codex. The full plugin directory is temporarily unavailable.',
              isAccessible: true,
              isEnabled: app.enabled !== false,
              callable: app.callable === true,
              canToggle: true,
              pluginDisplayNames: [],
            }))
            .filter((app: CodexAppInfo) => app.id.length > 0);
          const marketplaceApps = await this.loadPluginMarketplaceApps(fallbackApps).catch(() => []);
          if (marketplaceApps.length > fallbackApps.length) {
            this.apps = marketplaceApps;
            this.appsCatalogLimited = false;
            this.appsCatalogSource = 'plugin-marketplace';
            return marketplaceApps;
          }
          this.apps = fallbackApps;
          this.appsCatalogLimited = true;
          this.appsCatalogSource = 'installed-only';
          return fallbackApps;
        }
        throw error;
      }
      catalog.push(...(Array.isArray(result?.data) ? result.data : []));
      const nextCursor = result?.nextCursor ?? null;
      if (nextCursor && seenCursors.has(nextCursor)) {
        throw new Error('Codex returned a repeated plugin catalog cursor. Please refresh again.');
      }
      if (nextCursor) seenCursors.add(nextCursor);
      cursor = nextCursor;
    } while (cursor);

    const installedResult = await this.request('app/installed', { forceRefresh: force }, force ? 60_000 : 30_000);
    const installed = new Map<string, any>(
      (Array.isArray(installedResult?.apps) ? installedResult.apps : []).map((app: any) => [app.id, app]),
    );

    const apps = catalog.map((app: any) => {
      const runtime = installed.get(app.id);
      return {
        id: String(app.id || ''),
        name: String(app.name || app.id || 'Plugin'),
        description: typeof app.description === 'string' ? app.description : undefined,
        logoUrl: typeof app.logoUrl === 'string' ? app.logoUrl : undefined,
        installUrl: typeof app.installUrl === 'string' ? app.installUrl : undefined,
        isAccessible: app.isAccessible === true,
        isEnabled: runtime ? runtime.enabled !== false : app.isEnabled === true,
        callable: runtime?.callable === true,
        canToggle: !!runtime,
        pluginDisplayNames: Array.isArray(app.pluginDisplayNames)
          ? app.pluginDisplayNames.filter((name: unknown): name is string => typeof name === 'string')
          : [],
      };
    }).filter((app: CodexAppInfo) => app.id.length > 0);
    this.apps = apps;
    this.appsCatalogLimited = false;
    this.appsCatalogSource = 'app-directory';
    return apps;
  }

  private async loadPluginMarketplaceApps(installedApps: CodexAppInfo[]): Promise<CodexAppInfo[]> {
    const result = await this.request('plugin/list', {}, 30_000);
    const marketplaces = Array.isArray(result?.marketplaces) ? result.marketplaces : [];
    const runtimeByName = new Map<string, CodexAppInfo>();
    for (const app of installedApps) {
      runtimeByName.set(CodexAppServerService.normalizeAppName(app.name), app);
    }

    const matchedRuntimeIds = new Set<string>();
    const catalog: CodexAppInfo[] = [];
    for (const marketplace of marketplaces) {
      const marketplaceName = typeof marketplace?.name === 'string' ? marketplace.name : '';
      const plugins = Array.isArray(marketplace?.plugins) ? marketplace.plugins : [];
      for (const plugin of plugins) {
        if (plugin?.source?.type !== 'remote') continue;
        const pluginName = typeof plugin?.name === 'string' ? plugin.name : '';
        const name = String(plugin?.interface?.displayName || pluginName || 'Plugin');
        if (!pluginName || !marketplaceName) continue;
        const runtime = plugin.installed === true
          ? runtimeByName.get(CodexAppServerService.normalizeAppName(name))
            || runtimeByName.get(CodexAppServerService.normalizeAppName(pluginName))
          : undefined;
        if (runtime) matchedRuntimeIds.add(runtime.id);
        catalog.push({
          id: runtime?.id || pluginName,
          name,
          description: typeof plugin?.interface?.shortDescription === 'string'
            ? plugin.interface.shortDescription
            : typeof plugin?.interface?.longDescription === 'string'
              ? plugin.interface.longDescription
              : undefined,
          logoUrl: typeof plugin?.interface?.logoUrl === 'string' ? plugin.interface.logoUrl : undefined,
          isAccessible: plugin?.availability === 'AVAILABLE' && plugin?.installPolicy !== 'BLOCKED',
          isEnabled: runtime ? runtime.isEnabled : plugin?.enabled === true,
          callable: runtime?.callable === true,
          canToggle: !!runtime,
          marketplaceName,
          pluginName,
          pluginDisplayNames: [],
        });
      }
    }

    for (const runtime of installedApps) {
      if (!matchedRuntimeIds.has(runtime.id)) catalog.push(runtime);
    }
    return catalog;
  }

  async getAppConnectionUrl(app: CodexAppInfo, configured = 'codex'): Promise<string | undefined> {
    await this.connect(configured);
    if (app.installUrl) return app.installUrl;
    if (!app.marketplaceName || !app.pluginName) return undefined;
    const result = await this.request('plugin/read', {
      remoteMarketplaceName: app.marketplaceName,
      pluginName: app.pluginName,
    }, 30_000);
    const plugin = result?.plugin;
    const firstInstallUrl = (Array.isArray(plugin?.apps) ? plugin.apps : [])
      .map((candidate: any) => candidate?.installUrl)
      .find((url: unknown): url is string => typeof url === 'string' && url.length > 0);
    return firstInstallUrl || (typeof plugin?.shareUrl === 'string' ? plugin.shareUrl : undefined);
  }

  async setAppEnabled(id: string, enabled: boolean, configured = 'codex'): Promise<void> {
    const appId = id.trim();
    if (!/^[A-Za-z0-9_-]+$/.test(appId)) throw new Error('Invalid plugin id.');
    await this.connect(configured);
    if (!this.status.signedIn) throw new Error('Sign in with ChatGPT in Settings → AI Providers.');
    await this.request('config/value/write', {
      keyPath: `apps.${appId}.enabled`,
      value: enabled,
      mergeStrategy: 'upsert',
    });
    if (this.apps) {
      this.apps = this.apps.map(app => app.id === appId ? { ...app, isEnabled: enabled } : app);
    }
    await this.request('app/installed', { forceRefresh: true }, 60_000).catch(() => {});
    this.emit('apps:changed');
  }

  private async resolveAppMention(
    prompt: string,
    configured: string,
    selectedApp?: { id: string; name: string },
  ): Promise<{
    text: string;
    mention?: { type: 'mention'; name: string; path: string };
  }> {
    const match = selectedApp ? null : prompt.match(/^@([A-Za-z0-9_-]+)(?:\s+([\s\S]*))?$/);
    if (!selectedApp && !match) return { text: prompt };
    const requestedId = String(selectedApp?.id || match?.[1] || '').toLowerCase();
    const app = (await this.listApps(configured)).find(candidate => candidate.id.toLowerCase() === requestedId);
    if (!app) throw new Error(`Plugin "${selectedApp?.name || match?.[1] || requestedId}" was not found. Open Settings → Plugins and refresh the catalog.`);
    if (!app.callable) throw new Error(`Plugin "${app.name}" is not connected. Open Settings → Plugins to connect it.`);
    const query = selectedApp ? prompt.trim() : (match?.[2] || '').trim();
    return {
      text: `$${app.id}${query ? ` ${query}` : ''}`,
      mention: { type: 'mention', name: app.name, path: `app://${app.id}` },
    };
  }

  async *stream(options: { model: string; prompt: string; instructions?: string; images: string[]; timeoutMs: number; signal?: AbortSignal; effort?: string; serviceTier?: string; app?: { id: string; name: string } }, configured = 'codex'): AsyncGenerator<string> {
    if (options.signal?.aborted) throw new Error('Codex request aborted.');
    const models = await this.listModels(configured);
    const model = models.find(m => m.id === options.model);
    if (!model) throw new Error(`Model ${options.model} is unavailable in Codex. Choose a model in Settings → AI Providers.`);
    const cwd = path.join(os.tmpdir(), 'natively-codex-chat');
    const appInput = await this.resolveAppMention(options.prompt, configured, options.app);
    const activeApp = options.app || (appInput.mention
      ? { id: appInput.mention.path.slice('app://'.length), name: appInput.mention.name }
      : undefined);
    if (activeApp) console.log(`[CodexAppServer] Routing turn to connected plugin: ${activeApp.name}`);
    // Connector activity needs `on-request` so the App Server may PAUSE and ask
    // Natively instead of refusing the action outright (with `never` a connector
    // write fails and the model can only report that approvals are disabled).
    // Enabled when the turn is bound to an app (the user named or picked one) or
    // when the user turned on auto-approval — in that mode the model is also
    // allowed to reach a matching connector the user did not name.
    // Non-app approval requests are still rejected by receive(), so this never
    // opens shell/file permissions.
    const connectorTurnsAllowed = Boolean(activeApp) || this.autoApprovePlugins;
    const approvalPolicy = connectorTurnsAllowed ? 'on-request' : 'never';
    const approvalsReviewer = connectorTurnsAllowed ? 'user' : undefined;
    const developerInstructions = this.autoApprovePlugins
      ? CODEX_DEVELOPER_INSTRUCTIONS_AUTO_APPROVED_APP
      : CODEX_DEVELOPER_INSTRUCTIONS_EXPLICIT_APP;
    const created = await this.request('thread/start', { model: model.id, cwd, ephemeral: true, sandbox: 'read-only', approvalPolicy, approvalsReviewer,
      environments: [], selectedCapabilityRoots: [], dynamicTools: [],
      baseInstructions: options.instructions || 'Answer the user directly.',
      developerInstructions,
      config: { project_doc_max_bytes: 0, web_search: 'disabled', mcp_servers: {} },
    });
    const threadId = created.thread.id;
    if (activeApp) this.threadApps.set(threadId, activeApp);
    let turnId: string | undefined;
    // `chunks` is a delivery queue and is continuously drained by the async
    // generator below. Keep the full streamed transcript separately so an
    // item/completed snapshot cannot be mistaken for text that never arrived.
    const chunks: string[] = [];
    let streamedText = '';
    let done = false;
    let failure: Error | undefined;
    let wake: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (error?: Error) => { failure = error; done = true; wake?.(); };
    // Connector turns are slow by nature: the App Server emits nothing while a
    // tool runs, and a write that needs a decision waits on the user's card. The
    // configured chat budget (codexCliTimeoutMs, 60s default) would fail a
    // healthy turn, so a connector turn gets at least the interaction budget —
    // the same wall-clock promise the renderer's card timer makes.
    const turnTimeoutMs = connectorTurnsAllowed
      ? Math.max(options.timeoutMs, PLUGIN_INTERACTION_TIMEOUT_MS)
      : options.timeoutMs;
    const resetTimer = (delay = turnTimeoutMs) => { clearTimeout(timer); timer = setTimeout(() => finish(new Error('Codex response timed out.')), delay); };
    const onAbort = () => finish(new Error('Codex request aborted.'));
    const onDisconnect = (error: Error) => finish(error);
    // Connector artifacts (images, designs, files) arrive as structured ITEMS,
    // not as answer text — the live capture that produced "Đã vẽ chú chó hình
    // vuông như trên" with nothing on screen. Collect them for the turn and append
    // what the model did not already write, so the bubble shows the thing the
    // connector made. See codexNotificationMedia.
    const turnMedia: ReturnType<typeof collectMediaFromNotification> = [];
    // Last finished-message item of the turn. Held (never streamed) so a
    // completion that arrives before its deltas cannot duplicate the answer.
    let lastFinishedMessageItem: any = null;
    // Diagnostics for the "turn ended with zero text" case (the canned
    // "I don't have enough context…" line): which notifications actually arrived,
    // how many carried deltas, and whether any were dropped by the thread filter.
    let notificationCount = 0;
    let deltaCount = 0;
    let mismatchedThreadCount = 0;
    let lastNotificationMethod = '';
    const onNotification = (message: any) => {
      const p = message.params;
      if (p?.threadId !== threadId) { mismatchedThreadCount++; return; }
      notificationCount++;
      lastNotificationMethod = String(message.method || '');
      const isPluginInteraction = message.method === 'item/tool/requestUserInput'
        || message.method === 'mcpServer/elicitation/request';
      resetTimer(isPluginInteraction ? Math.max(turnTimeoutMs, PLUGIN_INTERACTION_TIMEOUT_MS) : turnTimeoutMs);
      if (DEBUG_NOTIFICATIONS) {
        // Diagnosing a connector needs the RAW notification shape: which item
        // methods it emits and where a URL/artifact lives. Gate with
        // NATIVELY_CODEX_DEBUG_NOTIFICATIONS=1 (verbose — one line per event).
        try {
          console.log(`[CodexAppServer][notify] ${message.method} ${JSON.stringify(message.params ?? {}).slice(0, 1500)}`);
        } catch { /* diagnostics must never break the turn */ }
      }
      if (message.method === 'item/agentMessage/delta') {
        deltaCount++;
        const delta = typeof p.delta === 'string' ? p.delta : '';
        if (delta) {
          chunks.push(delta);
          streamedText += delta;
        }
        wake?.();
      } else {
        // A finished message can also arrive as an ITEM instead of deltas. HOLD
        // it — do NOT push it here: an `item/completed` can land BEFORE the deltas
        // that carry the same text, and injecting it mid-turn duplicated the whole
        // answer ("…trong Canva.Đã chuẩn bị bản vẽ…", live 2026-10). It is only
        // used at turn/completed, and only for text the stream never delivered.
        if (message.method === 'item/completed' || message.method === 'item/updated') {
          lastFinishedMessageItem = message;
        }
        // Never mine the answer-text channel: that would duplicate every URL the
        // model itself wrote.
        for (const entry of collectMediaFromNotification(message)) {
          if (!turnMedia.some(existing => existing.url === entry.url)) turnMedia.push(entry);
        }
      }
      if (message.method === 'turn/completed') {
        if (p.turn.status === 'failed') finish(new Error(p.turn.error?.message || 'Codex turn failed.'));
        else if (p.turn.status === 'interrupted') finish(new Error('Codex request aborted.'));
        else {
          // The turn is over: now it is safe to fill a message that arrived as an
          // item (no later delta can repeat it).
          const recovered = recoverAgentMessageText(lastFinishedMessageItem, streamedText);
          if (recovered) {
            chunks.push(recovered);
            streamedText += recovered;
            console.log(`[CodexAppServer] Recovered ${recovered.length} chars of answer text from ${lastFinishedMessageItem?.method}`);
          }
          if (!streamedText.trim()) {
            console.warn(
              `[CodexAppServer][empty-turn] status=${p.turn.status ?? 'completed'} notifications=${notificationCount} deltas=${deltaCount} `
              + `droppedByThreadFilter=${mismatchedThreadCount} lastMethod=${lastNotificationMethod || 'none'} connectorTurn=${connectorTurnsAllowed} `
              + `— the turn produced no text; the chat will show the no-answer fallback`,
            );
          }
          const mediaBlock = buildMediaBlock(streamedText, turnMedia);
          if (mediaBlock) {
            chunks.push(mediaBlock);
            streamedText += mediaBlock;
            if (connectorTurnsAllowed) console.log(`[CodexAppServer] Attached ${turnMedia.length} connector artifact link(s) to the answer`);
          }
          finish();
        }
      }
    };
    this.on('notification', onNotification); this.on('disconnected', onDisconnect);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    resetTimer();
    try {
      if (options.signal?.aborted) throw new Error('Codex request aborted.');
      const input: any[] = [
        { type: 'text', text: appInput.text, text_elements: [] },
        ...(appInput.mention ? [appInput.mention] : []),
        ...options.images.map(url => ({ type: 'image', url })),
      ];
      const effort = options.effort && model.efforts.includes(options.effort) ? options.effort : model.defaultEffort;
      const result = await this.request('turn/start', { threadId, input, effort, environments: [], approvalPolicy, approvalsReviewer, ...(options.serviceTier && options.serviceTier !== 'default' ? { serviceTier: options.serviceTier === 'fast' ? 'fast' : options.serviceTier } : {}) });
      turnId = result.turn.id;
      while (true) {
        while (chunks.length) yield chunks.shift()!;
        if (done) { if (failure) throw failure; break; }
        await new Promise<void>(resolve => { wake = resolve; });
      }
    } finally {
      clearTimeout(timer!); this.off('notification', onNotification); this.off('disconnected', onDisconnect);
      options.signal?.removeEventListener('abort', onAbort);
      this.cancelPluginInteractionsForThread(threadId);
      this.threadApps.delete(threadId);
      if ((!done || failure) && turnId) await this.request('turn/interrupt', { threadId, turnId }, 3000).catch(() => {});
      await this.request('thread/unsubscribe', { threadId }, 3000).catch(() => {});
    }
  }
}
