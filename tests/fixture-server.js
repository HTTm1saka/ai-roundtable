// 测试专用可控上游；生产入口和界面不会引用此文件。
import http from 'node:http';
let calls=[], failures=new Set();
http.createServer(async(req,res)=>{
  if(req.url==='/health'){res.end('ok');return;}
  if(req.url==='/reset'){calls=[];failures.clear();res.end('ok');return;}
  if(req.url==='/inspect'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(calls));return;}
  let body='';for await(const chunk of req)body+=chunk.toString();
  const data=JSON.parse(body);calls.push({url:req.url,...data});
  if(data.model==='fail-once'&&!failures.has(data.model)) {failures.add(data.model);res.writeHead(429,{'Content-Type':'application/json'}).end(JSON.stringify({error:'RAW-SECRET-SHOULD-NOT-LEAK'}));return;}
  if(data.model==='fail-always'){res.writeHead(404,{'Content-Type':'application/json'}).end('{}');return;}
  const text=`${data.model}：已收到讨论。 **观点**\n\n\`\`\`js\nconsole.log("安全代码");\n\`\`\`\n<script>window.XSS_EXECUTED=true</script>`;
  if(!data.stream){res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({choices:[{message:{content:text},finish_reason:'stop'}]}));return;}
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  const pieces=[`${data.model}：`, '已收到讨论。 ', '**观点**\n\n', '```js\nconsole.log("安全代码");\n```\n', '<script>window.XSS_EXECUTED=true</script>'];
  let i=0;const timer=setInterval(()=>{
    if(i<pieces.length)res.write(`data: ${JSON.stringify({choices:[{delta:{content:pieces[i++]},finish_reason:null}]})}\n\n`);
    else {res.end('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');clearInterval(timer);}
  },data.model==='slow'?250:40);
  res.on('close',()=>clearInterval(timer));
}).listen(4321,'127.0.0.1');
