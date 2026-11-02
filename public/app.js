import { uid, now, profile, session, endpoint, snapshot, recover, validateBackup, importBackup, reconcile, reasoningLevels, validReasoningEffort } from './core.js';
import { openDB, readDB, writeDB } from './storage.js';
import { Engine } from './engine.js';
import { chatRequest } from './client.js';

const $ = id => document.getElementById(id);
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
let state, engine, initialized = false, editing = null, testController = null, toastTimer, writeQueue = Promise.resolve(), saveFailed = false;
let renderedSession = null, renderedCount = 0, renderPending = false;
const messageNodes = new Map();
const current = () => state.sessions.find(s => s.id === state.activeId);
const locked = s => engine.busy(s) || ['running','pausing','stopping'].includes(s.status);
const labels = { idle: '尚未开始', running: '讨论进行中', pausing: '完成当前回复后暂停', paused: '已暂停', stopping: '正在停止', stopped: '已停止', completed: '本次讨论结束' };

function toast(text) { $('toast').textContent = text; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 6500); }
function fatal(text) { $('fatal').textContent = text; $('fatal').hidden = false; }
function save() {
  const copy = snapshot(state);
  $('save-state').textContent = '保存中…';
  const task = writeQueue.catch(() => {}).then(() => writeDB(copy));
  writeQueue = task;
  return task.then(() => {
    if (writeQueue === task) { saveFailed = false; $('save-state').textContent = '本地已保存'; }
  }).catch(error => {
    saveFailed = true; $('save-state').textContent = '保存失败 · 请导出'; toast(error.message);
    for (const s of state.sessions) if (s.status === 'running') s.status = 'pausing';
    scheduleRender(); throw error;
  });
}
async function act(fn) { try { await fn(); } catch (error) { toast(error.message || '操作失败，请重试。'); } }
function scheduleRender() {
  if (renderPending) return;
  renderPending = true;
  requestAnimationFrame(() => { renderPending = false; if (initialized) render(); });
}
function humanMessage(s, text) {
  if (!s.topic) { s.topic = text; s.title = text.slice(0, 28); }
  s.messages.push({ id: uid(), type: 'human', speaker: '我', content: text, time: now(), status: 'complete',
    ...(s.messages.length === 0 ? { kind: 'topic' } : {}) });
  s.updatedAt = now();
}
function send() {
  const value = $('message-input').value.trim();
  if (!value) return;
  if (value.length > 2000000) throw new Error('消息过长，请控制在 200 万字符以内。');
  humanMessage(current(), value); $('message-input').value = ''; render(); return save();
}
function renderSidebar() {
  const nav = $('sessions'); nav.replaceChildren();
  $('session-count').textContent = state.sessions.length;
  for (const s of [...state.sessions].sort((a,b) => b.updatedAt.localeCompare(a.updatedAt))) {
    const b = el('button', s.id === state.activeId ? 'selected' : '', s.title);
    b.setAttribute('aria-current', s.id === state.activeId ? 'page' : 'false');
    b.append(el('span', 'session-date', `${new Date(s.updatedAt).toLocaleDateString('zh-CN')} · ${labels[s.status]}`));
    b.onclick = () => act(async () => {
      if ($('ai-dialog').open) $('ai-dialog').close();
      state.activeId = s.id; $('message-input').value = ''; $('sidebar').classList.remove('open'); render(); await save();
    });
    nav.append(b);
  }
}
function renderParticipants(s) {
  const area = $('participants'); area.replaceChildren();
  $('ai-count').textContent = `${s.participants.length} 位`;
  const busy = locked(s);
  s.participants.forEach((p, i) => {
    const card = el('div','participant');
    const top = el('div','participant-top');
    top.append(el('span','participant-number',String(i+1).padStart(2,'0')));
    const info = el('div','participant-info'); info.append(el('strong','',p.name),el('small','',p.provider === 'chatgpt' ? `ChatGPT 订阅 · ${p.model || '默认模型'}` : p.model || '尚未配置模型'));
    top.append(info); card.append(top);
    if (p.reasoningEffort && p.reasoningEffort !== 'default') info.append(el('small', '', `思考：${reasoningLevels[p.reasoningEffort]}`));
    const tools = el('div','participant-tools');
    const actions = [ ['↑', '上移', async () => move(s,i,-1), i === 0], ['↓','下移',async () => move(s,i,1), i === s.participants.length-1],
      ['编辑','编辑 '+p.name,() => openAI(p),false], ['移除','移除 '+p.name,async () => {
        s.participants.splice(i,1); reconcile(s); await changedParticipants(s);
      },false] ];
    for (const [text,label,fn,disabled] of actions) {
      const b = el('button','',text); b.disabled = busy || disabled; b.setAttribute('aria-label',label);
      b.onclick = () => act(async () => { if (locked(s)) throw new Error('请等待当前回复完成并暂停后修改。'); await fn(); }); tools.append(b);
    }
    card.append(tools); area.append(card);
  });
  $('add-ai').disabled = busy;
}
async function move(s,i,d) {
  [s.participants[i],s.participants[i+d]] = [s.participants[i+d],s.participants[i]];
  reconcile(s); await changedParticipants(s);
}
async function changedParticipants(s) {
  state.profiles = structuredClone(s.participants); s.updatedAt = now(); render(); await save();
}
function markdown(text) {
  return DOMPurify.sanitize(marked.parse(text, { breaks: true, gfm: true }), {
    ALLOWED_TAGS: ['p','br','strong','em','del','s','pre','code','blockquote','ul','ol','li','h1','h2','h3','h4','h5','h6','hr','a','table','thead','tbody','tr','th','td'],
    ALLOWED_ATTR: ['href','title'], ALLOW_DATA_ATTR: false
  });
}
function renderMessage(m, parent) {
  if (m.type === 'event') { const event = el('div','event',m.content); parent.append(event); messageNodes.set(m.id,{ root:event, content:m.content, status:m.status }); return; }
  const root = el('article','message'); root.dataset.messageId = m.id;
  const head = el('div','message-head');
  head.append(el('span', 'avatar'+(m.type === 'human' ? ' human' : ''), m.type === 'human' ? '我' : m.speaker.slice(0,1)));
  const identity = el('div'); identity.append(el('div','speaker-name',m.speaker),el('div','message-meta',`${m.type === 'human' ? '人类' : (m.model || 'AI')} · ${new Date(m.time).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})}${m.round ? ` · 第 ${m.round} 轮` : ''}`));
  head.append(identity);
  const copy = el('button','copy-message','复制'); copy.onclick = () => act(async () => { await navigator.clipboard.writeText(m.content); toast('消息已复制'); }); head.append(copy);
  const body = el('div','message-body'); const status = el('div','message-status');
  root.append(head,body,status); parent.append(root);
  messageNodes.set(m.id, { root, body, status, content: null, state: null });
  updateMessage(m);
}
function updateMessage(m) {
  const node = messageNodes.get(m.id); if (!node?.body) return;
  if (node.content !== m.content) {
    node.body.innerHTML = markdown(m.content || (m.status === 'generating' ? '正在思考…' : '（无回复内容）'));
    node.body.querySelectorAll('a').forEach(a => {
      if (!/^https?:\/\//i.test(a.getAttribute('href') || '')) a.removeAttribute('href');
      else { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
    });
    node.content = m.content;
  }
  if (node.state !== m.status) {
    node.status.textContent = ({generating:'● 正在生成',failed:'生成失败 · 部分内容不计入成功发言',interrupted:'已中断 · 部分内容不计入成功发言',complete:''})[m.status] || '';
    node.status.className = `message-status ${m.status}`; node.status.hidden = m.status === 'complete'; node.state = m.status;
  }
}
function renderMessages(s) {
  const area = $('messages'); const switched = renderedSession !== s.id;
  const atBottom = area.scrollHeight - area.scrollTop - area.clientHeight < 100;
  if (switched || renderedCount > s.messages.length || !s.messages.length) {
    area.replaceChildren(); messageNodes.clear(); renderedCount = 0; renderedSession = s.id;
  }
  if (!s.messages.length && !area.firstChild) {
    const welcome = el('div','welcome'); welcome.append(el('div','welcome-mark','✳'),el('h2','', '让不同的观点，\n坐在同一张桌上。'),el('p','', '邀请不同的 AI，以各自的角色展开讨论。\n你既是发起者，也是随时可以加入的参与者。'));
    welcome.append(el('p', '', '第一次使用：先点参与 AI 的“编辑”，配置自己的 API 或 ChatGPT 订阅，再开始讨论。'));
    const suggestions = el('div','suggestions');
    for (const text of ['一个人如何借助 AI 开始自己的小事业？','未来十年，什么能力最值得培养？','让支持者与质疑者讨论我的新想法']) {
      const b = el('button','',text); b.append(el('span','','↗')); b.onclick = () => { $('message-input').value = text; $('message-input').focus(); }; suggestions.append(b);
    }
    welcome.append(suggestions); area.append(welcome);
  }
  if (s.messages.length && area.querySelector('.welcome')) area.replaceChildren();
  for (let i = renderedCount; i < s.messages.length; i++) renderMessage(s.messages[i],area);
  for (const m of s.messages) updateMessage(m);
  renderedCount = s.messages.length;
  if (switched || atBottom) area.scrollTop = area.scrollHeight;
  $('jump-bottom').hidden = area.scrollHeight - area.scrollTop - area.clientHeight < 100;
  $('message-count').textContent = `${s.messages.filter(m => m.type !== 'event').length} 条发言`;
}
function render() {
  const s = current(); if (!s) return;
  renderSidebar(); renderParticipants(s); renderMessages(s);
  $('session-title').textContent = s.title;
  $('discussion-status').textContent = labels[s.status];
  const generating = s.messages.findLast(m => m.status === 'generating');
  const inRound = s.roundOrder.length > 0;
  $('round-current').textContent = s.completedRounds + (inRound && s.completedRounds < s.targetRounds ? 1 : 0);
  $('round-total').textContent = s.targetRounds;
  $('active-speaker').textContent = generating ? `${generating.speaker} 正在发言…` : `已完成 ${s.completedRounds} 轮${s.resolved.length ? ` · 本轮已处理 ${s.resolved.length} 位` : ''}`;
  $('round-progress').style.width = `${Math.min(100,s.completedRounds / s.targetRounds * 100)}%`;
  if (document.activeElement !== $('rounds')) $('rounds').value = s.targetRounds;
  $('rounds').disabled = locked(s) || s.completedRounds > 0 || s.roundOrder.length > 0;
  if (document.activeElement !== $('context-limit')) $('context-limit').value = s.contextLimit;
  if (document.activeElement !== $('timeout')) $('timeout').value = s.timeout;
  $('context-limit').disabled = locked(s); $('timeout').disabled = locked(s);
  $('start').disabled = locked(s) || s.status !== 'idle';
  $('pause').disabled = s.status !== 'running';
  $('resume').disabled = locked(s) || !['paused','stopped'].includes(s.status) || !!s.failure || s.completedRounds >= s.targetRounds;
  $('stop').disabled = !locked(s) && !['paused'].includes(s.status);
  $('append-controls').hidden = s.completedRounds < s.targetRounds;
  $('append').disabled = locked(s);
  $('context-note').hidden = !s.contextTruncated;
  $('error-box').hidden = !s.failure;
  $('error-message').textContent = s.failure?.message || '';
  $('retry').disabled = locked(s); $('skip').disabled = locked(s);
  $('delete-session').disabled = locked(s);
  $('composer-hint').textContent = s.topic ? '你的消息会被下一位 AI 读取' : '先发送话题，再开始讨论';
  $('message-input').placeholder = s.topic ? '加入讨论，说说你的想法…' : '从一个值得讨论的问题开始…';
}
function openAI(p = null) {
  const s = current(); if (locked(s)) throw new Error('请先暂停并等待当前回复完成。');
  if (!p && s.participants.length >= 100) throw new Error('最多支持 100 位参与者。');
  editing = { sessionId: s.id, id: p?.id || null };
  const value = p || profile(); const form = $('ai-form'); form.reset();
  for (const key of ['name','role','base','key','model']) form.elements[key].value = value[key];
  form.elements.remember.value = value.remember ? 'yes' : 'no'; form.elements.stream.checked = value.stream;
  form.elements.provider.value = value.provider || 'api';
  updateProvider(value.reasoningEffort || 'default');
  form.elements.key.type = 'password'; $('toggle-key').textContent = '显示'; $('test-result').textContent = '';
  $('ai-dialog-title').textContent = p ? '编辑 AI' : '添加 AI'; $('ai-dialog').showModal();
}
function updateProvider(selected) {
  const f = $('ai-form').elements, subscription = f.provider.value === 'chatgpt';
  const effort = typeof selected === 'string' ? selected : f.reasoningEffort.value;
  f.reasoningEffort.replaceChildren(...Object.entries(reasoningLevels).filter(([value]) => validReasoningEffort(value, f.provider.value)).map(([value, label]) => {
    const option = el('option', '', label); option.value = value; return option;
  }));
  f.reasoningEffort.value = validReasoningEffort(effort, f.provider.value) ? effort : 'default';
  $('api-settings').hidden = subscription;
  $('subscription-settings').hidden = !subscription;
  $('subscription-model-note').hidden = !subscription;
  for (const key of ['base', 'key', 'remember']) f[key].disabled = subscription;
  f.base.required = !subscription; f.model.required = !subscription;
  f.model.placeholder = subscription ? '留空使用 Codex 默认模型' : '填写服务商提供的准确模型 ID';
  $('test-result').textContent = ''; $('subscription-result').textContent = '';
  testController?.abort();
}
function formProfile() {
  const f = $('ai-form').elements;
  const p = { id: editing.id || uid(), name: f.name.value.trim(), role: f.role.value.trim(), base: f.base.value.trim(),
    provider: f.provider.value, reasoningEffort: f.reasoningEffort.value, key: f.key.value.trim(), model: f.model.value.trim(), remember: f.remember.value === 'yes', stream: f.stream.checked };
  if (p.provider === 'chatgpt') { p.key = ''; p.remember = false; }
  else endpoint(p.base);
  if (!p.name || (p.provider !== 'chatgpt' && !p.model)) throw new Error('请填写 AI 名称和模型名称。');
  if (/[\r\n]/.test(p.key)) throw new Error('API Key 不应包含换行。');
  return p;
}
function download(name,text,type) {
  const url = URL.createObjectURL(new Blob([text],{type})); const a = el('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url),1000);
}
function bind() {
  $('new-session').onclick = () => act(async () => { const s = session(state.profiles); state.sessions.push(s); state.activeId = s.id; $('message-input').value = ''; render(); await save(); });
  $('rename-session').onclick = () => act(async () => { const s = current(); const name = prompt('会话名称',s.title); if (!name?.trim()) return; s.title = name.trim().slice(0,200); render(); await save(); });
  $('delete-session').onclick = () => act(async () => {
    const s = current(); if (locked(s)) throw new Error('请先停止讨论，等待请求结束后删除。');
    if (!confirm(`确定删除「${s.title}」及全部聊天记录？此操作不可撤销。`)) return;
    state.sessions = state.sessions.filter(x => x.id !== s.id);
    if (!state.sessions.length) state.sessions.push(session(state.profiles));
    state.activeId = state.sessions[0].id; render(); await save();
  });
  $('menu-toggle').onclick = () => $('sidebar').classList.toggle('open');
  $('mobile-rename').onclick = () => $('rename-session').click();
  $('mobile-export-text').onclick = () => $('export-text').click();
  $('composer').onsubmit = e => { e.preventDefault(); act(send); };
  $('message-input').onkeydown = e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !e.isComposing) { e.preventDefault(); act(send); } };
  $('start').onclick = () => act(async () => {
    const s = current(); if (!s.topic && $('message-input').value.trim()) await send();
    if (!saveFailed) await engine.start(s); else throw new Error('请先解决保存失败后再开始，以免丢失讨论进度。');
  });
  $('pause').onclick = () => engine.pause(current());
  $('stop').onclick = () => engine.stop(current());
  $('resume').onclick = () => act(() => engine.start(current()));
  $('retry').onclick = () => act(() => engine.start(current(),{retry:true}));
  $('skip').onclick = () => act(() => engine.skip(current()));
  $('append').onclick = () => act(() => {
    const extra = Number($('extra-rounds').value);
    if (!Number.isInteger(extra) || extra < 1 || extra > 10000) throw new Error('追加轮数应为 1–10000 的整数。');
    return engine.start(current(),{extra});
  });
  const setting = (id,key,min,max) => $(id).onchange = () => act(async () => {
    const s = current(); const value = Number($(id).value);
    if (locked(s)) { render(); return; }
    if (!Number.isInteger(value) || value < min || value > max || (key === 'targetRounds' && value < s.completedRounds)) { render(); throw new Error(`请输入 ${min}–${max} 之间的整数。`); }
    s[key] = value; render(); await save();
  });
  setting('rounds','targetRounds',1,10000); setting('context-limit','contextLimit',1000,1000000); setting('timeout','timeout',5,600);
  $('add-ai').onclick = () => act(() => openAI());
  $('ai-form').elements.provider.onchange = updateProvider;
  $('subscription-status').onclick = () => act(async () => {
    const button = $('subscription-status'); button.disabled = true;
    $('subscription-result').textContent = '正在检查…';
    try {
      const response = await fetch('/api/chatgpt/status', { method: 'POST', headers: { 'X-Roundtable': '1' } });
      if (!response.ok) throw new Error('无法检查登录状态，请确认本地服务正在运行。');
      const result = await response.json();
      $('subscription-result').textContent = result.connected ? '已通过 ChatGPT 登录；生成会消耗套餐中的 Codex 额度。' : '尚未登录，请在项目终端运行 npm run login:chatgpt。';
    } finally { button.disabled = false; }
  });
  $('close-ai').onclick = () => $('ai-dialog').close();
  $('ai-dialog').addEventListener('close', () => { testController?.abort(); $('ai-form').elements.key.value = ''; });
  $('toggle-key').onclick = () => { const input = $('ai-form').elements.key; input.type = input.type === 'password' ? 'text' : 'password'; $('toggle-key').textContent = input.type === 'password' ? '显示' : '隐藏'; };
  $('ai-form').onsubmit = e => { e.preventDefault(); act(async () => {
    const s = state.sessions.find(x => x.id === editing.sessionId); if (!s || locked(s)) throw new Error('此会话仍在生成，请等待暂停完成。');
    const p = formProfile(); const index = s.participants.findIndex(x => x.id === p.id);
    if (s.participants.some(x => x.id !== p.id && x.name === p.name)) throw new Error('当前会话已有同名 AI，请使用不同名称以便辨认发言者。');
    if (index < 0) s.participants.push(p); else s.participants[index] = p;
    reconcile(s); await changedParticipants(s); $('ai-dialog').close(); toast('AI 配置已保存');
  }); };
  $('test-connection').onclick = () => act(async () => {
    const p = formProfile(); $('test-connection').disabled = true; $('test-result').className = 'test-result'; $('test-result').textContent = p.provider === 'chatgpt' ? '正在请求 ChatGPT；会消耗套餐中的 Codex 额度…' : '正在请求真实接口；可能产生少量 API 费用…';
    testController = new AbortController();
    try {
      await chatRequest(p,[{role:'system',content:'请简短回答。'},{role:'user',content:'连接测试，请只回复“连接成功”。'}],{signal:testController.signal,timeout:30});
      $('test-result').textContent = '连接成功：接口已返回有效文本回复。';
    } catch(error) {
      $('test-result').className = 'test-result error'; $('test-result').textContent = error.name === 'AbortError' ? '测试已取消。' : error.message;
    } finally { $('test-connection').disabled = false; testController = null; }
  });
  $('export-json').onclick = () => { download(`圆桌备份-${new Date().toISOString().slice(0,10)}.json`,JSON.stringify(snapshot(state,true),null,2),'application/json'); toast('已导出全部会话与配置，备份不包含 API Key。'); };
  $('export-text').onclick = () => {
    const s = current(); const text = `${s.title}\n话题：${s.topic}\n已完成 ${s.completedRounds}/${s.targetRounds} 轮\n\n` + s.messages.map(m => `[${m.time}] ${m.speaker} (${m.type === 'human' ? '人类' : m.type === 'event' ? '事件' : 'AI'} / ${m.status})\n${m.content}`).join('\n\n');
    download(`圆桌聊天-${s.id.slice(0,8)}.txt`,text,'text/plain;charset=utf-8');
  };
  $('import-json').onclick = () => $('import-file').click();
  $('import-file').onchange = () => act(async () => {
    const input = $('import-file'); const file = input.files[0]; input.value = ''; if (!file) return;
    if (file.size > 50 * 1024 * 1024) throw new Error('备份不能超过 50 MB。');
    let data; try { data = JSON.parse(await file.text()); } catch { throw new Error('文件不是有效 JSON；没有导入任何记录。'); }
    const count = importBackup(state,data); render(); await save(); toast(`已导入 ${count} 个会话，原有会话未被覆盖；请重新填写密钥。`);
  });
  $('jump-bottom').onclick = () => { $('messages').scrollTop = $('messages').scrollHeight; $('jump-bottom').hidden = true; };
  $('messages').onscroll = () => { const n = $('messages'); $('jump-bottom').hidden = n.scrollHeight - n.scrollTop - n.clientHeight < 100; };
  window.addEventListener('beforeunload', e => {
    if (saveFailed || [...engine.jobs.values()].length) { e.preventDefault(); e.returnValue = ''; }
  });
}
async function init() {
  try {
    if (!window.marked || !window.DOMPurify) throw new Error('页面依赖未加载。请先运行 npm install，再用本地服务地址打开。');
    await openDB();
    const stored = await readDB();
    if (stored) { validateBackup(stored); state = recover(stored); }
    else {
      const profiles = [profile('探索者','你善于打开思路。提出不同可能性，结合他人的观点给出具体建议。'),profile('审思者','你是务实的批判性思考者。检验假设、指出风险，回应其他参与者并提出改进。')];
      const first = session(profiles); state = {version:1,profiles,sessions:[first],activeId:first.id};
    }
    if (!state.sessions.length) { const s = session(state.profiles); state.sessions.push(s); }
    if (!current()) state.activeId = state.sessions[0].id;
    engine = new Engine({save,change:scheduleRender}); initialized = true; bind(); render(); await save();
  } catch(error) { fatal(`${error.message} 为保护已有记录，应用已停止初始化；请保留浏览器数据，解决问题后刷新。`); }
}
if (!navigator.locks) fatal('此浏览器不支持 Web Locks。请使用最新版 Chrome、Edge 或 Firefox，并通过 localhost 打开。');
else navigator.locks.request('local-ai-roundtable-editor', {ifAvailable:true}, async lock => {
  if (!lock) { fatal('聊天室已在另一个标签页打开。为避免并发覆盖，请关闭另一个标签页后刷新本页。'); return; }
  await init(); await new Promise(() => {});
});
