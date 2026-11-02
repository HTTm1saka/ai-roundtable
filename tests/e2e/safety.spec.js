import { test,expect } from '@playwright/test';

test('空记录、新建重命名、删除确认与多标签页锁',async({page,context})=>{
  await page.goto('/');await expect(page.locator('#sessions button')).toHaveCount(1);await expect(page.locator('.welcome')).toBeVisible();
  const second=await context.newPage();await second.goto('/');await expect(second.locator('#fatal')).toContainText('另一个标签页');await second.close();
  await page.locator('#new-session').click();await expect(page.locator('#sessions button')).toHaveCount(2);
  page.once('dialog',d=>d.accept('自己的研究室'));await page.locator('#rename-session').click();await expect(page.locator('#session-title')).toHaveText('自己的研究室');
  page.once('dialog',d=>d.dismiss());await page.locator('#delete-session').click();await expect(page.locator('#sessions button')).toHaveCount(2);
  page.once('dialog',d=>d.accept());await page.locator('#delete-session').click();await expect(page.locator('#sessions button')).toHaveCount(1);
});

test('浏览器读取失败明确阻断，不写空记录覆盖',async({page})=>{
  await page.addInitScript(()=>{
    IDBObjectStore.prototype.get=function(){throw new Error('测试：读取失败');};
    const original=IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put=function(...args){window.ACCIDENTAL_WRITE=true;return original.apply(this,args);};
  });
  await page.goto('/');await expect(page.locator('#fatal')).toContainText('读取失败');
  expect(await page.evaluate(()=>window.ACCIDENTAL_WRITE)).toBeUndefined();
});

test('浏览器写入失败提示，仍可导出内存记录',async({page})=>{
  await page.goto('/');await expect(page.locator('.welcome')).toBeVisible();
  await page.evaluate(()=>{IDBObjectStore.prototype.put=function(){throw new DOMException('Quota exceeded','QuotaExceededError');};});
  await page.locator('#message-input').fill('保存失败时这条消息仍在内存');await page.locator('#send-message').click();
  await expect(page.locator('#save-state')).toContainText('保存失败');await expect(page.locator('#toast')).toContainText('保存失败');
  const downloaded=page.waitForEvent('download');await page.locator('#export-json').click();const d=await downloaded;
  const fs=await import('node:fs/promises');expect(await fs.readFile(await d.path(),'utf8')).toContain('保存失败时这条消息仍在内存');
});
