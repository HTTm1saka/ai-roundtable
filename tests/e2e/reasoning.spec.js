import { test, expect } from '@playwright/test';

for (const provider of ['api', 'chatgpt']) {
  test(`${provider} 思考程度：独立设置、测试连接、刷新恢复、切换和备份`, async ({ page }) => {
    const requests = [];
    await page.route('**/api/chat', async route => {
      requests.push(route.request().postDataJSON());
      await route.fulfill({ json: { choices: [{ message: { content: '连接成功' }, finish_reason: 'stop' }] } });
    });
    await page.goto('/');
    const edit = () => page.locator('.participant').first().getByRole('button', { name: /编辑/ }).click();
    await edit();
    await page.locator('[name=provider]').selectOption(provider);
    if (provider === 'api') await page.locator('[name=model]').fill('reasoning-model');
    const effort = page.getByRole('combobox', { name: '思考程度', exact: true });
    await expect(effort).toHaveValue('default');
    await effort.selectOption(provider === 'api' ? 'none' : 'ultra');
    await page.locator('[name=provider]').selectOption(provider === 'api' ? 'chatgpt' : 'api');
    await expect(effort).toHaveValue('default');
    await page.locator('[name=provider]').selectOption(provider);
    await effort.selectOption('high');
    await page.getByRole('button', { name: '测试连接' }).click();
    await expect(page.locator('#test-result')).toContainText('连接成功');
    expect(requests[0].reasoningEffort).toBe('high'); expect(requests[0].provider).toBe(provider);
    await page.getByRole('button', { name: '保存 AI' }).click();
    await expect(page.locator('.participant').first()).toContainText('思考：高');
    await expect(page.locator('.participant').nth(1)).not.toContainText('思考：高');
    await expect(page.locator('#save-state')).toHaveText('本地已保存');
    await page.reload(); await edit(); await expect(effort).toHaveValue('high');
    await effort.selectOption('default');
    await page.getByRole('button', { name: '测试连接' }).click();
    await expect(page.locator('#test-result')).toContainText('连接成功');
    expect(requests.at(-1).reasoningEffort).toBe('default');
    await page.locator('#close-ai').click();
    const downloadEvent = page.waitForEvent('download'); await page.locator('#export-json').click();
    const download = await downloadEvent;
    const fs = await import('node:fs/promises');
    const backup = JSON.parse(await fs.readFile(await download.path(), 'utf8'));
    expect(backup.sessions[0].participants[0].reasoningEffort).toBe('high');
    await page.locator('#import-file').setInputFiles({ name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) });
    await expect(page.locator('#sessions button')).toHaveCount(2);
  });
}
