import { AudioLines, SlidersHorizontal, Workflow } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { WorkbenchState } from '../../../shared/types';
import { errorText } from '../../lib/presentation';
import type { Api, AuthPrompt, PiStatus, WorkflowChoice } from '../../types';
import { JevSettings } from './JevSettings';
import { CallerSettings } from './CallerSettings';
import { DograhSettings } from './DograhSettings';
import { PiConnectionSettings } from './PiConnectionSettings';
import { RuntimeSettings } from './RuntimeSettings';
import type { SettingsPage } from './settingsTypes';

export function SettingsView({
  state,
  api,
  refresh,
  workflowsLoaded,
  authPrompt,
  authEvents,
  onError,
  onNotice,
  initialPage = 'dograh',
}: {
  state: WorkbenchState;
  api: Api;
  refresh: () => Promise<WorkbenchState>;
  workflowsLoaded: (items: WorkflowChoice[]) => void;
  authPrompt: AuthPrompt | null;
  authEvents: Record<string, unknown>[];
  onError: (message: string) => void;
  onNotice: (message: string) => void;
  initialPage?: SettingsPage;
}) {
  const [page, setPage] = useState<SettingsPage>(initialPage);
  const [pending, setPending] = useState('');
  const pi = state.pi as PiStatus;
  useEffect(() => {
    setPage(initialPage);
  }, [initialPage]);
  useEffect(() => {
    if (authPrompt || pi.login) setPage('pi');
  }, [authPrompt, pi.login?.id]);
  async function perform(id: string, action: () => Promise<void>) {
    if (pending) return;
    setPending(id);
    onError('');
    try {
      await action();
      await refresh();
    } catch (error) {
      onError(errorText(error));
    } finally {
      setPending('');
    }
  }
  const panels = [
    {
      id: 'dograh',
      title: 'Dograh',
      detail: '连接被测 AI 客服',
      icon: <Workflow size={20} />,
      ready: state.settings.dograhCredentialSet,
    },
    {
      id: 'caller',
      title: '模拟来电者',
      detail: 'GPT-Live 1 · 语音通话',
      icon: <AudioLines size={20} />,
      ready: state.settings.openaiKeySet,
    },
    {
      id: 'pi',
      title: 'Pi 助手',
      detail: '整理条件、评审与汇总',
      icon: <span className="pi-symbol">π</span>,
      ready: !!pi.configured && !pi.modelError,
    },
    {
      id: 'jev',
      title: 'Jev',
      detail: '判断测试目标是否达成',
      icon: <span>J</span>,
      ready: !!state.settings.typesafeKeySet,
    },
    {
      id: 'runtime',
      title: '运行设置',
      detail: '并发与本地存储',
      icon: <SlidersHorizontal size={20} />,
      ready: null,
    },
  ] as const;
  const props = { state, api, refresh, pending, perform, onNotice };
  return (
    <div className="settings-view settings-redesign">
      <div className="page-heading">
        <h1>连接与设置</h1>
      </div>
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="设置分类">
          {panels.map((item) => (
            <button
              key={item.id}
              aria-current={page === item.id ? 'page' : undefined}
              aria-controls={`settings-${item.id}`}
              onClick={() => setPage(item.id)}
            >
              <span className="settings-nav-icon" aria-hidden="true">
                {item.icon}
              </span>
              <span>
                <strong>{item.title}</strong>
                <small>{item.detail}</small>
              </span>
              {item.ready !== null && (
                <span
                  className={`settings-state-dot ${item.ready ? 'ready' : ''}`}
                  role="img"
                  aria-label={item.ready ? '已配置' : '待配置'}
                />
              )}
            </button>
          ))}
        </nav>
        <div className="settings-content">
          <div id="settings-dograh" hidden={page !== 'dograh'}>
            <DograhSettings {...props} workflowsLoaded={workflowsLoaded} />
          </div>
          <div id="settings-caller" hidden={page !== 'caller'}>
            <CallerSettings {...props} />
          </div>
          <div id="settings-pi" hidden={page !== 'pi'}>
            <PiConnectionSettings
              {...props}
              authPrompt={authPrompt}
              authEvents={authEvents}
              onError={onError}
            />
          </div>
          <div id="settings-jev" hidden={page !== 'jev'}>
            <JevSettings {...props} />
          </div>
          <div id="settings-runtime" hidden={page !== 'runtime'}>
            <RuntimeSettings {...props} />
          </div>
        </div>
      </div>
    </div>
  );
}
