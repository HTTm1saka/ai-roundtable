import { nextSpeaker, advance, context, endpoint, uid, now } from './core.js';
import { chatRequest } from './client.js';

export class Engine {
  constructor({ save, change, request = chatRequest }) {
    this.save = save; this.change = change; this.request = request; this.jobs = new Map();
  }
  busy(s) { return this.jobs.has(s.id); }
  async start(s, { retry = false, extra = 0 } = {}) {
    if (this.busy(s)) throw new Error('此会话已有 AI 正在生成，请等待。');
    if (!s.topic.trim()) throw new Error('请先输入并发送讨论话题。');
    if (!s.participants.length) throw new Error('请至少添加一位 AI。');
    for (const p of s.participants) {
      endpoint(p.base);
      if (!p.model.trim()) throw new Error(`请为「${p.name}」填写模型名称。`);
    }
    if (s.failure && !retry) throw new Error('上次请求失败，请选择重试当前 AI 或跳过。');
    if (extra) s.targetRounds = Math.min(10000, s.targetRounds + extra);
    if (s.completedRounds >= s.targetRounds) throw new Error('已达到总轮数，请设置追加轮数后继续。');
    if (retry) s.failure = null;
    s.status = 'running';
    const job = { controller: null, stopped: false };
    this.jobs.set(s.id, job);
    this.change(s);
    // Store the job synchronously before any await so double clicks cannot start another loop.
    job.promise = this.loop(s, job).finally(() => { this.jobs.delete(s.id); this.change(s); });
    return job.promise;
  }
  pause(s) {
    if (s.status === 'running') { s.status = 'pausing'; this.change(s); this.save().catch(() => {}); }
  }
  stop(s) {
    const job = this.jobs.get(s.id);
    if (job) { job.stopped = true; s.status = 'stopping'; job.controller?.abort(); }
    else s.status = 'stopped';
    this.change(s); this.save().catch(() => {});
  }
  async skip(s) {
    if (this.busy(s) || !s.failure) throw new Error('当前没有可跳过的失败发言。');
    const ai = s.participants.find(p => p.id === s.failure.aiId) || nextSpeaker(s);
    if (!ai) throw new Error('当前参与者已变更。');
    s.messages.push({ id: uid(), type: 'event', aiId: ai.id, speaker: ai.name,
      content: `第 ${s.completedRounds + 1} 轮已跳过「${ai.name}」，不计为成功发言。`, time: now(), status: 'skipped' });
    advance(s, ai.id); s.failure = null;
    if (s.completedRounds >= s.targetRounds) { s.status = 'completed'; this.change(s); await this.save(); return; }
    await this.save(); return this.start(s);
  }
  async loop(s, job) {
    let current;
    try {
      await this.save();
      while (s.completedRounds < s.targetRounds && s.status === 'running' && !job.stopped) {
        const ai = nextSpeaker(s);
        if (!ai) throw new Error('发言队列与参与者不一致，请调整参与者后继续。');
        current = { id: uid(), type: 'ai', aiId: ai.id, speaker: ai.name, model: ai.model,
          content: '', time: now(), status: 'generating', round: s.completedRounds + 1 };
        s.messages.push(current);
        // Checkpoint before spending API quota. The cursor only advances on complete success.
        await this.save(); this.change(s);
        const ctx = context(s, ai);
        s.contextTruncated = ctx.truncated;
        job.controller = new AbortController();
        if (job.stopped) job.controller.abort();
        let lastSaved = Date.now();
        await this.request(ai, ctx.messages, { signal: job.controller.signal, timeout: s.timeout, onDelta: part => {
          if (job.stopped) return;
          current.content += part;
          this.change(s);
          if (Date.now() - lastSaved > 700) {
            lastSaved = Date.now();
            this.save().catch(() => { s.status = 'pausing'; });
          }
        } });
        if (job.stopped) { current.status = 'interrupted'; break; }
        current.status = 'complete'; advance(s, ai.id); current = null;
        s.updatedAt = now();
        if (s.status === 'pausing') s.status = 'paused';
        if (s.completedRounds >= s.targetRounds) s.status = 'completed';
        await this.save(); this.change(s);
      }
    } catch (error) {
      if (current) current.status = job.stopped ? 'interrupted' : 'failed';
      if (!job.stopped) {
        const aiId = current?.aiId || nextSpeaker(s)?.id;
        s.failure = { aiId, message: error.name === 'TypeError' ? '无法连接本地代理，请确认服务正在运行；不要使用 file:// 打开网页。' : error.message };
        s.status = 'paused';
      }
    } finally {
      if (job.stopped) s.status = 'stopped';
      else if (s.status === 'pausing') s.status = 'paused';
      this.change(s);
      await this.save().catch(() => {});
    }
  }
}
