import { test, expect } from '@playwright/test';

test('切换订阅、检查登录、默认模型保存、刷新恢复与失败暂停', async ({ page }) => {
  await page.route('**/api/chatgpt/status', route => route.fulfill({ json: { connected: false } }));
  await page.route('**/api/chat', async route => {
    const body = route.request().postDataJSON();
    expect(body.provider).toBe('chatgpt'); expect(body.key).toBe(''); expect(body.model).toBe('');
    await route.fulfill({ status: 502, json: { error: 'ChatGPT 订阅额度不足，请稍后手动重试。' } });
  });
  await page.goto('/');
  await page.locator('.participant').nth(1).getByRole('button', { name: /移除/ }).click();
  await page.locator('.participant').getByRole('button', { name: /编辑/ }).click();
  await page.locator('[name=key]').fill('TEMP-SECRET');
  await page.locator('[name=provider]').selectOption('chatgpt');
  await expect(page.locator('#api-settings')).toBeHidden();
  await page.locator('#subscription-status').click();
  await expect(page.locator('#subscription-result')).toContainText('npm run login:chatgpt');
  await page.locator('[name=provider]').selectOption('api');
  await expect(page.locator('#api-settings')).toBeVisible();
  await page.locator('[name=provider]').selectOption('chatgpt');
  await page.getByRole('button', { name: '保存 AI' }).click();
  await expect(page.locator('#ai-dialog')).toBeHidden();
  await expect(page.locator('.participant')).toContainText('ChatGPT 订阅 · 默认模型');
  await expect(page.locator('#save-state')).toHaveText('本地已保存');
  await page.reload();
  await expect(page.locator('.participant')).toContainText('ChatGPT 订阅 · 默认模型');
  await page.locator('#message-input').fill('讨论测试');
  await page.locator('#start').click();
  await expect(page.locator('#discussion-status')).toHaveText('已暂停');
  await expect(page.locator('#error-message')).toContainText('订阅额度不足');
});
