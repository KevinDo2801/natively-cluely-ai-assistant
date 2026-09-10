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
  private executable = 'codex';
  private loginId?: string;

  getStatus() { return { ...this.status }; }

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
      '-c', 'features.apps=false', '-c', 'features.multi_agent=false',
      '-c', 'features.code_mode=false', '-c', 'project_doc_max_bytes=0'];
    const child = spawn(executable, args, { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
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
      if (this.child === child) { this.child = undefined; this.models = undefined; this.fail(new Error('Codex disconnected. Please retry.')); }
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
      // Never grant agent tools or permissions through a chat completion provider.
      this.send({ id: message.id, error: { code: -32601, message: 'Tools and approvals are not available in Natively chat.' } });
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
      void this.readAccount(false).catch(() => {});
    }
    this.emit('notification', message);
  }
  private fail(error: Error) {
    for (const waiting of this.pending.values()) { clearTimeout(waiting.timer); waiting.reject(error); }
    this.pending.clear();
    this.emit('disconnected', error);
  }
  close() {
    const child = this.child; this.child = undefined; this.models = undefined;
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
  async signOut() { await this.connect(this.executable); await this.request('account/logout', {}); this.status = { signedIn: false, email: undefined }; this.models = undefined; this.emit('signed-out'); }
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

  async *stream(options: { model: string; prompt: string; instructions?: string; images: string[]; timeoutMs: number; signal?: AbortSignal; effort?: string; serviceTier?: string }, configured = 'codex'): AsyncGenerator<string> {
    if (options.signal?.aborted) throw new Error('Codex request aborted.');
    const models = await this.listModels(configured);
    const model = models.find(m => m.id === options.model);
    if (!model) throw new Error(`Model ${options.model} is unavailable in Codex. Choose a model in Settings → AI Providers.`);
    const cwd = path.join(os.tmpdir(), 'natively-codex-chat');
    const created = await this.request('thread/start', { model: model.id, cwd, ephemeral: true, sandbox: 'read-only', approvalPolicy: 'never',
      environments: [], selectedCapabilityRoots: [], dynamicTools: [],
      baseInstructions: options.instructions || 'Answer the user directly.',
      developerInstructions: 'You are the text response provider inside Natively. Answer using only the supplied conversation and images. Do not call tools, run commands, read files, or delegate work.',
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
      const input: any[] = [{ type: 'text', text: options.prompt, text_elements: [] }, ...options.images.map(url => ({ type: 'image', url }))];
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
