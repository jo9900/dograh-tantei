import { describe, expect, it } from 'vitest';
import type { CallRecord, Finding, TestTask } from '../shared/types.js';
import { generateTaskSummary } from './task-summary.js';

const task: TestTask = {
  id: 'task-1',
  name: '订单修改测试',
  workflowId: 1,
  workflowName: 'Order Hotline',
  requirement: '修改数量并完成订单',
  language: 'ja',
  concurrency: 2,
  maxCalls: 10,
  maxDurationSeconds: 600,
  maxVoiceMinutes: 100,
  rules: {
    callerInstructions: 'caller instructions',
    responseTimeoutSeconds: null,
    assertions: ['使用修改后的数量完成确认'],
    interpretation: '检查最终数量',
    source: 'pi',
  },
  status: 'completed',
  createdAt: '2026-09-21T00:00:00.000Z',
  completedCalls: 2,
  failedCalls: 0,
  consumedSeconds: 120,
};

const calls: CallRecord[] = [
  {
    id: 'call-1',
    taskId: task.id,
    workflowId: 1,
    runId: 101,
    status: 'completed',
    startedAt: task.createdAt,
    durationSeconds: 60,
    evaluationStatus: 'complete',
    evaluationOverall: 'fail',
  },
  {
    id: 'call-2',
    taskId: task.id,
    workflowId: 1,
    runId: 102,
    status: 'completed',
    startedAt: task.createdAt,
    durationSeconds: 60,
    evaluationStatus: 'complete',
    evaluationOverall: 'pass',
  },
];

const findings: Finding[] = [
  {
    id: 'finding-1',
    taskId: task.id,
    callId: calls[0]!.id,
    kind: 'semantic_assertion_0',
    title: '最终确认仍使用旧数量',
    detail: '客服确认修改，但最终复述仍为旧数量。',
    severity: 'high',
    startMs: 10_000,
    endMs: 15_000,
    source: 'judge',
    state: 'candidate',
    createdAt: task.createdAt,
    evaluatorVersion: 3,
    category: 'agent_behavior',
  },
];

describe('task-level Pi summaries', () => {
  it('keeps exact evidence membership and records independently judged passes', async () => {
    const summary = await generateTaskSummary(
      {
        complete: async () =>
          JSON.stringify({
            headline: '2 通已评审，1 通出现旧数量复述',
            body: '问题出现在一通，另一通通过。',
            points: ['继续核对数量修改后的最终状态。'],
            groups: [
              {
                title: '修改后仍使用旧数量',
                detail: '同一问题出现 1 次。',
                clusterIds: ['cluster:1'],
              },
            ],
          }),
      },
      task,
      calls,
      findings,
    );
    expect(summary.reviewedCallIds).toEqual(['call-1', 'call-2']);
    expect(summary.passCallIds).toEqual(['call-2']);
    expect(summary.groups).toMatchObject([
      {
        category: 'agent_behavior',
        severity: 'high',
        findingIds: ['finding-1'],
        callIds: ['call-1'],
      },
    ]);
  });

  it('rejects a Pi grouping that drops supplied evidence clusters', async () => {
    await expect(
      generateTaskSummary(
        {
          complete: async () =>
            JSON.stringify({
              headline: '汇总',
              body: '没有完整引用问题。',
              points: [],
              groups: [],
            }),
        },
        task,
        calls,
        findings,
      ),
    ).rejects.toThrow('已保留原结果');
  });

  it('does not merge findings that belong to different explicit test objectives', async () => {
    const secondObjective: Finding = {
      ...findings[0]!,
      id: 'finding-2',
      kind: 'semantic_assertion_1',
      title: '订单没有完成',
      detail: '最终没有出现订单完成结果。',
      category: 'agent_behavior',
    };
    await expect(
      generateTaskSummary(
        {
          complete: async () =>
            JSON.stringify({
              headline: '汇总',
              body: '两个目标出现问题。',
              points: [],
              groups: [
                {
                  title: '错误合并',
                  detail: '把两个目标合并到了一起。',
                  clusterIds: ['cluster:1', 'cluster:2'],
                },
              ],
            }),
        },
        task,
        calls,
        [...findings, secondObjective],
      ),
    ).rejects.toThrow('已保留原结果');
  });

  it('keeps the starting revision when new results arrive during Pi analysis', async () => {
    const changingTask = { ...task, resultRevision: 4 };
    const summary = await generateTaskSummary(
      {
        complete: async () => {
          changingTask.resultRevision = 5;
          return JSON.stringify({
            headline: '1 通出现问题',
            body: '汇总生成期间又有结果到达。',
            points: [],
            groups: [
              {
                title: '旧数量',
                detail: '一通出现。',
                clusterIds: ['cluster:1'],
              },
            ],
          });
        },
      },
      changingTask,
      calls,
      findings,
    );
    expect(summary.resultRevision).toBe(4);
    expect(changingTask.resultRevision).toBe(5);
  });
});
