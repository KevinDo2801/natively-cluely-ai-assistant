import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CodexAppServerService } from '../../../dist-electron/electron/services/CodexAppServerService.js';

const options = { model: 'available', prompt: 'hello', images: [], timeoutMs: 1500 };
function fixture(onStart) {
  const service = new CodexAppServerService();
  const calls = [];
  service.listModels = async () => [{ id: 'available', efforts: ['low'], defaultEffort: 'low' }];
  service.request = async (method, params) => {
    calls.push({ method, params });
    if (method === 'thread/start') return { thread: { id: 'thread-1' } };
    if (method === 'turn/start') { setTimeout(() => onStart?.(service), 0); return { turn: { id: 'turn-1' } }; }
    return {};
  };
  return { service, calls };
}
const emit = (service, method, params = {}) => service.emit('notification', { method, params: { threadId: 'thread-1', ...params } });
async function collect(service, opts = options) { let result = ''; for await (const part of service.stream(opts)) result += part; return result; }

test('streams only its thread, preserves images and instructions, and releases the ephemeral thread', async () => {
  const { service, calls } = fixture(s => {
    emit(s, 'item/agentMessage/delta', { threadId: 'other', delta: 'wrong' });
    emit(s, 'item/agentMessage/delta', { delta: 'O' });
    emit(s, 'item/agentMessage/delta', { delta: 'K' });
    emit(s, 'turn/completed', { turn: { status: 'completed' } });
  });
  assert.equal(await collect(service, { ...options, images: ['data:image/png;base64,test'], instructions: 'Be concise.', effort: 'ultra' }), 'OK');
  const thread = calls.find(c => c.method === 'thread/start').params;
  assert.equal(thread.ephemeral, true);
  assert.equal(thread.sandbox, 'read-only');
  assert.equal(thread.approvalPolicy, 'never');
  assert.equal(thread.approvalsReviewer, undefined);
  assert.equal(thread.baseInstructions, 'Be concise.');
  assert.deepEqual(thread.environments, []);
  const turn = calls.find(c => c.method === 'turn/start').params;
  assert.equal(turn.approvalPolicy, 'never');
  assert.equal(turn.effort, 'low');
  assert.deepEqual(turn.input[1], { type: 'image', url: 'data:image/png;base64,test' });
  assert.equal(calls.at(-1).method, 'thread/unsubscribe');
  assert.equal(service.listenerCount('notification'), 0);
});

