import { randomUUID } from 'node:crypto';
import type { TestTask, CallRecord } from '../shared/types.js';

export type Executor = (task: TestTask, call: CallRecord, signal: AbortSignal) => Promise<void>;
/** Single coordinator owns all reservations. In-flight calls reserve their maximum
 * duration against a task's voice-minute limit so parallel launches cannot overspend it. */
export class Scheduler {
  private active = new Map<
    string,
    { taskId: string; reservedSeconds: number; abort: AbortController }
  >();
  private cursor = 0;
  private pumping = false;
  constructor(
    private options: {
      tasks: () => TestTask[];
      limit: () => number;
      execute: Executor;
      onChange: () => void;
      onCall: (call: CallRecord) => void;
    },
  ) {}
  get activeCount() {
    return this.active.size;
  }
  count(taskId: string) {
    return [...this.active.values()].filter((x) => x.taskId === taskId).length;
  }
  private reserved(taskId: string) {
    return [...this.active.values()]
      .filter((x) => x.taskId === taskId)
      .reduce((n, x) => n + x.reservedSeconds, 0);
  }
  pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      const tasks = this.options.tasks();
      for (const task of tasks) {
        if (task.status !== 'running' || this.count(task.id)) continue;
        if (
          task.completedCalls + task.failedCalls >= task.maxCalls ||
          task.consumedSeconds + task.maxDurationSeconds > task.maxVoiceMinutes * 60
        )
          task.status = 'completed';
      }
      let misses = 0;
      while (this.active.size < this.options.limit() && tasks.length && misses < tasks.length) {
        const task = tasks[this.cursor++ % tasks.length];
        const n = this.count(task.id);
        if (
          task.status !== 'running' ||
          n >= task.concurrency ||
          task.completedCalls + task.failedCalls + n >= task.maxCalls ||
          task.consumedSeconds + this.reserved(task.id) + task.maxDurationSeconds >
            task.maxVoiceMinutes * 60
        ) {
          misses++;
          continue;
        }
        misses = 0;
        const call: CallRecord = {
          id: randomUUID(),
          taskId: task.id,
          workflowId: task.workflowId,
          status: 'connecting',
          startedAt: new Date().toISOString(),
          durationSeconds: 0,
        };
        const abort = new AbortController();
        this.active.set(call.id, {
          taskId: task.id,
          reservedSeconds: task.maxDurationSeconds,
          abort,
        });
        this.options.onCall(call);
        Promise.resolve()
          .then(() => this.options.execute(task, call, abort.signal))
          .catch((e: Error) => {
            call.status = 'error';
            call.error = e.message;
          })
          .finally(() => {
            call.endedAt ??= new Date().toISOString();
            call.durationSeconds = Math.max(0, call.durationSeconds);
            task.consumedSeconds +=
              call.status === 'completed' && call.finalUsageConfirmed !== false
                ? call.durationSeconds
                : Math.max(task.maxDurationSeconds, call.durationSeconds);
            if (call.status === 'completed') task.completedCalls++;
            else task.failedCalls++;
            task.resultRevision = (task.resultRevision ?? 0) + 1;
            this.active.delete(call.id);
            // Connection failures should not burn through the entire task in a retry loop.
            if (call.status === 'error' && task.status === 'running') {
              task.status = 'paused';
              task.pauseReason = call.error ?? '通话失败，请检查连接后恢复。';
            }
            this.options.onChange();
            this.pump();
          });
      }
      this.options.onChange();
    } finally {
      this.pumping = false;
    }
  }
  stop(taskId?: string, immediately = false) {
    for (const task of this.options.tasks())
      if ((!taskId || task.id === taskId) && ['running', 'paused'].includes(task.status))
        task.status = 'stopped';
    if (immediately)
      for (const entry of this.active.values())
        if (!taskId || entry.taskId === taskId) entry.abort.abort();
    this.options.onChange();
  }
}
