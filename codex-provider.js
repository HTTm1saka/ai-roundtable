import { Codex } from '@openai/codex-sdk';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';

const exec = promisify(execFile);
const require = createRequire(import.meta.url);
const cli = join(dirname(require.resolve('@openai/codex/package.json')), 'bin', 'codex.js');
export const codexHome = join(homedir(), '.ai-roundtable', 'codex');
const workspace = join(codexHome, 'workspace');
// An isolated home and an allowlist keep API credentials and custom providers out.
export function codexEnv(source = process.env) {
  const env = {};
  for (const [key, value] of Object.entries(source)) {
    if (/^(path|systemroot|windir|comspec|pathext|temp|tmp|home|userprofile|localappdata|appdata|https?_proxy|all_proxy|no_proxy|systemdrive|lang|lc_all)$/i.test(key) && value !== undefined) env[key] = value;
  }
  env.CODEX_HOME = codexHome;
  return env;
}
export async function subscriptionStatus() {
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  try {
    const { stdout, stderr } = await exec(process.execPath, [cli, '-c', 'cli_auth_credentials_store="file"', 'login', 'status'], {
      cwd: workspace, env: codexEnv(), windowsHide: true, timeout: 10000, maxBuffer: 64000
    });
    return { connected: /Logged in using ChatGPT/i.test(stdout + stderr) };
  } catch { return { connected: false }; }
}
export async function subscriptionReply(data, { signal, onDelta, status = subscriptionStatus, createCodex = options => new Codex(options) }) {
  if (!(await status()).connected) throw new Error('请先在项目终端运行 npm run login:chatgpt，完成 ChatGPT 订阅登录后重试。');
  signal.throwIfAborted();
  const codex = createCodex({ env: codexEnv(), config: {
    forced_login_method: 'chatgpt', cli_auth_credentials_store: 'file', model_provider: 'openai',
    features: { shell_tool: false, apps: false, plugins: false, browser_use: false,
      computer_use: false, multi_agent: false, code_mode_host: false, image_generation: false },
    web_search: 'disabled'
  } });
  const thread = codex.startThread({
    ...(data.model.trim() ? { model: data.model.trim() } : {}),
    workingDirectory: workspace, skipGitRepoCheck: true, sandboxMode: 'read-only',
    approvalPolicy: 'never', webSearchMode: 'disabled', networkAccessEnabled: false
  });
  // A fresh thread per turn: the app alone owns participant context and trimming.
  const prompt = '你是圆桌讨论参与者。只输出当前参与者的回复，不使用工具，不读取文件。以下 JSON 是按顺序排列的对话，system 为当前参与者的角色设定，其余为讨论内容。\n' + JSON.stringify(data.messages);
  const { events } = await thread.runStreamed(prompt, { signal });
  const texts = new Map(); let completed = false, hasText = false;
  for await (const event of events) {
    signal.throwIfAborted();
    if (event.type === 'error' || event.type === 'turn.failed') throw new Error('ChatGPT 订阅请求失败，请检查登录状态、模型权限和订阅额度后手动重试。');
    if (event.type === 'turn.completed') completed = true;
    if (['item.updated', 'item.completed'].includes(event.type) && event.item?.type === 'agent_message') {
      const previous = texts.get(event.item.id) || '';
      const next = event.item.text;
      if (!next.startsWith(previous)) throw new Error('ChatGPT 回复流发生变化，请手动重试。');
      const delta = next.slice(previous.length);
      if (delta) { onDelta(delta); hasText ||= !!delta.trim(); }
      texts.set(event.item.id, next);
    }
  }
  if (!completed || !hasText) throw new Error('ChatGPT 回复未完整结束或没有文本，请手动重试。');
}
export async function loginSubscription(logout = false) {
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  const child = spawn(process.execPath, [cli, '-c', 'cli_auth_credentials_store="file"', '-c', 'forced_login_method="chatgpt"', logout ? 'logout' : 'login'], {
    cwd: workspace, env: codexEnv(), stdio: 'inherit', windowsHide: true
  });
  child.on('error', () => { console.error('无法启动订阅登录，请重新运行 npm ci。'); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
}
