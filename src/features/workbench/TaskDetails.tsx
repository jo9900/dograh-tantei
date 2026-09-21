import {
  ArrowLeft,
  Check,
  CircleHelp,
  ChevronDown,
  ChevronRight,
  MoreHorizontal,
  Pause,
  Play,
  RefreshCw,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import type { CallRecord, Finding, TestTask } from '../../../shared/types';
import { Busy, Status } from '../../components/ui';
import {
  categoryNames,
  dateLabel,
  errorText,
  formatTime,
  findingText,
  friendlyEvaluationError,
  severityNames,
} from '../../lib/presentation';
import type { Api } from '../../types';
import {
  callResult,
  jevResult,
  currentFindings,
  resolvedIssueGroups,
  reviewSummaryLabel,
  summaryIsStale,
} from './taskResults';

export function TaskDetails({
  task,
  calls,
  findings,
  api,
  refresh,
  piReady,
  summaryRunning,
  actionPending,
  onBack,
  onAction,
  onOpen,
  onError,
  onNotice,
}: {
  task: TestTask;
  calls: CallRecord[];
  findings: Finding[];
  api: Api;
  refresh: () => Promise<unknown>;
  piReady: boolean;
  summaryRunning: boolean;
  actionPending: string;
  onBack: () => void;
  onAction: (action: string) => void;
  onOpen: (id: string, startMs?: number) => void;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
}) {
  const [summaryPending, setSummaryPending] = useState(false);
  const activeFindings = currentFindings(findings);
  const groups = useMemo(
    () => resolvedIssueGroups(task, findings),
    [task, task.summary, task.resultRevision, findings],
  );
  const stale = summaryIsStale(task, calls, findings);
  const reviewed = calls.filter((call) => call.evaluationStatus === 'complete').length;
  const active = calls.filter((call) => ['connecting', 'running'].includes(call.status)).length;
  const finished = task.completedCalls + task.failedCalls;
  const affected = new Set(activeFindings.map((finding) => finding.callId)).size;
  const passed = calls.filter(
    (call) => call.evaluationStatus === 'complete' && call.evaluationOverall === 'pass',
  ).length;
  const progress = Math.min(100, (finished / Math.max(1, task.maxCalls)) * 100);
  const reviewLabel = reviewSummaryLabel(calls, groups.length, !!task.rules.assertions.length);

  async function summarize() {
    if (summaryPending || summaryRunning) return;
    setSummaryPending(true);
    try {
      await api(`/api/tasks/${task.id}/summary`, {});
      await refresh();
      onNotice(task.summary ? 'Pi 已重新生成本轮汇总。' : 'Pi 已生成本轮汇总。');
    } catch (failure) {
      onError(errorText(failure));
    } finally {
      setSummaryPending(false);
    }
  }

  const busyAction = actionPending.startsWith(task.id);
  return (
    <section className="task-detail task-detail-page">
      <button className="text-button back-button" onClick={onBack}>
        <ArrowLeft size={14} />
        返回所有测试任务
      </button>
      <div className="task-detail-heading">
        <div>
          <div className="task-detail-kicker">
            <Status value={task.status} />
            <span>{task.workflowName}</span>
          </div>
          <h1>{task.name}</h1>
          <p>{task.requirement}</p>
        </div>
        <div className="task-detail-actions">
          {task.status === 'running' && (
            <button
              className="button primary"
              disabled={busyAction}
              onClick={() => onAction('pause')}
            >
              {busyAction ? <Busy /> : <Pause size={14} />}
              暂停任务
            </button>
          )}
          {task.status === 'paused' && (
            <>
              <button
                className="button secondary"
                disabled={busyAction}
                onClick={() => onAction('cancel')}
              >
                <Square size={13} />
                停止任务
              </button>
              <button
                className="button primary"
                disabled={busyAction}
                onClick={() => onAction('resume')}
              >
                {busyAction ? <Busy /> : <Play size={14} />}
                继续任务
              </button>
            </>
          )}
          {(task.status === 'completed' || task.status === 'stopped') && (
            <button
              className="button primary"
              disabled={busyAction}
              title={`按相同测试目标和设置重新拨打 ${task.maxCalls} 通电话，生成新一轮结果，保留本轮记录。`}
              onClick={() => onAction('regression')}
            >
              {busyAction ? <Busy /> : <RefreshCw size={14} />}
              开始新一轮
            </button>
          )}
          {['completed', 'stopped'].includes(task.status) && (
            <button
              className="button secondary"
              disabled={busyAction}
              title="删除此测试任务及其 Pi 对话记录，删除后无法继续该对话；其他任务和工作台的 Pi 对话不受影响，通话录音文件保留在本机。"
              onClick={() => {
                if (window.confirm('删除这个测试任务和对应的 Pi 对话？通话录音文件会保留在本机。'))
                  onAction('delete');
              }}
            >
              <Trash2 size={14} />
              删除任务
            </button>
          )}
        </div>
      </div>

      <section className="task-progress" aria-label="任务进度">
        <div>
          <span>本轮进度</span>
          <strong>
            {finished} / {task.maxCalls} 通
          </strong>
        </div>
        <div className="task-progress-track" aria-hidden="true">
          <i style={{ width: `${progress}%` }} />
        </div>
        <div className="task-progress-meta">
          <span>{active} 路正在通话</span>
          <span>{reviewed} 通已评审</span>
          <span>{reviewLabel}</span>
          <details className="task-rules">
            <summary>
              <MoreHorizontal size={17} />
              <span>检查条件</span>
            </summary>
            <div>
              <strong>通话时检查条件</strong>
              <ul>
                {task.rules.assertions.length ? (
                  task.rules.assertions.map((assertion, index) => <li key={index}>{assertion}</li>)
                ) : (
                  <li>未配置自动业务评审；仍保留录音与时间检测。</li>
                )}
              </ul>
              <details className="caller-instructions">
                <summary>
                  模拟来电者指令
                  <ChevronDown size={13} />
                </summary>
                <p>{task.rules.callerInstructions || '未保存模拟来电者指令。'}</p>
              </details>
              <p>
                单通话 {task.maxDurationSeconds} 秒 · 总上限 {task.maxVoiceMinutes} 分钟 · 已用{' '}
                {(task.consumedSeconds / 60).toFixed(1)} 分钟
              </p>
              {task.workflowHash && <code>版本 {task.workflowHash.slice(0, 12)}</code>}
            </div>
          </details>
        </div>
      </section>

      {task.pauseReason && <p className="inline-warning">暂停原因：{task.pauseReason}</p>}
      {task.evaluationError && (
        <p className="inline-warning">
          业务评估暂不可用：{friendlyEvaluationError(task.evaluationError)}
        </p>
      )}

      <section className="round-summary" aria-labelledby="round-summary-title">
        <div className="round-section-heading">
          <h2 id="round-summary-title">本轮汇总</h2>
          <div className="round-summary-actions">
            <span>
              {task.summary
                ? `Pi 汇总 · ${dateLabel(task.summary.generatedAt)}${stale ? ' · 有新结果待重新分析' : ''}`
                : null}
            </span>
            <button
              className={`button ${task.summary ? 'secondary' : 'primary'}`}
              disabled={
                summaryPending ||
                summaryRunning ||
                !piReady ||
                (!reviewed && !activeFindings.length)
              }
              title={!piReady ? '请先在连接与设置中连接 Pi' : undefined}
              onClick={() => void summarize()}
            >
              {summaryPending || summaryRunning ? <Busy /> : <RefreshCw size={14} />}
              {task.summary ? '用 Pi 重新分析' : '用 Pi 分析汇总'}
            </button>
          </div>
        </div>
        {task.summary ? (
          <article className={`summary-brief ${stale ? 'stale' : ''}`}>
            <div className="summary-copy">
              <h3>{findingText(task.summary.headline)}</h3>
              <p>{findingText(task.summary.body)}</p>
              {!!task.summary.points.length && (
                <ul>
                  {task.summary.points.map((point, index) => (
                    <li key={index}>{findingText(point)}</li>
                  ))}
                </ul>
              )}
            </div>
            <dl className="summary-metrics">
              <div>
                <dt>已评审</dt>
                <dd>
                  {reviewed}
                  <small>通</small>
                </dd>
              </div>
              <div>
                <dt>涉及问题</dt>
                <dd>
                  {affected}
                  <small>通</small>
                </dd>
              </div>
              <div>
                <dt>归并问题</dt>
                <dd>
                  {groups.length}
                  <small>类</small>
                </dd>
              </div>
              <div>
                <dt>通过</dt>
                <dd>
                  {passed}
                  <small>通</small>
                </dd>
              </div>
            </dl>
          </article>
        ) : (
          <div className="summary-empty">
            <h3>{reviewed ? `${reviewed} 通已评审` : '正在等待通话评审'}</h3>
            <p>
              {reviewed
                ? '点击“用 Pi 分析汇总”，把各通结果归并为本轮摘要和问题类别。'
                : '通话完成并生成评审后，可以让 Pi 汇总本轮结果。'}
            </p>
          </div>
        )}
      </section>

      <section className="issue-breakdown" aria-labelledby="issue-breakdown-title">
        <div className="round-section-heading">
          <h2 id="issue-breakdown-title">
            问题细分 <span>{groups.length}</span>
          </h2>
        </div>
        {groups.length ? (
          <div className="issue-groups">
            {groups.map((group) => {
              const groupCalls = group.callIds
                .map((callId) => calls.find((call) => call.id === callId))
                .filter((call): call is CallRecord => !!call);
              return (
                <article className="issue-group" key={group.id}>
                  <div className="issue-group-main">
                    <span className="issue-group-label">
                      <em className={`severity-${group.severity}`}>
                        {severityNames[group.severity]}优先级
                      </em>
                      <span>{categoryNames[group.category]}</span>
                    </span>
                    <span className="issue-group-copy">
                      <strong>{findingText(group.title)}</strong>
                      <p>{findingText(group.detail)}</p>
                    </span>
                    <span className="issue-group-rate">
                      {groupCalls.map((call) => (
                        <button
                          className="text-button"
                          key={call.id}
                          onClick={() => onOpen(call.id)}
                        >
                          <strong>{call.runId ? `#${call.runId}` : call.id.slice(0, 8)}</strong>
                        </button>
                      ))}
                    </span>
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <div className="empty-inline compact-empty">
            <h3>{reviewed ? '本轮没有候选问题' : '等待评审结果'}</h3>
            <p>{reviewed ? '已完成的通话结果会在下方保留。' : '问题会在通话评审完成后显示。'}</p>
          </div>
        )}

        <div className="round-call-table" role="region" aria-label="全部通话" tabIndex={0}>
          <div className="round-call-head">
            <span>通话</span>
            <span>状态</span>
            <span>时长</span>
            <span>结果</span>
            <span />
          </div>
          {calls.length ? (
            calls.map((call) => (
              <button className="round-call-row" key={call.id} onClick={() => onOpen(call.id)}>
                <span>
                  <strong>{call.runId ? `#${call.runId}` : call.id.slice(0, 8)}</strong>
                  <small>{dateLabel(call.startedAt)}</small>
                </span>
                <Status value={call.status} />
                <span className="tabular">{formatTime(call.durationSeconds)}</span>
                <span className="call-judgments">
                  <JudgmentResult
                    name="Pi"
                    failed={
                      call.evaluationStatus === 'complete' &&
                      call.evaluationOverall === 'fail' &&
                      !['connecting', 'running', 'error', 'interrupted'].includes(call.status)
                    }
                    result={callResult(call, findings, !!task.rules.assertions.length)}
                  />
                  <JudgmentResult
                    name="Jev"
                    result={jevResult(call)}
                    failed={
                      call.jevEvaluation?.status === 'complete' &&
                      call.jevEvaluation.overall === 'fail'
                    }
                  />
                </span>
                <ChevronRight size={15} />
              </button>
            ))
          ) : (
            <p className="empty-text">还没有通话记录。</p>
          )}
        </div>
      </section>
    </section>
  );
}

function JudgmentResult({
  name,
  result,
  failed,
}: {
  name: string;
  result: string;
  failed?: boolean;
}) {
  return (
    <span className="call-judgment">
      {failed && <X className="judgment-icon judgment-icon-fail" size={16} aria-hidden="true" />}
      {result === '通过' && <Check className="judgment-icon" size={16} aria-hidden="true" />}
      {result === '无法判定' && (
        <CircleHelp className="judgment-icon" size={16} aria-hidden="true" />
      )}
      <span>
        {name} · {result}
      </span>
    </span>
  );
}
