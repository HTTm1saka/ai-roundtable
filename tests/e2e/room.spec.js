import { test, expect } from '@playwright/test';

async function configure(page, index, {name, model, remember=false, base='http://127.0.0.1:4321/v1', stream=true}={}) {
  await page.locator('.participant').nth(index).getByRole('button',{name:/编辑/}).click();
  const form=page.locator('#ai-form');
  await form.locator('[name=name]').fill(name || `参与者${index+1}`);
  await form.locator('[name=role]').fill(index ? '质疑假设并给出具体改进' : '分析问题并提出建议');
  await form.locator('[name=base]').fill(base);
  await form.locator('[name=model]').fill(model || `model-${index}`);
  await form.locator('[name=key]').fill(remember?'REMEMBER-SECRET':'TEMP-SECRET');
  await form.locator('[name=remember]').selectOption(remember?'yes':'no');
  await form.locator('[name=stream]').setChecked(stream);
  await form.getByRole('button',{name:'保存 AI'}).click();
  await expect(page.locator('#ai-dialog')).not.toBeVisible();
}
async function setup(page,request,first='slow',second='beta') {
  await request.get('http://127.0.0.1:4321/reset');await page.goto('/');
  await expect(page.locator('.participant')).toHaveCount(2);
  await configure(page,0,{name:'分析师',model:first});
  await configure(page,1,{name:'质疑者',model:second,base:'http://127.0.0.1:4321/provider-b/v1'});
}
async function topic(page, rounds=1) {
  await page.locator('#rounds').fill(String(rounds));await page.locator('#rounds').blur();
  await page.locator('#message-input').fill('怎样设计值得信任的 AI 工具？');
  await page.locator('#send-message').click();await page.locator('#start').click();
}
async function calls(request) {return (await request.get('http://127.0.0.1:4321/inspect')).json();}
test('顺序、多服务路径、人类插话、自动停止、安全 Markdown 与追加轮数',async({page,request})=>{
  await setup(page,request);await topic(page,2);
  await expect(page.locator('#active-speaker')).toContainText('分析师 正在发言');
  await expect(page.locator('#add-ai')).toBeDisabled();
  await page.locator('#message-input').fill('中途插话：请考虑离线使用。');await page.locator('#send-message').click();
  await expect(page.locator('#discussion-status')).toHaveText('本次讨论结束',{timeout:15000});
  const log=await calls(request);expect(log.map(c=>c.model)).toEqual(['slow','beta','slow','beta']);
  expect(log[1].url).toBe('/provider-b/v1/chat/completions');
  expect(log[1].messages.some(m=>m.content.includes('中途插话'))).toBeTruthy();
  expect(log[1].messages.every(m=>['system','user','assistant'].includes(m.role))).toBeTruthy();
  await expect(page.locator('.message')).toHaveCount(6);await expect(page.locator('.message pre')).toHaveCount(4);
  expect(await page.evaluate(()=>window.XSS_EXECUTED)).toBeUndefined();await expect(page.locator('.message script')).toHaveCount(0);
  await page.locator('#message-input').fill('结束后的评论');await page.locator('#send-message').click();
  expect((await calls(request)).length).toBe(4);
  await page.locator('#append').click();await expect(page.locator('#round-total')).toHaveText('3');await expect(page.locator('#discussion-status')).toHaveText('本次讨论结束',{timeout:10000});
  expect((await calls(request)).length).toBe(6);await expect(page.locator('#round-total')).toHaveText('3');
});
test('暂停完成当前回复，修改顺序、继续、停止保留部分回复',async({page,request})=>{
  await setup(page,request);await topic(page,3);
  await expect(page.locator('#active-speaker')).toContainText('分析师 正在发言');await page.locator('#pause').click();
  await expect(page.locator('#discussion-status')).toHaveText('已暂停',{timeout:10000});
  expect((await calls(request)).length).toBe(1);await expect(page.locator('#add-ai')).toBeEnabled();
  await page.locator('.participant').nth(1).getByRole('button',{name:'上移'}).click();
  await page.locator('#resume').click();
  await expect(page.locator('#round-current')).toHaveText('2',{timeout:10000});
  await expect(page.locator('#active-speaker')).toContainText('分析师 正在发言',{timeout:10000});
  await expect(page.locator('.message-status.generating')).toBeVisible();await page.locator('#stop').click();
  await expect(page.locator('#discussion-status')).toHaveText('已停止');
  await expect(page.locator('.message-status.interrupted')).toHaveCount(1);
  await expect(page.locator('#round-current')).toHaveText('2');
});
test('失败后手动重试或跳过，无无限重试，支持非流式',async({page,request})=>{
  await setup(page,request,'fail-once','beta');await configure(page,1,{name:'质疑者',model:'beta',stream:false});await topic(page);
  await expect(page.locator('#error-message')).toContainText('限流');expect((await calls(request)).length).toBe(1);
  await page.locator('#retry').click();await expect(page.locator('#discussion-status')).toHaveText('本次讨论结束');
  expect((await calls(request)).map(c=>c.model)).toEqual(['fail-once','fail-once','beta']);
  await configure(page,0,{name:'分析师',model:'fail-always'});await page.locator('#append').click();
  await expect(page.locator('#error-message')).toContainText('模型或接口');await page.locator('#skip').click();
  await expect(page.locator('#discussion-status')).toHaveText('本次讨论结束');await expect(page.locator('.event')).toContainText('跳过');
});
test('刷新恢复进度，临时密钥不落盘，记住密钥恢复，导入不覆盖',async({page,request})=>{
  await setup(page,request,'alpha','beta');await configure(page,1,{name:'质疑者',model:'beta',remember:true});await topic(page);
  await expect(page.locator('#discussion-status')).toHaveText('本次讨论结束');await expect(page.locator('#save-state')).toHaveText('本地已保存');
  await page.reload();await expect(page.locator('.message')).toHaveCount(3);await expect(page.locator('#discussion-status')).toHaveText('本次讨论结束');expect((await calls(request)).length).toBe(2);
  await page.locator('.participant').nth(0).getByRole('button',{name:/编辑/}).click();await expect(page.locator('[name=key]')).toHaveValue('');await page.locator('#close-ai').click();
  await page.locator('.participant').nth(1).getByRole('button',{name:/编辑/}).click();await expect(page.locator('[name=key]')).toHaveValue('REMEMBER-SECRET');await expect(page.locator('[name=key]')).toHaveAttribute('type','password');await page.locator('#toggle-key').click();await expect(page.locator('[name=key]')).toHaveAttribute('type','text');await page.locator('#close-ai').click();
  const dl=page.waitForEvent('download');await page.locator('#export-json').click();const download=await dl;
  const path=await download.path();const fs=await import('node:fs/promises');const text=await fs.readFile(path,'utf8');expect(text).not.toContain('REMEMBER-SECRET');expect(text).not.toContain('TEMP-SECRET');
  await page.locator('#import-file').setInputFiles({name:'backup.json',mimeType:'application/json',buffer:Buffer.from(text)});await expect(page.locator('#sessions button')).toHaveCount(2);
  await page.locator('#import-file').setInputFiles({name:'bad.json',mimeType:'application/json',buffer:Buffer.from('{"version":999}')});await expect(page.locator('#toast')).toContainText('格式无效');await expect(page.locator('#sessions button')).toHaveCount(2);
});
test('切换会话时生成仍归原会话；刷新中断后不自动请求',async({page,request})=>{
  await setup(page,request);await topic(page);await expect(page.locator('#active-speaker')).toContainText('分析师 正在发言');
  await page.locator('#new-session').click();await expect(page.locator('.message')).toHaveCount(0);
  await expect.poll(async()=> (await calls(request)).length).toBe(2);
  await page.locator('#sessions button').filter({hasText:'怎样设计'}).click();await expect(page.locator('#discussion-status')).toHaveText('本次讨论结束');await expect(page.locator('.message')).toHaveCount(3);
  await page.locator('#append').click();await expect(page.locator('#active-speaker')).toContainText('分析师 正在发言');
  page.once('dialog',d=>d.accept());await page.reload();await expect(page.locator('#discussion-status')).toHaveText('已暂停');
  const n=(await calls(request)).length;await expect(page.locator('#error-message')).toContainText('中断');await page.waitForTimeout(1000);expect((await calls(request)).length).toBe(n);
});
test('添加删除角色、连接测试、手机布局及备份文本',async({page,request})=>{
  await setup(page,request,'alpha','beta');await page.locator('#add-ai').click();const form=page.locator('#ai-form');
  await form.locator('[name=name]').fill('总结者');await form.locator('[name=role]').fill('综合所有人观点，明确分歧。');await form.locator('[name=base]').fill('http://127.0.0.1:4321/v1/chat/completions/');await form.locator('[name=model]').fill('gamma');
  await page.locator('#test-connection').click();await expect(page.locator('#test-result')).toContainText('连接成功');await form.getByRole('button',{name:'保存 AI'}).click();await expect(page.locator('.participant')).toHaveCount(3);
  await page.locator('.participant').nth(1).getByRole('button',{name:/移除/}).click();await expect(page.locator('.participant')).toHaveCount(2);await topic(page);await expect(page.locator('#discussion-status')).toHaveText('本次讨论结束');
  expect((await calls(request)).map(c=>c.model)).toEqual(['gamma','alpha','gamma']);
  const dl=page.waitForEvent('download');await page.locator('#export-text').click();expect((await dl).suggestedFilename()).toMatch(/\.txt$/);
  await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
  await page.screenshot({path:'artifacts/mobile.png',fullPage:true});await page.setViewportSize({width:1440,height:1000});await page.locator('.inspector').evaluate(n=>n.scrollTop=0);await page.locator('#toast').evaluate(n=>n.hidden=true);await page.screenshot({path:'artifacts/desktop.png',fullPage:true});
});
