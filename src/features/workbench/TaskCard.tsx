import type { CallRecord, Finding, TestTask } from '../../../shared/types';
import { Status } from '../../components/ui';
import { statusNames } from '../../lib/presentation';
import { currentFindings, resolvedIssueGroups, reviewSummaryLabel } from './taskResults';

export function TaskCard({
  task,
  calls,
  findings,
  onOpen,
}: {
  task: TestTask;
  calls: CallRecord[];
  findings: Finding[];
  onOpen: () => void;
}) {
  const active = calls.filter((call) => ['connecting', 'running'].includes(call.status)).length;
  const reviewed = calls.filter((call) => call.evaluationStatus === 'complete').length;
  const finished = task.completedCalls + task.failedCalls;
  const issueCount = resolvedIssueGroups(task, currentFindings(findings)).length;
  const resultLabel = reviewSummaryLabel(calls, issueCount, !!task.rules.assertions.length);
  const progress = Math.min(100, (finished / Math.max(1, task.maxCalls)) * 100);
  const titleId = `task-card-${task.id}-title`;
  const descriptionId = `task-card-${task.id}-description`;
  return (
    <button
      className="task-card"
      onClick={onOpen}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
    >
      <span className="sr-only" id={descriptionId}>
        {statusNames[task.status] ?? task.status}，{task.workflowName}，进度 {finished} /{' '}
        {task.maxCalls} 通，已评审 {reviewed} 通，{resultLabel}。打开任务详情。
      </span>
      <span className="task-card-top">
        <Status value={task.status} />
        <span>{active ? `${active} 路并发` : '已释放并发'}</span>
      </span>
      <span className="task-card-title" id={titleId}>
        {task.name}
      </span>
      <span className="task-card-workflow">{task.workflowName}</span>
      <span className="task-card-goal">{task.requirement}</span>
      <span className="task-card-progress-label">
        <span>本轮进度</span>
        <strong>
          {finished} / {task.maxCalls} 通
        </strong>
      </span>
      <span className="task-card-progress" aria-hidden="true">
        <i style={{ width: `${progress}%` }} />
      </span>
      <span className="task-card-footer">
        <span>已评审 {reviewed} 通</span>
        <strong className={issueCount ? 'has-issues' : ''}>{resultLabel}</strong>
      </span>
    </button>
  );
}
