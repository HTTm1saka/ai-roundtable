import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createServer } from '../server.js';
import { chatRequest } from '../public/client.js';

test('真实 HTTP 代理：鉴权、路径、JSON/SSE、取消、安全错误与跨站拦截', async t => {
  const captured=[]; let aborted=false;
  const upstream=http.createServer(async(req,res)=>{
    let raw=''; for await(const chunk of req) raw+=chunk; const data=JSON.parse(raw);
    captured.push({url:req.url,auth:req.headers.authorization,data});
    if(data.model==='no-headers') return;
    if(data.model==='bad'){res.writeHead(401,{'Content-Type':'application/json'}).end(JSON.stringify({error:'SECRET-TEMP provider raw body'}));return;}
    if(data.model==='slow') {res.on('close',()=>aborted=true);res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('data: {"choices":[{"delta":{"content":"部分"}}]}\n\n');return;}
    if(data.stream){res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: {"choices":[{"delta":{"content":"中文回复"},"finish_reason":null}]}\r\n\r\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');}
    else {res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({choices:[{message:{content:'非流式中文'},finish_reason:'stop'}]}));}
  });
  upstream.listen(0,'127.0.0.1'); await once(upstream,'listening');
  const proxy=createServer();proxy.listen(0,'127.0.0.1');await once(proxy,'listening');
  t.after(()=>{proxy.closeAllConnections();upstream.closeAllConnections();proxy.close();upstream.close();});
  const base=`http://127.0.0.1:${upstream.address().port}/v1/`; const url=`http://127.0.0.1:${proxy.address().port}/api/chat`;
  const body={base,model:'one',key:'SECRET-TEMP',stream:false,timeout:5,messages:[{role:'user',content:'话题中文'}]};
  const send=(data=body,headers={})=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json','X-Roundtable':'1',...headers},body:JSON.stringify(data)});
  let r=await send();assert.equal(r.status,200);assert.equal((await r.json()).choices[0].message.content,'非流式中文');
  assert.equal(captured[0].url,'/v1/chat/completions');assert.equal(captured[0].auth,'Bearer SECRET-TEMP');assert.equal(captured[0].data.messages[0].content,'话题中文');
  assert.ok(!Object.hasOwn(captured[0].data,'reasoning_effort'));
  for (const effort of ['default','none','minimal','low','medium','high','xhigh','max']) {
    r=await send({...body,reasoningEffort:effort});assert.equal(r.status,200);await r.arrayBuffer();
    assert.equal(captured.at(-1).data.reasoning_effort,effort==='default'?undefined:effort);
  }
  const beforeInvalid=captured.length;
  for (const effort of ['ultra','invalid',null,['high'],42]) {
    r=await send({...body,reasoningEffort:effort});assert.equal(r.status,400);
  }
  assert.equal(captured.length,beforeInvalid);
  r=await send({...body,stream:true});assert.match(await r.text(),/\[DONE\]/);
  r=await send({...body,model:'bad'});const error=await r.text();assert.equal(r.status,401);assert.ok(!error.includes('SECRET'));assert.match(error,/认证/);
  r=await send(body,{Origin:'https://evil.example'});assert.equal(r.status,403);
  r=await send({...body,messages:[{role:'other-ai',content:'x'}]});assert.equal(r.status,400);
  r=await send({...body,base:'https://user:SECRET@example.com'});assert.equal(r.status,400);assert.ok(!(await r.text()).includes('SECRET'));
  const controller=new AbortController();r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json','X-Roundtable':'1'},body:JSON.stringify({...body,stream:true,model:'slow'}),signal:controller.signal});
  await r.body.getReader().read();controller.abort();await new Promise(r=>setTimeout(r,100));assert.ok(aborted);
  const [beforeHeaders,afterHeaders]=await Promise.all([send({...body,model:'no-headers'}),send({...body,model:'slow',stream:true}).then(async r=>({status:r.status,text:await r.text()}))]);
  assert.equal(beforeHeaders.status,504);assert.match(await beforeHeaders.text(),/超时/);
  assert.equal(afterHeaders.status,200);assert.match(afterHeaders.text,/timeout/);assert.ok(!afterHeaders.text.includes('SECRET'));
  assert.equal((await fetch(url.replace('/api/chat','/'))).status,200);
  assert.equal((await fetch(url.replace('/api/chat','/server.js'))).status,404);
});

test('客户端 SSE 支持分片 UTF-8、CRLF、多行 data、终止和错误标记', async t => {
  const original=globalThis.fetch;t.after(()=>globalThis.fetch=original);
  const fixtures=[
    ['data: {"choices":\r\ndata: [{"delta":{"content":"中文"}}]}\r\n\r\ndata: [DONE]\r\n\r\n',null],
    ['data: {"choices":[{"delta":{"content":"部分"}}]}\n\n','提前中断'],
    ['data: {"choices":[{"delta":{"content":"截断"},"finish_reason":"length"}]}\n\n','未完整结束'],
    ['data: {"error":{"message":"SECRET"}}\n\n','服务商'],
    ['data: {"error":{"code":"timeout"}}\n\n','超时'],
    ['data: nope\n\n','格式不兼容'] ];
  for(const [data,expected] of fixtures) {
    const bytes=new TextEncoder().encode(data);
    globalThis.fetch=async()=>new Response(new ReadableStream({start(c){for(const b of bytes)c.enqueue(new Uint8Array([b]));c.close();}}),{headers:{'Content-Type':'text/event-stream'}});
    let content=''; const request=chatRequest({base:'http://x/v1',key:'',model:'test',stream:true},[],{onDelta:d=>content+=d});
    if(expected) await assert.rejects(request,new RegExp(expected));else {await request;assert.equal(content,'中文');}
  }
});
