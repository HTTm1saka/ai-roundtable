import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { subscriptionReply, codexEnv } from '../codex-provider.js';
import { createServer } from '../server.js';
import { profile, session, snapshot, validateBackup, importBackup } from '../public/core.js';
import { Engine } from '../public/engine.js';

test('订阅调用隔离 API 凭证、保留代理，并校验完整回复', async () => {
  const env = codexEnv({ OPENAI_API_KEY: 'secret', CODEX_API_KEY: 'secret', OPENAI_BASE_URL: 'https://evil', CODEX_HOME: 'other', PATH: 'bin', HTTPS_PROXY: 'http://proxy' });
  assert.equal(env.OPENAI_API_KEY, undefined); assert.equal(env.CODEX_API_KEY, undefined);
  assert.equal(env.OPENAI_BASE_URL, undefined); assert.notEqual(env.CODEX_HOME, 'other');
  assert.equal(env.HTTPS_PROXY, 'http://proxy');
  let captured, options, input, content = '';
  const events = [
    { type: 'item.updated', item: { id: 'one', type: 'agent_message', text: '中文' } },
    { type: 'item.completed', item: { id: 'one', type: 'agent_message', text: '中文回复' } },
    { type: 'turn.completed' }
  ];
  const createCodex = config => { captured = config; return { startThread(opts) { options = opts; return { async runStreamed(prompt) {
    input = prompt; return { events: (async function* () { yield* events; })() };
  } }; } }; };
  const data = { model: '', messages: [{ role: 'system', content: '独立角色' }, { role: 'user', content: '讨论内容' }] };
  const run = () => subscriptionReply(data, { signal: new AbortController().signal, status: async () => ({ connected: true }), createCodex, onDelta: d => content += d });
  await run(); assert.equal(content, '中文回复');
  assert.equal(captured.config.forced_login_method, 'chatgpt'); assert.equal(captured.config.model_provider, 'openai');
  assert.equal(options.model, undefined); assert.equal(options.sandboxMode, 'read-only');
  assert.equal(options.modelReasoningEffort, undefined);
  assert.equal(options.approvalPolicy, 'never'); assert.equal(options.webSearchMode, 'disabled');
  assert.ok(input.includes(JSON.stringify(data.messages)));
  for (const effort of ['default', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']) {
    data.reasoningEffort = effort;
    await run(); assert.equal(options.modelReasoningEffort, effort === 'default' ? undefined : effort);
  }
  events.pop(); await assert.rejects(run(), /未完整结束/);
  events.push({ type: 'turn.failed', error: { message: 'SECRET' } });
  await assert.rejects(run(), error => !error.message.includes('SECRET') && /订阅请求失败/.test(error.message));
  await assert.rejects(subscriptionReply(data, { signal: new AbortController().signal, status: async () => ({ connected: false }), createCodex: () => { throw new Error('must not run'); } }), /login:chatgpt/);
});

test('订阅配置兼容旧备份、过滤密钥，默认模型能参与调度', async () => {
  const ai = { ...profile(), provider: 'chatgpt', model: '', reasoningEffort: 'high', base: '', key: 'SECRET', remember: true };
  const s = session([ai]); s.topic = '讨论话题'; s.targetRounds = 1;
  const state = { profiles: [ai], sessions: [s], activeId: s.id };
  const saved = snapshot(state); assert.equal(saved.profiles[0].key, ''); assert.equal(saved.profiles[0].remember, false);
  validateBackup(saved);
  const old = structuredClone(saved); delete old.profiles[0].provider; delete old.sessions[0].participants[0].provider;
  delete old.profiles[0].reasoningEffort; delete old.sessions[0].participants[0].reasoningEffort; validateBackup(old);
  const invalid = structuredClone(saved); invalid.sessions[0].participants[0].reasoningEffort = 'none'; assert.throws(() => validateBackup(invalid));
  saved.profiles[0].provider = 'unknown'; assert.throws(() => validateBackup(saved));
  const target = { profiles: [], sessions: [] }; importBackup(target, snapshot(state, true));
  assert.equal(target.sessions[0].participants[0].provider, 'chatgpt');
  assert.equal(target.sessions[0].participants[0].reasoningEffort, 'high');
  let requests = 0;
  const engine = new Engine({ save: async () => {}, change: () => {}, request: async (_ai, _messages, { onDelta }) => { requests++; onDelta('订阅回复'); } });
  await engine.start(s); assert.equal(requests, 1); assert.equal(s.completedRounds, 1); assert.equal(s.status, 'completed');
});

test('订阅 HTTP 路由：流式/JSON、脱敏、取消、超时、跨站拦截和未知 provider', async t => {
  let aborted = false, calls = 0;
  const proxy = createServer({ codexStatus: async () => ({ connected: true }), codexReply: async (data, { signal, onDelta }) => {
    calls++;
    if (data.model === 'error') throw new Error('SECRET account token');
    onDelta('订阅中文');
    if (['slow', 'timeout'].includes(data.model)) {
      await new Promise(resolve => signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true }));
      signal.throwIfAborted();
    }
    if (data.model === 'partial-error') throw new Error('SECRET account token');
  } });
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
  t.after(() => { proxy.closeAllConnections(); proxy.close(); });
  const url = `http://127.0.0.1:${proxy.address().port}`;
  const body = { provider: 'chatgpt', base: '', key: '', model: '', stream: true, timeout: 5, messages: [{ role: 'user', content: '话题' }] };
  const send = (data = body, extra = {}) => fetch(url + '/api/chat', { method: 'POST', headers: { 'X-Roundtable': '1', ...extra }, body: JSON.stringify(data) });
  let r = await send(); const streamed = await r.text(); assert.match(streamed, /订阅中文/); assert.match(streamed, /\[DONE\]/);
  r = await send({ ...body, stream: false }); assert.equal((await r.json()).choices[0].message.content, '订阅中文');
  r = await send({ ...body, model: 'error' }); assert.equal(r.status, 502); assert.ok(!(await r.text()).includes('SECRET'));
  r = await send({ ...body, model: 'partial-error' }); const partial = await r.text(); assert.match(partial, /subscription/); assert.ok(!partial.includes('SECRET')); assert.ok(!partial.includes('[DONE]'));
  r = await fetch(url + '/api/chatgpt/status', { method: 'POST', headers: { 'X-Roundtable': '1' } }); assert.deepEqual(await r.json(), { connected: true });
  r = await fetch(url + '/api/chatgpt/status', { method: 'POST', headers: { 'X-Roundtable': '1', Origin: 'https://evil.example' } }); assert.equal(r.status, 403);
  const before = calls;
  r = await send({ ...body, reasoningEffort: 'none' }); assert.equal(r.status, 400); assert.equal(calls, before);
  r = await send({ ...body, provider: 'unknown' }); assert.equal(r.status, 400); assert.equal(calls, before);
  r = await send(body, { Origin: 'https://evil.example' }); assert.equal(r.status, 403);
  const controller = new AbortController();
  r = await fetch(url + '/api/chat', { method: 'POST', headers: { 'X-Roundtable': '1' }, body: JSON.stringify({ ...body, model: 'slow' }), signal: controller.signal });
  await r.body.getReader().read(); controller.abort();
  await new Promise(resolve => setTimeout(resolve, 100)); assert.equal(aborted, true);
  r = await send({ ...body, model: 'timeout' }); const timed = await r.text(); assert.match(timed, /timeout/); assert.ok(!timed.includes('[DONE]'));
});
