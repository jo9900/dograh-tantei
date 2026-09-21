import { AudioLines, Check, MessageSquare, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { Finding, TestTask } from '../shared/types';
import { Busy } from './components/ui';
import { EvidenceDrawer } from './features/evidence/EvidenceDrawer';
import { PiPanel } from './features/pi/PiPanel';
import type { SettingsPage } from './features/settings/settingsTypes';
import { SettingsView } from './features/settings/SettingsView';
import { WorkbenchView } from './features/workbench/WorkbenchView';
import { useWorkbench } from './hooks/useWorkbench';
import { errorText } from './lib/presentation';
import type { PiStatus } from './types';

export default function App() {
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [page, setPage] = useState<'workbench' | 'settings'>('workbench');
  const [settingsPage, setSettingsPage] = useState<SettingsPage>('dograh');
  const openSettings = (section: SettingsPage = 'dograh') => {
    setSettingsPage(section);
    setPage('settings');
    setPiMobileOpen(false);
  };
  const [selectedTaskId, setSelectedTaskId] = useState('');
  const [drawer, setDrawer] = useState<{ callId: string; startMs?: number } | null>(null);
  const [piMobileOpen, setPiMobileOpen] = useState(false);
  const onAuthenticationRequired = useCallback(() => {
    setSettingsPage('pi');
    setPage('settings');
    setPiMobileOpen(false);
  }, []);
  const {
    state,
    connected,
    workflows,
    workflowsLoaded,
    messages,
    setMessages,
    authPrompt,
    authEvents,
    piPending,
    setPiPending,
    api,
    refresh,
  } = useWorkbench({ onError: setError, onNotice: setNotice, onAuthenticationRequired });
  useEffect(() => {
    if (notice) {
      const timer = setTimeout(() => setNotice(''), 6000);
      return () => clearTimeout(timer);
    }
  }, [notice]);

  const selectedTask = state?.tasks.find((task) => task.id === selectedTaskId);
  const pi = (state?.pi ?? {}) as PiStatus;
  const [composerOpen, setComposerOpen] = useState(false);
  const [actionPending, setActionPending] = useState('');
  async function taskAction(taskId: string, action: string) {
    setActionPending(`${taskId}:${action}`);
    setError('');
    try {
      const result = await api<TestTask>(`/api/tasks/${taskId}/action`, { action });
      await refresh();
      if (action === 'delete') {
        setSelectedTaskId('');
        setMessages((previous) =>
          previous.filter((message) => message.contextKey !== `task:${taskId}`),
        );
      }
      if (action === 'regression' && result.id) setSelectedTaskId(result.id);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setActionPending('');
    }
  }

  async function updateFinding(id: string, value: Finding['state']) {
    try {
      await api(`/api/findings/${id}`, { state: value }, 'PATCH');
      await refresh();
    } catch (e) {
      setError(errorText(e));
    }
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <button
          className="brand"
          onClick={() => {
            setPage('workbench');
            setSelectedTaskId('');
          }}
          aria-label="Dograh Tantei 工作台"
        >
          <span className="brand-mark">
            <AudioLines size={23} strokeWidth={1.8} />
          </span>
          <span>Dograh Tantei</span>
        </button>
        <nav className="primary-nav" aria-label="主导航">
          <button
            className={page === 'workbench' ? 'active' : ''}
            onClick={() => {
              setPage('workbench');
              setSelectedTaskId('');
            }}
          >
            测试工作台
          </button>
          <button className={page === 'settings' ? 'active' : ''} onClick={() => openSettings()}>
            连接与设置
          </button>
        </nav>
        <div className="header-end">
          <span className={`local-indicator ${connected ? 'online' : ''}`}>
            <span />
            {connected ? '本地运行' : '正在连接'}
          </span>
          <button
            className={`icon-button mobile-pi ${page === 'settings' ? 'settings-hidden' : ''}`}
            aria-label="打开 Pi 助手"
            onClick={() => setPiMobileOpen(true)}
          >
            <MessageSquare size={19} />
          </button>
        </div>
      </header>
      {error && (
        <div className="global-alert" role="alert">
          <span>{error}</span>
          <button onClick={() => setError('')} className="icon-button" aria-label="关闭错误提示">
            <X size={16} />
          </button>
        </div>
      )}
      {notice && (
        <div className="toast" role="status">
          <Check size={16} />
          {notice}
          <button className="icon-button" onClick={() => setNotice('')} aria-label="关闭通知">
            <X size={14} />
          </button>
        </div>
      )}
      {!state ? (
        <main className="startup">
          <div className="brand-mark">
            <AudioLines size={28} />
          </div>
          <h1>正在打开工作台</h1>
          <p>读取本地任务与连接状态</p>
          {error ? (
            <button
              className="button primary"
              onClick={() => {
                setError('');
                void refresh().catch((e) => setError(errorText(e)));
              }}
            >
              重新连接
            </button>
          ) : (
            <Busy />
          )}
        </main>
      ) : (
        <div className={`workspace-grid ${page === 'settings' ? 'workspace-settings' : ''}`}>
          <main className="main-content">
            {page === 'settings' ? (
              <SettingsView
                initialPage={settingsPage}
                state={state}
                api={api}
                refresh={refresh}
                workflowsLoaded={workflowsLoaded}
                authPrompt={authPrompt}
                authEvents={authEvents}
                onError={setError}
                onNotice={setNotice}
              />
            ) : (
              <WorkbenchView
                composerOpen={composerOpen}
                setComposerOpen={setComposerOpen}
                actionPending={actionPending}
                taskAction={taskAction}
                state={state}
                api={api}
                piReady={!!pi.configured}
                workflows={workflows}
                selectedTask={selectedTask}
                onSelectTask={setSelectedTaskId}
                onSettings={() => openSettings()}
                onOpenEvidence={(callId, startMs) => setDrawer({ callId, startMs })}
                onError={setError}
                onNotice={setNotice}
                refresh={refresh}
              />
            )}
          </main>
          <PiPanel
            pi={pi}
            messages={messages}
            setMessages={setMessages}
            busy={piPending || !!pi.busy}
            setBusy={setPiPending}
            task={selectedTask}
            api={api}
            onError={setError}
            onSettings={() => openSettings('pi')}
            mobileOpen={piMobileOpen}
            onClose={() => setPiMobileOpen(false)}
          />
        </div>
      )}
      {drawer && (
        <EvidenceDrawer
          callId={drawer.callId}
          startMs={drawer.startMs}
          api={api}
          liveFindings={state?.findings ?? []}
          onClose={() => setDrawer(null)}
          onFinding={updateFinding}
          onAskPi={(text) => {
            setMessages((previous) => [
              ...previous,
              {
                id: crypto.randomUUID(),
                role: 'notice',
                text: '已将这段证据加入助手上下文。',
                contextKey: selectedTask ? `task:${selectedTask.id}` : 'workbench',
              },
            ]);
            window.dispatchEvent(new CustomEvent('tantei:pi-draft', { detail: text }));
            setPiMobileOpen(true);
            setDrawer(null);
          }}
        />
      )}
    </div>
  );
}
