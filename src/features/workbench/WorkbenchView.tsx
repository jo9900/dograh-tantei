import { AudioLines, CircleHelp, FileText, Plus, Workflow, X } from 'lucide-react';
import { useState } from 'react';
import type { TestTask, WorkbenchState } from '../../../shared/types';
import { useDialogFocus } from '../../hooks/useDialogFocus';
import type { Api, WorkflowChoice } from '../../types';
import { Capacity } from './Capacity';
import { TaskCard } from './TaskCard';
import { TaskComposer } from './TaskComposer';
import { TaskDetails } from './TaskDetails';

interface WorkbenchViewProps {
  composerOpen: boolean;
  setComposerOpen: React.Dispatch<React.SetStateAction<boolean>>;
  actionPending: string;
  taskAction: (taskId: string, action: string) => Promise<void>;
  state: WorkbenchState;
  api: Api;
  piReady: boolean;
  workflows: WorkflowChoice[];
  selectedTask?: TestTask;
  onSelectTask: (id: string) => void;
  onSettings: () => void;
  onOpenEvidence: (callId: string, startMs?: number) => void;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
  refresh: () => Promise<WorkbenchState>;
}

export function WorkbenchView({
  composerOpen,
  setComposerOpen,
  actionPending,
  taskAction,
  state,
  api,
  piReady,
  workflows,
  selectedTask,
  onSelectTask,
  onSettings,
  onOpenEvidence,
  onError,
  onNotice,
  refresh,
}: WorkbenchViewProps) {
  const [filter, setFilter] = useState<'all' | 'running' | 'completed'>('all');
  const composerDialog = useDialogFocus<HTMLElement>(composerOpen, () => setComposerOpen(false));

  if (selectedTask) {
    const calls = state.calls.filter((call) => call.taskId === selectedTask.id);
    const findings = state.findings.filter((finding) => finding.taskId === selectedTask.id);
    return (
      <TaskDetails
        task={selectedTask}
        calls={calls}
        findings={findings}
        api={api}
        refresh={refresh}
        piReady={piReady}
        summaryRunning={(state.summaryRunningTaskIds ?? []).includes(selectedTask.id)}
        actionPending={actionPending}
        onBack={() => onSelectTask('')}
        onAction={(action) => void taskAction(selectedTask.id, action)}
        onOpen={onOpenEvidence}
        onError={onError}
        onNotice={onNotice}
      />
    );
  }

  const visibleTasks = state.tasks.filter((task) => {
    if (filter === 'running') return task.status === 'running' || task.status === 'paused';
    if (filter === 'completed') return task.status === 'completed' || task.status === 'stopped';
    return true;
  });

  return (
    <>
      <div className="page-heading workbench-heading">
        <div>
          <h1>测试工作台</h1>
        </div>
      </div>
      <Capacity state={state} />
      {(!state.settings.dograhCredentialSet ||
        !state.settings.openaiKeySet ||
        !state.audioReady) && (
        <div className="setup-strip">
          <div>
            <CircleHelp size={17} />
            <p>
              {!state.settings.dograhCredentialSet || !state.settings.openaiKeySet
                ? '开始之前，连接 Dograh 和语音模型。'
                : '音频环境尚未就绪。'}
              <span>
                {!state.audioReady ? '连接设置中可查看准备状态。' : '凭据只保存在这台电脑。'}
              </span>
            </p>
          </div>
          <button className="text-button" onClick={onSettings}>
            配置连接
          </button>
        </div>
      )}

      <section className="task-section task-card-section" aria-label="测试任务">
        <div className="section-heading task-card-section-heading">
          <h2>
            测试任务 <span>{state.tasks.length}</span>
          </h2>
          <button className="button primary" onClick={() => setComposerOpen(true)}>
            <Plus size={16} />
            创建测试任务
          </button>
        </div>
        <div className="task-filters" aria-label="筛选任务">
          {(
            [
              ['all', '全部'],
              ['running', '进行中'],
              ['completed', '已完成'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              className={filter === value ? 'active' : ''}
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
            >
              {label}
            </button>
          ))}
        </div>
        {state.tasks.length === 0 ? (
          <div className="empty-workbench">
            <div className="empty-path">
              <Workflow size={25} />
              <span />
              <AudioLines size={30} />
              <span />
              <FileText size={25} />
            </div>
            <h3>选择 workflow，用自然语言描述你想验证的行为。</h3>
          </div>
        ) : visibleTasks.length ? (
          <div className="task-card-scroll" role="region" aria-label="测试任务卡片" tabIndex={0}>
            <div className="task-card-grid">
              {visibleTasks.map((task) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  calls={state.calls.filter((call) => call.taskId === task.id)}
                  findings={state.findings.filter((finding) => finding.taskId === task.id)}
                  onOpen={() => onSelectTask(task.id)}
                />
              ))}
            </div>
          </div>
        ) : (
          <div className="empty-inline compact-empty">
            <h3>这个筛选下没有任务</h3>
          </div>
        )}
      </section>

      {composerOpen && (
        <div
          className="workbench-dialog-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setComposerOpen(false);
          }}
        >
          <section
            ref={composerDialog}
            className="workbench-dialog task-composer-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="new-task-title"
            tabIndex={-1}
          >
            <div className="workbench-dialog-heading">
              <div>
                <span>新增测试</span>
                <h2 id="new-task-title">创建一个测试任务</h2>
              </div>
              <button
                className="icon-button"
                onClick={() => setComposerOpen(false)}
                aria-label="关闭新增测试"
              >
                <X size={19} />
              </button>
            </div>
            <TaskComposer
              api={api}
              workflows={workflows}
              maxConcurrency={state.settings.maxConcurrency}
              piReady={piReady}
              ready={
                state.settings.dograhCredentialSet &&
                state.settings.openaiKeySet &&
                state.audioReady
              }
              onSettings={onSettings}
              onCreated={async (task) => {
                setComposerOpen(false);
                await refresh();
                onNotice(`已创建“${task.name}”，测试开始运行。`);
              }}
              onError={onError}
            />
          </section>
        </div>
      )}
    </>
  );
}
