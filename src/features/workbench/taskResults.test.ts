import { describe, expect, it } from 'vitest';
import type { CallRecord, Finding, TestTask } from '../../../shared/types';
import { callResult, resolvedIssueGroups, reviewSummaryLabel, summaryIsStale } from './taskResults';

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
  completedCalls: 1,
  failedCalls: 0,
  consumedSeconds: 60,
  resultRevision: 2,
};

const call: CallRecord = {
  id: 'call-1',
  taskId: task.id,
  workflowId: 1,
  runId: 1041,
  status: 'completed',
  startedAt: task.createdAt,
  durationSeconds: 60,
  evaluationStatus: 'complete',
  evaluationOverall: 'pass',
};

const finding: Finding = {
  id: 'finding-1',
  taskId: task.id,
  callId: call.id,
  kind: 'semantic_assertion_0',
  title: '最终确认仍使用旧数量',
  detail: '最终复述使用旧数量。',
  severity: 'high',
  startMs: 10_000,
  endMs: 15_000,
  source: 'judge',
  state: 'candidate',
  createdAt: task.createdAt,
  evaluatorVersion: 3,
  category: 'agent_behavior',
};

describe('workbench task result presentation', () => {
  it('shows a pass only when the saved call judgment explicitly passed', () => {
    expect(callResult(call, [], true)).toBe('通过');
    expect(callResult({ ...call, evaluationOverall: undefined }, [], true)).toBe('旧版结果未区分');
    expect(
      callResult({ ...call, evaluationStatus: undefined, evaluationOverall: undefined }, [], true),
    ).toBe('等待评审');
    expect(
      callResult(
        { ...call, evaluationStatus: 'unavailable', evaluationOverall: undefined },
        [],
        true,
      ),
    ).toBe('评审不可用');
  });

  it('falls back to current findings instead of hiding evidence behind a stale Pi summary', () => {
    const withStaleSummary: TestTask = {
      ...task,
      summary: {
        version: 1,
        revisionId: 'summary-1',
        resultRevision: 1,
        generatedAt: task.createdAt,
        reviewedCallIds: [call.id],
        findingIds: [],
        passCallIds: [call.id],
        inconclusiveCallIds: [],
        headline: '旧汇总',
        body: '旧结果',
        points: [],
        groups: [],
      },
    };
    expect(summaryIsStale(withStaleSummary, [call], [finding])).toBe(true);
    expect(resolvedIssueGroups(withStaleSummary, [finding])).toMatchObject([
      { title: finding.title, findingIds: [finding.id], callIds: [call.id] },
    ]);
  });

  it('does not describe an unreviewed sample as having zero problems', () => {
    expect(reviewSummaryLabel([], 0, true)).toBe('尚未评审');
    expect(
      reviewSummaryLabel(
        [{ ...call, evaluationStatus: 'pending', evaluationOverall: undefined }],
        0,
        true,
      ),
    ).toBe('评审中');
    expect(
      reviewSummaryLabel(
        [{ ...call, evaluationStatus: 'unavailable', evaluationOverall: undefined }],
        0,
        true,
      ),
    ).toBe('评审不可用');
    expect(reviewSummaryLabel([call], 0, true)).toBe('0 类候选问题');
  });
});
