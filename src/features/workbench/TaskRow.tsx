import { ChevronRight, Pause, Play, RefreshCw, Square, Workflow } from 'lucide-react';
import type { CallRecord, TestTask } from '../../../shared/types';
import { Busy, Status } from '../../components/ui';

export function TaskRow({
  task,
  selected,
  calls,
  findingCount,
  pending,
  onSelect,
  onAction,
}: {
  task: TestTask;
  selected: boolean;
  calls: CallRecord[];
  findingCount: number;
  pending: string;
  onSelect: () => void;
  onAction: (action: string) => void;
}) {
  const active = calls.filter(
    (call) => call.status === 'running' || call.status === 'connecting',
  ).length;
  const canStopEvaluation =
    task.status !== 'running' &&
    task.status !== 'paused' &&
    calls.some((call) => call.evaluationStatus === 'pending');
  return (
    <article className={`task-row ${selected ? 'selected' : ''}`}>
      <button className="task-select" onClick={onSelect} aria-pressed={selected}>
        <span className="task-title">
          <span>{task.name}</span>
          <Status value={task.status} />
        </span>
        <span className="task-workflow">
          <Workflow size={12} />
          {task.workflowName}
          <span>·</span>
          {task.language === 'ja' ? '日语' : task.language}
        </span>
        <span className="task-stats">
          <span>
            <strong>{active}</strong> / {task.concurrency} 路
          </span>
          <span>
            {task.completedCalls} / {task.maxCalls} 次完成
          </span>
          {task.failedCalls > 0 && <span className="error-ink">{task.failedCalls} 次失败</span>}
          <span className={findingCount ? 'finding-ink' : ''}>{findingCount} 条发现</span>
        </span>
      </button>
      <div className="task-actions">
        {task.status === 'running' && (
          <>
            <button
              className="icon-button"
              title="暂停新通话，已开始的通话继续"
              aria-label={`暂停 ${task.name}`}
              disabled={!!pending}
              onClick={() => onAction('pause')}
            >
              <Pause size={16} />
            </button>
            <button
              className="icon-button"
              title="停止通话与后续评审"
              aria-label={`停止 ${task.name}`}
              disabled={!!pending}
              onClick={() => onAction('cancel')}
            >
              <Square size={15} />
            </button>
          </>
        )}
        {task.status === 'paused' && (
          <>
            <button
              className="icon-button"
              title="继续测试"
              aria-label={`继续 ${task.name}`}
              disabled={!!pending}
              onClick={() => onAction('resume')}
            >
              <Play size={16} />
            </button>
            <button
              className="icon-button"
              title="停止通话与后续评审"
              aria-label={`停止 ${task.name}`}
              disabled={!!pending}
              onClick={() => onAction('cancel')}
            >
              <Square size={15} />
            </button>
          </>
        )}
        {canStopEvaluation && (
          <button
            className="text-button"
            title="取消排队和进行中的后续评审；已提交的请求仍可能计费"
            disabled={!!pending}
            onClick={() => onAction('cancel')}
          >
            <Square size={13} />
            停止后续评审
          </button>
        )}
        {(task.status === 'completed' || task.status === 'stopped' || task.status === 'paused') && (
          <button
            className="text-button"
            title="按相同条件与预算，用当前 workflow 草稿创建新回归任务"
            disabled={!!pending}
            onClick={() => onAction('regression')}
          >
            <RefreshCw size={14} />
            新版本回归
          </button>
        )}
        {pending.startsWith(task.id) && <Busy />}
        <button className="icon-button" aria-label={`查看 ${task.name} 的结果`} onClick={onSelect}>
          <ChevronRight size={17} />
        </button>
      </div>
    </article>
  );
}
