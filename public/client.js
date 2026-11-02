export async function chatRequest(ai, messages, options = {}) {
  const deadline = new AbortController();
  const timeout = options.timeout || 120;
  const timer = setTimeout(() => deadline.abort(new DOMException('请求超时','TimeoutError')), timeout * 1000 + 500);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal;
  try { return await requestInternal(ai, messages, {...options, timeout, signal}); }
  catch (error) {
    if (deadline.signal.aborted && !options.signal?.aborted) throw new Error('请求超时，部分回复已保留；请增加超时时间后手动重试。');
    throw error;
  } finally { clearTimeout(timer); }
}
async function requestInternal(ai, messages, { signal, timeout = 120, onDelta = () => {} } = {}) {
  const response = await fetch('/api/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Roundtable': '1' },
    body: JSON.stringify({ provider: ai.provider || 'api', base: ai.base, model: ai.model, reasoningEffort: ai.reasoningEffort || 'default', key: ai.provider === 'chatgpt' ? '' : ai.key || '', stream: ai.stream, messages, timeout }), signal
  });
  if (!response.ok) {
    let data;
    try { data = await response.json(); } catch {}
    // Only our proxy's fixed messages are returned; never display raw provider error bodies.
    throw new Error(data?.error || `本地代理请求失败（HTTP ${response.status}）。`);
  }
  if (!(response.headers.get('content-type') || '').includes('text/event-stream')) {
    let data;
    try { data = await response.json(); } catch { throw new Error('接口返回的 JSON 无效。'); }
    const text = data?.choices?.[0]?.message?.content;
    const finish = data?.choices?.[0]?.finish_reason;
    if (typeof text !== 'string' || !text.trim()) throw new Error('接口没有返回文本内容，请选择支持文本 Chat Completions 的模型。');
    onDelta(text);
    if (finish && !['stop','end_turn'].includes(finish)) throw new Error('回复未完整结束（达到输出上限、内容过滤或工具调用）；请调整服务商设置后重试。');
    return;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', event = [], terminal = false, finished = false, hasText = false;
  function dispatch() {
    if (!event.length) return;
    const raw = event.join('\n'); event = [];
    if (raw === '[DONE]') { terminal = true; return; }
    let data;
    try { data = JSON.parse(raw); } catch { throw new Error('流式数据格式不兼容：SSE data 不是有效 JSON。'); }
    if (data.error?.code === 'timeout') throw new Error('请求超时，部分回复已保留；请增加超时时间后手动重试。');
    if (data.error?.code === 'network') throw new Error('生成过程中网络连接中断，部分回复已保留，请检查网络后重试。');
    if (data.error?.code === 'subscription') throw new Error('ChatGPT 订阅生成失败，部分回复已保留；请检查登录状态、模型权限、思考程度与额度后重试。');
    if (data.error) throw new Error('服务商在生成过程中返回错误，请检查账户、模型或稍后重试。');
    const c = data.choices?.[0];
    const part = c?.delta?.content;
    if (typeof part === 'string' && part) { hasText = true; onDelta(part); }
    if (c?.finish_reason) {
      if (!['stop','end_turn'].includes(c.finish_reason)) throw new Error('回复未完整结束（达到输出上限、内容过滤或工具调用），部分回复已保留。');
      finished = true;
    }
  }
  function line(value) {
    if (!value) dispatch();
    else if (value.startsWith('data:')) event.push(value.slice(5).replace(/^ /, ''));
  }
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        line(buffer.slice(0, newline).replace(/\r$/, '')); buffer = buffer.slice(newline + 1);
      }
      if (terminal) { await reader.cancel(); break; }
      if (done) { if (buffer) line(buffer.replace(/\r$/, '')); dispatch(); break; }
      if (buffer.length > 4000000) throw new Error('单条流式事件过大，已停止读取。');
    }
  } catch(error) {
    if (error instanceof TypeError) throw new Error('流式连接中断或超时，部分回复已保留。请检查网络、服务商或增加超时时间后重试。');
    throw error;
  } finally { reader.releaseLock(); }
  if (!hasText) throw new Error('接口没有返回文本增量，请关闭流式后手动重试。');
  if (!terminal && !finished) throw new Error('流式连接提前中断，部分回复已保留，请重试或跳过。');
}
