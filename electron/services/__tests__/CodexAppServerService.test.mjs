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
  assert.equal(thread.baseInstructions, 'Be concise.');
  assert.deepEqual(thread.environments, []);
  const turn = calls.find(c => c.method === 'turn/start').params;
  assert.equal(turn.effort, 'low');
  assert.deepEqual(turn.input[1], { type: 'image', url: 'data:image/png;base64,test' });
  assert.equal(calls.at(-1).method, 'thread/unsubscribe');
  assert.equal(service.listenerCount('notification'), 0);
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

test('rejects server tool and permission requests', () => {
  const service = new CodexAppServerService();
  const replies = [];
  service.send = reply => replies.push(reply);
  service.receive({ id: 7, method: 'item/commandExecution/requestApproval', params: {} });
  assert.equal(replies[0].id, 7);
  assert.equal(replies[0].error.code, -32601);
});
