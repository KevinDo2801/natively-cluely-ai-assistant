import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';

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

  getStatus() { return { ...this.status }; }
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
      // Apps execute inside Codex's hosted connector runtime. Read-only calls
      // need no client response; app actions with side effects arrive here as
      // approval/elicitation requests. Until Natively has a dedicated approval
      // surface, fail closed instead of silently granting an action.
      const appApproval = message.method === 'item/tool/requestUserInput'
        || message.method === 'mcpServer/elicitation/request';
      this.send({
        id: message.id,
        error: {
          code: -32601,
          message: appApproval
            ? 'This plugin action needs confirmation, which Natively does not support yet. Read-only plugin tools remain available.'
            : 'Agent tools and approvals are not available in Natively chat.',
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

  private async resolveAppMention(prompt: string, configured: string): Promise<{
    text: string;
    mention?: { type: 'mention'; name: string; path: string };
  }> {
    const match = prompt.match(/^@([A-Za-z0-9_-]+)(?:\s+([\s\S]*))?$/);
    if (!match) return { text: prompt };
    const requestedId = match[1].toLowerCase();
    const app = (await this.listApps(configured)).find(candidate => candidate.id.toLowerCase() === requestedId);
    if (!app) throw new Error(`Plugin "${match[1]}" was not found. Open Settings → Plugins and refresh the catalog.`);
    if (!app.callable) throw new Error(`Plugin "${app.name}" is not connected. Open Settings → Plugins to connect it.`);
    const query = (match[2] || '').trim();
    return {
      text: `$${app.id}${query ? ` ${query}` : ''}`,
      mention: { type: 'mention', name: app.name, path: `app://${app.id}` },
    };
  }

  async *stream(options: { model: string; prompt: string; instructions?: string; images: string[]; timeoutMs: number; signal?: AbortSignal; effort?: string; serviceTier?: string }, configured = 'codex'): AsyncGenerator<string> {
    if (options.signal?.aborted) throw new Error('Codex request aborted.');
    const models = await this.listModels(configured);
    const model = models.find(m => m.id === options.model);
    if (!model) throw new Error(`Model ${options.model} is unavailable in Codex. Choose a model in Settings → AI Providers.`);
    const cwd = path.join(os.tmpdir(), 'natively-codex-chat');
    const appInput = await this.resolveAppMention(options.prompt, configured);
    const created = await this.request('thread/start', { model: model.id, cwd, ephemeral: true, sandbox: 'read-only', approvalPolicy: 'never',
      environments: [], selectedCapabilityRoots: [], dynamicTools: [],
      baseInstructions: options.instructions || 'Answer the user directly.',
      developerInstructions: 'You are the text response provider inside Natively. You may call an enabled app connector only when the user explicitly mentions that app. Do not call shell tools, run commands, read local files, or delegate work.',
      config: { project_doc_max_bytes: 0, web_search: 'disabled', mcp_servers: {} },
    });
    const threadId = created.thread.id;
    let turnId: string | undefined;
    const chunks: string[] = [];
    let done = false;
    let failure: Error | undefined;
    let wake: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (error?: Error) => { failure = error; done = true; wake?.(); };
    const resetTimer = () => { clearTimeout(timer); timer = setTimeout(() => finish(new Error('Codex response timed out.')), options.timeoutMs); };
    const onAbort = () => finish(new Error('Codex request aborted.'));
    const onDisconnect = (error: Error) => finish(error);
    const onNotification = (message: any) => {
      const p = message.params;
      if (p?.threadId !== threadId) return;
      resetTimer();
      if (message.method === 'item/agentMessage/delta') { chunks.push(p.delta); wake?.(); }
      if (message.method === 'turn/completed') {
        if (p.turn.status === 'failed') finish(new Error(p.turn.error?.message || 'Codex turn failed.'));
        else if (p.turn.status === 'interrupted') finish(new Error('Codex request aborted.'));
        else finish();
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
      const result = await this.request('turn/start', { threadId, input, effort, environments: [], ...(options.serviceTier && options.serviceTier !== 'default' ? { serviceTier: options.serviceTier === 'fast' ? 'fast' : options.serviceTier } : {}) });
      turnId = result.turn.id;
      while (true) {
        while (chunks.length) yield chunks.shift()!;
        if (done) { if (failure) throw failure; break; }
        await new Promise<void>(resolve => { wake = resolve; });
      }
    } finally {
      clearTimeout(timer!); this.off('notification', onNotification); this.off('disconnected', onDisconnect);
      options.signal?.removeEventListener('abort', onAbort);
      if ((!done || failure) && turnId) await this.request('turn/interrupt', { threadId, turnId }, 3000).catch(() => {});
      await this.request('thread/unsubscribe', { threadId }, 3000).catch(() => {});
    }
  }
}
