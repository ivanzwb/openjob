import { randomUUID } from 'node:crypto';

const runners = new Map<string, Promise<void>>();

/** 启动异步诊断任务，立即返回 jobId，进度通过 job:progress 推送 */
export function startJob(_label: string, fn: (jobId: string) => Promise<void>): string {
  const jobId = randomUUID();
  const task = fn(jobId).finally(() => runners.delete(jobId));
  runners.set(jobId, task);
  return jobId;
}