test('does not leak the parent Codex or Electron session into the embedded App Server', () => {
  const environment = CodexAppServerService.buildSpawnEnvironment({
    PATH: 'C:\\Windows',
    APPDATA: 'C:\\Users\\test\\AppData\\Roaming',
    CODEX_HOME: 'C:\\Users\\test\\.codex-alt',
    CODEX_SESSION_ID: 'parent-session',
    CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'Codex Desktop',
    ELECTRON_RUN_AS_NODE: '1',
    NODE_ENV: 'development',
    NODE_OPTIONS: '--inspect',
    NODE_REPL_TRUSTED_BROWSER_CLIENT_SHA256S: 'parent-browser',
  });

  assert.equal(environment.PATH, 'C:\\Windows');
  assert.equal(environment.APPDATA, 'C:\\Users\\test\\AppData\\Roaming');
  assert.equal(environment.CODEX_HOME, 'C:\\Users\\test\\.codex-alt');
  assert.equal(environment.CODEX_SESSION_ID, undefined);
  assert.equal(environment.CODEX_INTERNAL_ORIGINATOR_OVERRIDE, undefined);
  assert.equal(environment.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(environment.NODE_ENV, undefined);
  assert.equal(environment.NODE_OPTIONS, undefined);
  assert.equal(environment.NODE_REPL_TRUSTED_BROWSER_CLIENT_SHA256S, undefined);
});

test('propagates upstream turn failures instead of returning an empty success', async () => {
  const { service, calls } = fixture(s => emit(s, 'turn/completed', { turn: { status: 'failed', error: { message: 'model unavailable' } } }));
  await assert.rejects(collect(service), /model unavailable/);
  assert.ok(calls.some(c => c.method === 'turn/interrupt'));
});

test('cancellation interrupts the active turn and detaches listeners', async () => {
  const controller = new AbortController();
  const { service, calls } = fixture(() => controller.abort());
  await assert.rejects(collect(service, { ...options, signal: controller.signal }), /aborted/);
  assert.deepEqual(calls.find(c => c.method === 'turn/interrupt').params, { threadId: 'thread-1', turnId: 'turn-1' });
  assert.equal(service.listenerCount('notification'), 0);
});

test('idle timeout interrupts a stalled turn', async () => {
  const { service, calls } = fixture();
  await assert.rejects(collect(service, { ...options, timeoutMs: 40 }), /timed out/);
  assert.ok(calls.some(c => c.method === 'turn/interrupt'));
});

test('ongoing text resets the idle deadline', async () => {
  const { service } = fixture(s => {
    for (let i = 1; i <= 5; i++) setTimeout(() => emit(s, 'item/agentMessage/delta', { delta: '.' }), i * 30);
    setTimeout(() => emit(s, 'turn/completed', { turn: { status: 'completed' } }), 165);
  });
  assert.equal(await collect(service, { ...options, timeoutMs: 100 }), '.....');
});

test('server exit wakes a waiting stream promptly', async () => {
  const { service } = fixture(s => s.emit('disconnected', new Error('process exited')));
  await assert.rejects(collect(service), /process exited/);
});

test('unavailable models fail before creating a thread', async () => {
  const { service, calls } = fixture();
  await assert.rejects(collect(service, { ...options, model: 'retired' }), /unavailable/);
  assert.equal(calls.length, 0);
});

test('turn input includes the Codex app mention selected with @', async () => {
  const { service, calls } = fixture(s => emit(s, 'turn/completed', { turn: { status: 'completed' } }));
  service.listApps = async () => [{
    id: 'google-drive',
    name: 'Google Drive',
    isAccessible: true,
    isEnabled: true,
    callable: true,
    pluginDisplayNames: [],
  }];
  await collect(service, { ...options, prompt: '@google-drive find the project notes' });
  const turn = calls.find(c => c.method === 'turn/start').params;
  const thread = calls.find(c => c.method === 'thread/start').params;
  assert.equal(thread.approvalPolicy, 'on-request');
  assert.equal(thread.approvalsReviewer, 'user');
  assert.deepEqual(turn.input.slice(0, 2), [
    { type: 'text', text: '$google-drive find the project notes', text_elements: [] },
    { type: 'mention', name: 'Google Drive', path: 'app://google-drive' },
  ]);
});

test('structured app selection survives wrapped conversation context', async () => {
  const { service, calls } = fixture(s => emit(s, 'turn/completed', { turn: { status: 'completed' } }));
  service.listApps = async () => [{
    id: 'connector_calendar',
    name: 'Google Calendar',
    isAccessible: true,
    isEnabled: true,
    callable: true,
    pluginDisplayNames: [],
  }];
  const prompt = 'CONTEXT:\nUser: create a meeting\n\nUSER QUESTION:\ntoday at 5 PM';
  await collect(service, {
    ...options,
    prompt,
    app: { id: 'connector_calendar', name: 'Google Calendar' },
  });
  const turn = calls.find(c => c.method === 'turn/start').params;
  const thread = calls.find(c => c.method === 'thread/start').params;
  assert.equal(thread.approvalPolicy, 'on-request');
  assert.equal(thread.approvalsReviewer, 'user');
  assert.equal(turn.approvalPolicy, 'on-request');
  assert.equal(turn.approvalsReviewer, 'user');
  assert.equal(turn.input[0].text, `$connector_calendar ${prompt}`);
  assert.deepEqual(turn.input[1], {
    type: 'mention',
    name: 'Google Calendar',
    path: 'app://connector_calendar',
  });
});

test('a disconnected app mention fails before a thread is created', async () => {
  const { service, calls } = fixture();
  service.listApps = async () => [{
    id: 'google-drive',
    name: 'Google Drive',
    isAccessible: true,
    isEnabled: true,
    callable: false,
    pluginDisplayNames: [],
  }];
  await assert.rejects(
    collect(service, { ...options, prompt: '@google-drive find the project notes' }),
    /not connected/,
  );
  assert.equal(calls.length, 0);
});

test('merges the app catalog with installed runtime state', async () => {
  const service = new CodexAppServerService();
  service.connect = async () => {};
  service.status = { signedIn: true, email: 'test@example.com' };
  service.request = async method => {
    if (method === 'app/list') return {
      data: [{
        id: 'drive',
        name: 'Drive',
        description: 'Search files',
        installUrl: 'https://chatgpt.com/apps/drive',
        isAccessible: true,
        isEnabled: true,
        pluginDisplayNames: ['Drive plugin'],
      }],
      nextCursor: null,
    };
    if (method === 'app/installed') return {
      apps: [{ id: 'drive', enabled: false, callable: true }],
    };
    throw new Error(`Unexpected method ${method}`);
  };
  assert.deepEqual(await service.listApps(), [{
    id: 'drive',
    name: 'Drive',
    description: 'Search files',
    logoUrl: undefined,
    installUrl: 'https://chatgpt.com/apps/drive',
    isAccessible: true,
    isEnabled: false,
    callable: true,
    canToggle: true,
    pluginDisplayNames: ['Drive plugin'],
  }]);
});

test('uses the authenticated Codex directory cache on every catalog page', async () => {
  const service = new CodexAppServerService();
  const listParams = [];
  service.connect = async () => {};
  service.status = { signedIn: true, email: 'test@example.com' };
  service.request = async (method, params) => {
    if (method === 'app/list') {
      listParams.push(params);
      return params.cursor
        ? { data: [], nextCursor: null }
        : { data: [], nextCursor: 'page-2' };
    }
    if (method === 'app/installed') return { apps: [] };
    throw new Error(`Unexpected method ${method}`);
  };
  await service.listApps('codex', true);
  assert.equal(listParams[0].forceRefetch, false);
  assert.equal(listParams[1].forceRefetch, false);
  assert.equal(listParams[0].limit, 5_000);
});

test('refreshes installed state without re-fetching a cached catalog', async () => {
  const service = new CodexAppServerService();
  const calls = [];
  service.connect = async () => {};
  service.status = { signedIn: true, email: 'test@example.com' };
  service.apps = [{
    id: 'drive', name: 'Drive', isAccessible: true, isEnabled: true,
    callable: false, pluginDisplayNames: [],
  }];
  service.request = async (method, params) => {
    calls.push({ method, params });
    return { apps: [{ id: 'drive', enabled: true, callable: true }] };
  };
  const apps = await service.listApps('codex', true);
  assert.deepEqual(calls, [{ method: 'app/installed', params: { forceRefresh: true } }]);
  assert.equal(apps[0].callable, true);
});

test('deduplicates simultaneous catalog loads from multiple renderer windows', async () => {
  const service = new CodexAppServerService();
  let listCalls = 0;
  service.connect = async () => {};
  service.status = { signedIn: true, email: 'test@example.com' };
  service.request = async method => {
    if (method === 'app/list') {
      listCalls += 1;
      await new Promise(resolve => setTimeout(resolve, 10));
      return { data: [], nextCursor: null };
    }
    if (method === 'app/installed') return { apps: [] };
    throw new Error(`Unexpected method ${method}`);
  };
  await Promise.all([
    service.listApps('codex', false),
    service.listApps('codex', true),
    service.listApps('codex', false),
  ]);
  assert.equal(listCalls, 1);
});

test('falls back to connected plugins when the directory returns an HTML 403', async () => {
  const service = new CodexAppServerService();
  service.connect = async () => {};
  service.status = { signedIn: true, email: 'test@example.com' };
  service.request = async method => {
    if (method === 'app/list') throw new Error('failed to list apps: 403 Forbidden: <html>challenge</html>');
    if (method === 'app/installed') return {
      apps: [{ id: 'drive', runtimeName: 'Google Drive', enabled: true, callable: true }],
    };
    throw new Error(`Unexpected method ${method}`);
  };
  const apps = await service.listApps();
  assert.equal(apps.length, 1);
  assert.equal(apps[0].name, 'Google Drive');
  assert.equal(apps[0].callable, true);
  assert.equal(service.getAppsCatalogStatus().limited, true);
});

test('uses the Codex plugin marketplace when the stable app directory returns 403', async () => {
  const service = new CodexAppServerService();
  service.connect = async () => {};
  service.status = { signedIn: true, email: 'test@example.com' };
  service.request = async method => {
    if (method === 'app/list') throw new Error('failed to list apps: 403 Forbidden');
    if (method === 'app/installed') return {
      apps: [{ id: 'connector_gmail', runtimeName: 'Gmail', enabled: true, callable: true }],
    };
    if (method === 'plugin/list') return {
      marketplaces: [{
        name: 'openai-curated-remote',
        plugins: [{
          name: 'gmail', installed: true, enabled: true, availability: 'AVAILABLE', installPolicy: 'AVAILABLE',
          source: { type: 'remote' },
          interface: { displayName: 'Gmail', shortDescription: 'Read Gmail', logoUrl: 'https://example.com/gmail.png' },
        }, {
          name: 'airtable', installed: false, enabled: false, availability: 'AVAILABLE', installPolicy: 'AVAILABLE',
          source: { type: 'remote' },
          interface: { displayName: 'Airtable', shortDescription: 'Use Airtable' },
        }],
      }],
    };
    throw new Error(`Unexpected method ${method}`);
  };

  const apps = await service.listApps();
  assert.equal(apps.length, 2);
  assert.deepEqual(apps.map(app => ({ id: app.id, callable: app.callable, canToggle: app.canToggle })), [
    { id: 'connector_gmail', callable: true, canToggle: true },
    { id: 'airtable', callable: false, canToggle: false },
  ]);
  assert.equal(apps[1].marketplaceName, 'openai-curated-remote');
  assert.equal(apps[1].pluginName, 'airtable');
  assert.equal(service.getAppsCatalogStatus().limited, false);
});

test('resolves a marketplace plugin to its official app connection URL', async () => {
  const service = new CodexAppServerService();
  service.connect = async () => {};
  service.request = async (method, params) => {
    assert.equal(method, 'plugin/read');
    assert.deepEqual(params, { remoteMarketplaceName: 'openai-curated-remote', pluginName: 'airtable' });
    return { plugin: { apps: [{ installUrl: 'https://chatgpt.com/apps/airtable/app_123' }] } };
  };
  const url = await service.getAppConnectionUrl({
    id: 'airtable', name: 'Airtable', isAccessible: true, isEnabled: false,
    callable: false, marketplaceName: 'openai-curated-remote', pluginName: 'airtable', pluginDisplayNames: [],
  });
  assert.equal(url, 'https://chatgpt.com/apps/airtable/app_123');
});

test('adopts a full catalog recovered by an isolated App Server', async () => {
  const service = new CodexAppServerService();
  service.adoptAppsCatalog([{
    id: 'drive', name: 'Drive', isAccessible: true, isEnabled: true,
    callable: true, pluginDisplayNames: ['Google Drive'],
  }]);
  assert.equal(service.getAppsCatalogStatus().limited, false);
  assert.equal(service.apps.length, 1);
  assert.equal(service.apps[0].name, 'Drive');
});

test('does not turn in-flight app list updates into renderer refresh loops', () => {
  const service = new CodexAppServerService();
  let changes = 0;
  service.apps = [{
    id: 'drive', name: 'Drive', isAccessible: true, isEnabled: true,
    callable: true, pluginDisplayNames: [],
  }];
  service.on('apps:changed', () => { changes += 1; });

  service.receive({ method: 'app/list/updated', params: { data: [] } });

  assert.equal(changes, 0);
  assert.equal(service.apps.length, 1);

  service.receive({ method: 'mcpServer/oauthLogin/completed', params: {} });
  assert.equal(changes, 1);
  assert.equal(service.apps, undefined);
});

test('writes plugin enabled state through Codex config', async () => {
  const service = new CodexAppServerService();
  const calls = [];
  service.connect = async () => {};
  service.status = { signedIn: true, email: 'test@example.com' };
  service.request = async (method, params) => { calls.push({ method, params }); return {}; };
  await service.setAppEnabled('drive', false);
  assert.deepEqual(calls[0], {
    method: 'config/value/write',
    params: { keyPath: 'apps.drive.enabled', value: false, mergeStrategy: 'upsert' },
  });
});

test('rejects server tool and permission requests', () => {
  const service = new CodexAppServerService();
  const replies = [];
  service.send = reply => replies.push(reply);
  service.receive({ id: 7, method: 'item/commandExecution/requestApproval', params: {} });
  assert.equal(replies[0].id, 7);
  assert.equal(replies[0].error.code, -32601);
});

test('plugin user-input requests wait for and forward the renderer response', async () => {
  const service = new CodexAppServerService();
  const replies = [];
  const requests = [];
  const closed = [];
  service.send = reply => replies.push(reply);
  service.threadApps.set('thread-1', { id: 'connector_calendar', name: 'Google Calendar' });
  service.on('plugin-interaction', request => requests.push(request));
  service.on('plugin-interaction-closed', requestId => closed.push(requestId));
  service.receive({
    id: 8,
    method: 'item/tool/requestUserInput',
    params: {
      threadId: 'thread-1',
      questions: [{ id: 'confirm', header: 'Create event', question: 'Create LeetCode?', isOther: false, isSecret: false, options: [{ label: 'Yes', description: 'Create it' }] }],
    },
  });
  assert.equal(replies.length, 0);
  assert.equal(requests[0].app.name, 'Google Calendar');
  await service.resolvePluginInteraction(requests[0].requestId, { action: 'accept', values: { confirm: 'Yes' } });
  assert.deepEqual(replies[0], { id: 8, result: { answers: { confirm: { answers: ['Yes'] } } } });
  assert.deepEqual(closed, [requests[0].requestId]);
});

test('plugin elicitation requests support an explicit decline', async () => {
  const service = new CodexAppServerService();
  const replies = [];
  const requests = [];
  service.send = reply => replies.push(reply);
  service.on('plugin-interaction', request => requests.push(request));
  service.receive({
    id: 9,
    method: 'mcpServer/elicitation/request',
    params: { threadId: 'thread-1', serverName: 'calendar', mode: 'form', message: 'Create event?', requestedSchema: { type: 'object', properties: {} } },
  });
  await service.resolvePluginInteraction(requests[0].requestId, { action: 'decline' });
  assert.deepEqual(replies[0], { id: 9, result: { action: 'decline', content: null, _meta: null } });
});

// ── Settings → Plugins → "Approve plugin actions automatically" ─────────────
// The service default stays OFF (direct construction, tests, background recovery
// instances). The app turns it ON from the persisted setting at IPC wiring time.

test('sets the approval policy on the request it receives', () => {
  const service = new CodexAppServerService();
  assert.equal(service.getAutoApprovePlugins(), false);
  service.setAutoApprovePlugins(true);
  assert.equal(service.getAutoApprovePlugins(), true);
  // Anything that is not exactly `true` must not enable it.
  service.setAutoApprovePlugins(1);
  assert.equal(service.getAutoApprovePlugins(), false);
});

test('auto-approval answers a plugin confirmation without the renderer', () => {
  const service = new CodexAppServerService();
  const replies = [];
  const requests = [];
  service.send = reply => replies.push(reply);
  service.setAutoApprovePlugins(true);
  service.threadApps.set('thread-1', { id: 'connector_calendar', name: 'Google Calendar' });
  service.on('plugin-interaction', request => requests.push(request));
  service.receive({
    id: 11,
    method: 'item/tool/requestUserInput',
    params: {
      threadId: 'thread-1',
      questions: [{
        id: 'confirm',
        header: 'Create event',
        question: 'Create LeetCode?',
        isOther: false,
        isSecret: false,
        options: [{ label: 'Yes', description: 'Create it' }, { label: 'No', description: 'Cancel it' }],
      }],
    },
  });
  assert.deepEqual(replies, [{ id: 11, result: { answers: { confirm: { answers: ['Yes'] } } } }]);
  assert.equal(requests.length, 0, 'the card must not be shown when the policy already answered');
  assert.equal(service.pluginInteractions.size, 0, 'nothing may be left pending');
});

test('auto-approval accepts a plain elicitation but still surfaces data requests', async () => {
  const service = new CodexAppServerService();
  const replies = [];
  const requests = [];
  service.send = reply => replies.push(reply);
  service.setAutoApprovePlugins(true);
  service.receive({
    id: 12,
    method: 'mcpServer/elicitation/request',
    params: { threadId: 'thread-1', serverName: 'calendar', mode: 'form', requestedSchema: { type: 'object', properties: {} } },
  });
  assert.deepEqual(replies, [{ id: 12, result: { action: 'accept', content: {}, _meta: null } }]);

  service.on('plugin-interaction', request => requests.push(request));
  service.receive({
    id: 13,
    method: 'mcpServer/elicitation/request',
    params: { threadId: 'thread-1', serverName: 'calendar', mode: 'form', requestedSchema: { type: 'object', required: ['title'] } },
  });
  assert.equal(replies.length, 1, 'a requisition for user data must not be auto-answered');
  assert.equal(requests.length, 1, 'the card carries the data request to the user');
  // The data request stays pending for the user (and holds the 5-minute
  // timeout); resolve it here so the test process is not kept alive by it.
  await service.resolvePluginInteraction(requests[0].requestId, { action: 'cancel' });
  assert.deepEqual(replies.at(-1), { id: 13, result: { action: 'cancel', content: null, _meta: null } });
});

test('auto-approval lets an unnamed turn reach a connector, without faking a mention', async () => {
  const { service, calls } = fixture(s => emit(s, 'turn/completed', { turn: { status: 'completed' } }));
  service.setAutoApprovePlugins(true);
  const prompt = 'thêm event từ 5h đến 6h chiều nay làm leetcode';
  await collect(service, { ...options, prompt });
  const thread = calls.find(c => c.method === 'thread/start').params;
  const turn = calls.find(c => c.method === 'turn/start').params;
  assert.equal(thread.approvalPolicy, 'on-request', 'a connector write must be allowed to ask instead of being refused');
  assert.equal(thread.approvalsReviewer, 'user');
  assert.equal(turn.approvalPolicy, 'on-request');
  assert.match(thread.developerInstructions, /even when the user does not name it/);
  assert.match(thread.developerInstructions, /never ask the user for permission/);
  assert.match(thread.developerInstructions, /Do not call shell tools, run commands, read local files, or delegate work\./,
    'the shell/file ban must survive the relaxed connector rule');
  assert.deepEqual(turn.input, [{ type: 'text', text: prompt, text_elements: [] }],
    'no app mention may be invented for a plugin the user never named');
});

test('without auto-approval an unnamed turn stays fail-closed', async () => {
  const { service, calls } = fixture(s => emit(s, 'turn/completed', { turn: { status: 'completed' } }));
  await collect(service, { ...options, prompt: 'thêm event từ 5h đến 6h chiều nay làm leetcode' });
  const thread = calls.find(c => c.method === 'thread/start').params;
  assert.equal(thread.approvalPolicy, 'never');
  assert.equal(thread.approvalsReviewer, undefined);
  assert.match(thread.developerInstructions, /only when the user explicitly mentions that app/);
});
