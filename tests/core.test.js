import test from 'node:test';
import assert from 'node:assert/strict';
import { profile,session,nextSpeaker,advance,reconcile,context,snapshot,validateBackup,importBackup,recover,endpoint } from '../public/core.js';
import { Engine } from '../public/engine.js';

function setup(request) {
  const ps = [profile('A','分析'),profile('B','质疑')]; ps.forEach((p,i) => { p.model = `model-${i}`; });
  const s = session(ps); s.topic = '如何学习？'; s.targetRounds = 2;
  let saves = 0;
  const engine = new Engine({save:async () => { saves++; },change:() => {},request});
  return {s,engine,get saves(){return saves;}};
}
test('Base URL 根路径、完整端点与尾斜线只拼接一次', () => {
  assert.equal(endpoint('https://example.com/v1/'),'https://example.com/v1/chat/completions');
  assert.equal(endpoint('http://localhost:11434/v1/chat/completions/'),'http://localhost:11434/v1/chat/completions');
  assert.equal(endpoint('https://example.com/custom'),'https://example.com/custom/chat/completions');
  for (const bad of ['abc','ftp://example.com','https://user:secret@example.com','https://x.test/v1?key=secret']) assert.throws(() => endpoint(bad));
});
test('不同模型按序发言，达到轮数停止，重复启动被拒绝', async () => {
  const calls = []; const {s,engine} = setup(async (p,m,o) => { calls.push(p.model); o.onDelta('完整回答'); await new Promise(r => setTimeout(r,5)); });
  const run = engine.start(s); await assert.rejects(engine.start(s),/已有 AI/); await run;
  assert.deepEqual(calls,['model-0','model-1','model-0','model-1']);
  assert.equal(s.completedRounds,2); assert.equal(s.status,'completed');
  assert.ok(s.messages.every(m => m.status === 'complete'));
});
test('中途人类插话立即进入下一位 AI 上下文，轮数不重置', async () => {
  const calls = []; let release; const gate = new Promise(r => release=r);
  const {s,engine} = setup(async(p,m,o) => { calls.push(m); if(calls.length===1) await gate; o.onDelta('答复'); });
  const run = engine.start(s); await new Promise(r => setTimeout(r,0));
  s.messages.push({id:'human',type:'human',speaker:'我',content:'中途新增观点',time:new Date().toISOString(),status:'complete'});
  release(); await run;
  assert.ok(calls[1].some(m => m.content.includes('中途新增观点'))); assert.equal(s.completedRounds,2);
});
test('暂停完成当前回复，继续保留顺序；停止取消请求且不计成功', async () => {
  let release; let calls = 0; const gate = new Promise(r => release=r);
  const {s,engine} = setup(async(p,m,o) => { calls++; if(calls===1) await gate; o.onDelta('回复'); });
  const run = engine.start(s); await new Promise(r => setTimeout(r,0)); engine.pause(s); release(); await run;
  assert.equal(calls,1); assert.equal(s.status,'paused'); assert.equal(nextSpeaker(s).name,'B');
  await engine.start(s); assert.equal(s.completedRounds,2);
  const other = setup(async(p,m,o) => { o.onDelta('部分'); await new Promise((r,j) => o.signal.addEventListener('abort',()=>j(new DOMException('aborted','AbortError')))); });
  const r = other.engine.start(other.s); await new Promise(r => setTimeout(r,0)); other.engine.stop(other.s); await r;
  assert.equal(other.s.status,'stopped'); assert.equal(other.s.completedRounds,0); assert.equal(other.s.resolved.length,0);
  assert.equal(other.s.messages[0].status,'interrupted'); assert.equal(other.s.messages[0].content,'部分');
});
test('失败暂停，不自动重试；重试仍为当前 AI；跳过继续下一位', async () => {
  let fail = true; const calls = []; const {s,engine} = setup(async(p,m,o) => {
    calls.push(p.name); o.onDelta('部分'); if(fail) { fail=false; throw new Error('限流'); }
  });
  await engine.start(s); assert.equal(s.status,'paused'); assert.equal(calls.length,1); assert.equal(s.messages[0].status,'failed');
  await engine.start(s,{retry:true}); assert.deepEqual(calls.slice(0,3),['A','A','B']); assert.equal(s.completedRounds,2);
  const skip = setup(async(p,m,o) => { if(p.name==='A') throw new Error('失败'); o.onDelta('成功'); });
  skip.s.targetRounds=1; await skip.engine.start(skip.s); await skip.engine.skip(skip.s);
  assert.equal(skip.s.status,'completed'); assert.equal(skip.s.messages.filter(m=>m.status==='complete').length,1);
  assert.ok(skip.s.messages.some(m=>m.status==='skipped'));
});
test('上下文辨认说话者，限定受支持角色，排除失败回复并截断旧消息', () => {
  const {s} = setup(); s.contextLimit=1000;
  s.messages = [
    {type:'human',speaker:'我',content:'旧消息'.repeat(600),status:'complete'},
    {type:'ai',aiId:s.participants[0].id,speaker:'A',content:'A 的观点',status:'complete'},
    {type:'ai',aiId:s.participants[1].id,speaker:'B',content:'B 的观点',status:'complete'},
    {type:'ai',speaker:'A',content:'不要读取失败内容',status:'failed'},
    {type:'human',speaker:'我',content:'最新消息',status:'complete'} ];
  const ctx = context(s,s.participants[0]);
  assert.ok(ctx.truncated); assert.ok(ctx.messages.every(m=>['user','system','assistant'].includes(m.role)));
  assert.ok(ctx.messages.some(m=>m.role==='assistant'&&m.content.includes('A 的观点')));
  assert.ok(ctx.messages.some(m=>m.role==='user'&&m.content.includes('B 的观点')));
  assert.ok(ctx.messages.some(m=>m.content.includes(s.topic)));
  assert.ok(!ctx.messages.some(m=>m.content.includes('不要读取失败内容')));
  assert.ok(ctx.messages.reduce((n,m)=>n+m.content.length,0)<=s.contextLimit);
  s.topic='长'.repeat(1200); assert.throws(()=>context(s,s.participants[0]),/上限/);
});
test('临时密钥不落盘，备份排除所有密钥；导入保留原会话并重映射 ID', () => {
  const {s} = setup(); s.participants[0].key='SECRET-TEMP'; s.participants[1].key='SECRET-REMEMBER'; s.participants[1].remember=true;
  const state={version:1,profiles:structuredClone(s.participants),sessions:[s],activeId:s.id};
  const disk=JSON.stringify(snapshot(state)); assert.ok(!disk.includes('SECRET-TEMP')); assert.ok(disk.includes('SECRET-REMEMBER'));
  const backup=snapshot(state,true); assert.ok(!JSON.stringify(backup).includes('SECRET'));
  validateBackup(backup); const original=s.id; assert.equal(importBackup(state,backup),1);
  assert.equal(state.sessions[0].id,original); assert.notEqual(state.sessions[1].id,original);
  assert.notEqual(state.sessions[1].participants[0].id,s.participants[0].id);
  assert.throws(()=>importBackup(state,{version:2,sessions:[]}),/格式/); assert.equal(state.sessions.length,2);
});
test('刷新恢复将生成标为中断，保存游标但从不调用 API', () => {
  const {s} = setup(); s.status='running'; nextSpeaker(s);
  s.messages.push({id:'m',type:'ai',aiId:s.participants[0].id,speaker:'A',content:'部分',time:new Date().toISOString(),status:'generating'});
  const recovered=recover({sessions:[s]}); assert.equal(recovered.sessions[0].status,'paused');
  assert.equal(s.messages[0].status,'interrupted'); assert.equal(nextSpeaker(s).name,'A'); assert.ok(s.failure);
});
test('暂停后修改参与者保留已经处理者，新顺序生效', () => {
  const {s} = setup(); nextSpeaker(s); advance(s,s.participants[0].id);
  const b=s.participants[1]; const c=profile('C'); s.participants=[b,c,s.participants[0]]; reconcile(s);
  assert.equal(nextSpeaker(s).name,'B'); advance(s,b.id); assert.equal(nextSpeaker(s).name,'C');
  advance(s,c.id); assert.equal(s.completedRounds,1);
});
test('保存失败阻止发起 API，并保留错误状态', async () => {
  const {s} = setup(); let calls=0;
  const engine=new Engine({save:async()=>{throw new Error('保存失败');},change:()=>{},request:async()=>calls++});
  await engine.start(s); assert.equal(calls,0); assert.equal(s.status,'paused'); assert.match(s.failure.message,/保存失败/);
});
