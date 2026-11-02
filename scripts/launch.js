import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const action = process.argv[2] || 'start';
const allowed = ['start', 'login', 'logout', 'check'];

async function dependenciesReady() {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
    for (const name of Object.keys(pkg.dependencies)) {
      const installed = JSON.parse(readFileSync(join(root, 'node_modules', name, 'package.json'), 'utf8'));
      if (installed.version !== lock.packages[`node_modules/${name}`]?.version) return false;
    }
    // The SDK also requires the optional native CLI for this OS and architecture.
    const { Codex } = await import('@openai/codex-sdk');
    new Codex();
    return true;
  } catch { return false; }
}

function installDependencies() {
  const args = ['ci', '--omit=dev', '--include=optional'];
  const bundledNpm = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const options = { cwd: root, stdio: 'inherit', windowsHide: true };
  if (existsSync(bundledNpm)) return spawnSync(process.execPath, [bundledNpm, ...args], options);
  if (process.platform === 'win32') return spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm.cmd ci --omit=dev --include=optional'], options);
  return spawnSync('npm', args, options);
}

async function main() {
  if (Number(process.versions.node.split('.')[0]) < 22) {
    throw new Error('Node.js 22 or newer is required. Install it from https://nodejs.org/ and reopen your terminal.');
  }
  if (!allowed.includes(action)) throw new Error('Usage: node scripts/launch.js [start|login|logout|check]');
  if (!(await dependenciesReady())) {
    console.log('Installing required packages (first run or dependencies changed). Internet access is required.');
    const result = installDependencies();
    if (result.error || result.status !== 0) throw new Error('Dependency installation failed. Check your network and npm installation, then try again.');
    // Validate in a new process so resolution caches from before installation are discarded.
    const checked = spawnSync(process.execPath, [fileURLToPath(import.meta.url), 'check'], {
      cwd: root, stdio: 'inherit', windowsHide: true, env: { ...process.env, ROUNDTABLE_INSTALL_ATTEMPTED: '1' }
    });
    if (checked.error || checked.status !== 0) throw new Error('Dependency verification failed. Install the optional Codex package for your OS and architecture.');
    if (action === 'check') return;
  }
  if (action === 'check') { console.log('Ready: Node.js and required packages are available.'); return; }
  const args = action === 'start' ? ['server.js'] : ['scripts/chatgpt-login.js', ...(action === 'logout' ? ['--logout'] : [])];
  const child = spawn(process.execPath, args, { cwd: root, stdio: 'inherit', windowsHide: true });
  const stop = signal => { if (!child.killed) child.kill(signal); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  child.on('error', () => { console.error('Unable to start. Check your Node.js installation.'); process.exitCode = 1; });
  child.on('exit', (code, signal) => {
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 1);
  });
}

// Do not repeatedly reinstall when an unsupported platform cannot supply a CLI binary.
if (process.env.ROUNDTABLE_INSTALL_ATTEMPTED === '1' && !(await dependenciesReady())) {
  console.error('Required packages or the native Codex CLI are unavailable after installation.');
  process.exitCode = 1;
} else {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
