import { loginSubscription } from '../codex-provider.js';
await loginSubscription(process.argv.includes('--logout'));
