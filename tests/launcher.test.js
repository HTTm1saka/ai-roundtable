import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const exec = promisify(execFile);
const launcher = fileURLToPath(new URL('../scripts/launch.js', import.meta.url));

test('启动器从项目目录以外检查依赖，并拒绝未知操作', async () => {
  const { stdout } = await exec(process.execPath, [launcher, 'check'], { cwd: tmpdir(), windowsHide: true });
  assert.match(stdout, /Ready:/);
  await assert.rejects(exec(process.execPath, [launcher, 'unknown'], { cwd: tmpdir(), windowsHide: true }), error => error.code === 1 && /Usage:/.test(error.stderr));
});

test('通用启动器从外部工作目录启动真实服务', { timeout: 20000 }, async t => {
  const child = spawn(process.execPath, [launcher, 'start'], {
    cwd: tmpdir(), env: { ...process.env, PORT: '0' }, windowsHide: true
  });
  t.after(async () => {
    if (process.platform === 'win32') await exec('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true }).catch(() => {});
    else child.kill('SIGTERM');
  });
  const url = await new Promise((resolve, reject) => {
    let output = '', errors = '';
    child.stderr.on('data', data => errors += data);
    child.on('error', reject);
    child.on('exit', code => reject(new Error(`Startup exited (${code}): ${errors}`)));
    child.stdout.on('data', data => {
      output += data;
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) resolve(match[0]);
    });
  });
  const page = await fetch(url);
  assert.equal(page.status, 200); assert.match(await page.text(), /思考程度/);
  assert.equal((await fetch(url + '/vendor/marked.js')).status, 200);
  assert.equal((await fetch(url + '/vendor/purify.js')).status, 200);
});
