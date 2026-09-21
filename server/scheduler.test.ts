import { describe, it, expect } from 'vitest';
import { Scheduler } from './scheduler.js';
import type { TestTask, CallRecord } from '../shared/types.js';
const task = (id: string, n = 5): TestTask => ({
  id,
  name: id,
  workflowId: 1,
  workflowName: 'Taxi',
  requirement: '10秒',
  language: 'ja',
  concurrency: n,
  maxCalls: 20,
  maxDurationSeconds: 60,
  maxVoiceMinutes: 20,
  rules: {
    callerInstructions: 'caller',
    responseTimeoutSeconds: 10,
    assertions: [],
    interpretation: 'wait',
    source: 'manual',
  },
  status: 'running',
  createdAt: '',
  completedCalls: 0,
  failedCalls: 0,
  consumedSeconds: 0,
});
const flush = () => new Promise((r) => setTimeout(r, 0));
describe('shared call pool', () => {
  it('preserves completed tasks and drafts when stopping or shutting down the scheduler', () => {
    const tasks = [task('completed'), task('draft'), task('running'), task('paused')];
    tasks[0].status = 'completed';
    tasks[1].status = 'draft';
    tasks[3].status = 'paused';
    const pool = new Scheduler({
      tasks: () => tasks,
      limit: () => 10,
      onChange: () => {},
      onCall: () => {},
      execute: async () => {},
    });
    pool.stop(undefined, true);
    expect(tasks.map((item) => item.status)).toEqual(['completed', 'draft', 'stopped', 'stopped']);
    pool.stop('completed');
    expect(tasks[0].status).toBe('completed');
  });
  it('allocates 5+5, queues excess, and gives released slots to runnable tasks', async () => {
    const tasks = [task('a'), task('b'), task('c', 2)];
    tasks[2].status = 'paused';
    const finishes: Array<() => void> = [];
    const calls: CallRecord[] = [];
    const pool = new Scheduler({
      tasks: () => tasks,
      limit: () => 10,
      onChange: () => {},
      onCall: (c) => calls.push(c),
      execute: async (_t, c) =>
        new Promise<void>((r) =>
          finishes.push(() => {
            c.status = 'completed';
            c.durationSeconds = 20;
            r();
          }),
        ),
    });
    pool.pump();
    await flush();
    expect(pool.count('a')).toBe(5);
    expect(pool.count('b')).toBe(5);
    expect(calls).toHaveLength(10);
    tasks[0].status = 'paused';
    tasks[2].status = 'running';
    finishes[0]();
    await flush();
    expect(pool.activeCount).toBe(10);
    expect(pool.count('c')).toBe(1);
    pool.stop(undefined, true);
    finishes.forEach((f) => f());
    await flush();
  });
  it('reserves in-flight minutes and does not launch an entire batch after connection failure', async () => {
    const t = task('a', 10);
    t.maxVoiceMinutes = 2;
    const finishes: Array<() => void> = [];
    const pool = new Scheduler({
      tasks: () => [t],
      limit: () => 10,
      onChange: () => {},
      onCall: () => {},
      execute: async () =>
        new Promise<void>((_, reject) => finishes.push(() => reject(new Error('offline')))),
    });
    pool.pump();
    await flush();
    expect(pool.activeCount).toBe(2);
    finishes[0]();
    await flush();
    expect(t.status).toBe('paused');
    expect(pool.activeCount).toBe(1);
    finishes[1]();
    await flush();
    expect(t.failedCalls).toBe(2);
    expect(t.resultRevision).toBe(2);
  });
});
