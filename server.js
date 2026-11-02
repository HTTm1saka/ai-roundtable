import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { endpoint, validReasoningEffort } from './public/core.js';
import { subscriptionReply, subscriptionStatus } from './codex-provider.js';

const root = fileURLToPath(new URL('.', import.meta.url));
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const vendors = { '/vendor/marked.js': 'node_modules/marked/lib/marked.umd.js', '/vendor/purify.js': 'node_modules/dompurify/dist/purify.min.js' };
export function errorText(status) {
  if (status === 401 || status === 403) return '认证或权限失败，请检查 API Key、账户权限与额度。';
  if (status === 404) return '模型或接口路径不存在，请检查模型名称和 Base URL。';
  if (status === 429) return '服务商限流或额度不足，请稍后手动重试。';
  if (status === 400 || status === 422) return '接口参数不兼容，请检查模型是否支持 Chat Completions、system 消息、流式输出及所选思考程度；可将思考程度改为“跟随模型”或关闭流式后手动重试。';
  return `上游服务请求失败（HTTP ${status}），请检查服务商状态。`;
}
export function createServer({ codexReply = subscriptionReply, codexStatus = subscriptionStatus } = {}) {
  return http.createServer(async (req, res) => {
    const host = req.headers.host || '';
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) { res.writeHead(403).end(); return; }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    const path = new URL(req.url, 'http://localhost').pathname;
    if ((path === '/api/chat' || path === '/api/chatgpt/status') && req.method === 'POST') {
      const origin = req.headers.origin;
      if ((origin && origin !== `http://${host}`) || req.headers['x-roundtable'] !== '1') {
        res.writeHead(403).end(); return;
      }
      if (path === '/api/chatgpt/status') {
        try { res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(await codexStatus())); }
        catch { res.writeHead(503, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: '无法检查 ChatGPT 登录状态。' })); }
        return;
      }
      const controller = new AbortController();
      let timedOut = false, timer;
      res.on('close', () => { controller.abort(); clearTimeout(timer); });
      const jsonError = (status, message) => {
        if (!res.headersSent) res.writeHead(status, { 'Content-Type': 'application/json' });
        if (!res.destroyed) res.end(JSON.stringify({ error: message }));
      };
      try {
        const chunks = []; let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 6 * 1024 * 1024) { jsonError(413, '请求内容过大。'); return; }
          chunks.push(chunk);
        }
        let data;
        try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { jsonError(400, '请求 JSON 无效。'); return; }
        if (!data || ![undefined, 'api', 'chatgpt'].includes(data.provider)
          || !validReasoningEffort(data.reasoningEffort, data.provider)
          || typeof data.base !== 'string' || typeof data.model !== 'string' || data.model.length > 200 || (data.provider !== 'chatgpt' && !data.model.trim())
          || typeof data.key !== 'string' || data.key.length > 10000 || /[\r\n]/.test(data.key)
          || !Array.isArray(data.messages) || !data.messages.length || data.messages.length > 100000
          || data.messages.some(m => !m || !['system','user','assistant'].includes(m.role) || typeof m.content !== 'string')
          || typeof data.stream !== 'boolean' || !Number.isInteger(data.timeout) || data.timeout < 5 || data.timeout > 600) {
          jsonError(400, '请求配置无效，请检查模型、消息格式和超时设置。'); return;
        }
        if (data.provider === 'chatgpt') {
          timer = setTimeout(() => { timedOut = true; controller.abort(); }, data.timeout * 1000);
          let content = '';
          const event = value => res.write(`data: ${JSON.stringify(value)}\n\n`);
          try {
            await codexReply(data, { signal: controller.signal, onDelta: delta => {
              if (controller.signal.aborted) return;
              if (data.stream) {
                if (!res.headersSent) res.writeHead(200, { 'Content-Type': 'text/event-stream', 'X-Accel-Buffering': 'no' });
                event({ choices: [{ delta: { content: delta } }] });
              } else content += delta;
            } });
            controller.signal.throwIfAborted();
            if (data.stream) {
              if (!res.headersSent) throw new Error('empty');
              event({ choices: [{ delta: {}, finish_reason: 'stop' }] });
              res.end('data: [DONE]\n\n');
            } else res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }));
          } catch {
            if (!res.destroyed) {
              if (res.headersSent) event({ error: { code: timedOut ? 'timeout' : 'subscription' } });
              else jsonError(timedOut ? 504 : 502, timedOut ? 'ChatGPT 请求超时，请增加超时后手动重试。' : 'ChatGPT 订阅请求失败。请运行 npm run login:chatgpt 登录，检查模型权限、思考程度、网络及订阅额度后重试；不会自动转用 API Key。');
              if (!res.writableEnded) res.end();
            }
          }
          return;
        }
        let url;
        try { url = endpoint(data.base); } catch { jsonError(400, 'Base URL 格式无效，请使用完整 HTTP(S) 地址，且不要附带密钥或查询参数。'); return; }
        timer = setTimeout(() => { timedOut = true; controller.abort(); }, data.timeout * 1000);
        const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' };
        if (data.key) headers.Authorization = `Bearer ${data.key}`;
        const upstream = await fetch(url, { method: 'POST', headers,
          body: JSON.stringify({ model: data.model, messages: data.messages, stream: data.stream,
            ...(data.reasoningEffort && data.reasoningEffort !== 'default' ? { reasoning_effort: data.reasoningEffort } : {}) }),
          signal: controller.signal, redirect: 'error' });
        if (!upstream.ok) { await upstream.body?.cancel(); jsonError(upstream.status, errorText(upstream.status)); return; }
        const type = upstream.headers.get('content-type') || '';
        if (!/application\/json|text\/event-stream/i.test(type)) {
          await upstream.body?.cancel(); jsonError(502, '接口未返回 JSON 或 SSE；请检查 Base URL 是否误填为网页地址。'); return;
        }
        res.writeHead(200, { 'Content-Type': type, 'X-Accel-Buffering': 'no' });
        const { once } = await import('node:events');
        for await (const chunk of upstream.body) {
          if (!res.write(chunk)) await once(res, 'drain', { signal: controller.signal });
        }
        res.end();
      } catch {
        if (!res.destroyed) {
          const message = timedOut ? '请求超时，请检查网络或增加超时时间后手动重试。' : '网络连接失败或连接被中断，请检查 Base URL、代理网络和服务商。请求经本地代理发送，不受浏览器上游跨域限制。';
          if (res.headersSent) {
            if ((res.getHeader('Content-Type') || '').includes('text/event-stream'))
              res.end(`\n\ndata: ${JSON.stringify({error:{code:timedOut?'timeout':'network'}})}\n\n`);
            else res.destroy();
          } else jsonError(timedOut ? 504 : 502, message);
        }
      } finally { clearTimeout(timer); }
      return;
    }
    if (req.method !== 'GET') { res.writeHead(405).end(); return; }
    const allowed = ['/', '/index.html','/styles.css','/app.js','/core.js','/storage.js','/client.js','/engine.js'];
    const file = vendors[path] || (allowed.includes(path) ? `public/${path === '/' ? 'index.html' : path.slice(1)}` : null);
    if (!file) { res.writeHead(404).end(); return; }
    try {
      const content = await readFile(root + file);
      const ext = file.slice(file.lastIndexOf('.'));
      res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
      res.writeHead(200, { 'Content-Type': mime[ext] || 'text/plain' }).end(content);
    } catch { res.writeHead(404).end('文件不存在；请先运行 npm install。'); }
  });
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.PORT || 3210);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error('启动失败：PORT 必须是 0–65535 之间的整数。'); process.exit(1);
  }
  const server = createServer();
  server.on('error', () => { console.error('启动失败：端口可能已被占用，请设置 PORT 后重试。'); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`圆桌已启动：http://127.0.0.1:${server.address().port}（Ctrl+C 退出）`));
}
