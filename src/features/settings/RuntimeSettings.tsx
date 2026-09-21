import { Check } from 'lucide-react';
import { useEffect, useState } from 'react';
import { DEFAULT_MAX_CONCURRENCY, MAX_CONFIGURABLE_CONCURRENCY } from '../../../shared/limits';
import { Busy, Field } from '../../components/ui';
import type { SettingsPanelProps } from './settingsTypes';

export function RuntimeSettings({ state, api, pending, perform, onNotice }: SettingsPanelProps) {
  const [limit, setLimit] = useState(state.settings.maxConcurrency);
  useEffect(() => {
    setLimit(state.settings.maxConcurrency);
  }, [state.settings.maxConcurrency]);
  const minimum = Math.max(1, state.activeCalls);
  const valid =
    Number.isInteger(limit) && limit >= minimum && limit <= MAX_CONFIGURABLE_CONCURRENCY;
  return (
    <section className="settings-section" aria-labelledby="runtime-settings-title">
      <div className="settings-heading">
        <div>
          <h2 id="runtime-settings-title">运行设置</h2>
          <p>管理所有测试任务共享的资源。</p>
        </div>
      </div>
      <form
        className="settings-fields"
        onSubmit={(event) => {
          event.preventDefault();
          if (valid && !pending)
            void perform('runtime', async () => {
              await api('/api/settings/concurrency', { maxConcurrency: limit });
              onNotice('全局并发上限已更新。');
            });
        }}
      >
        <Field
          label="全局并发上限"
          hint={`默认 ${DEFAULT_MAX_CONCURRENCY} 路，最多 ${MAX_CONFIGURABLE_CONCURRENCY} 路。所有测试任务共用此上限。`}
        >
          <input
            className="concurrency-input"
            type="number"
            min={minimum}
            max={MAX_CONFIGURABLE_CONCURRENCY}
            value={limit}
            required
            disabled={!!pending}
            aria-invalid={!valid}
            onChange={(event) => setLimit(Number(event.target.value))}
          />
        </Field>
        {state.activeCalls > 0 && (
          <p className="settings-note">
            当前 {state.activeCalls}{' '}
            路正在通话，上限不能低于当前占用。提高上限后，等待中的通话可能立即启动。
          </p>
        )}
        <div className="settings-actions">
          <button className="button primary" disabled={!!pending || !valid}>
            {pending === 'runtime' ? <Busy /> : <Check size={14} />}保存设置
          </button>
        </div>
      </form>
      <div className="storage-note">
        <div>
          <h3>本地结果目录</h3>
          <code>{state.settings.dataDir}</code>
          <p>任务、录音、证据与 workflow 快照保存在这里。</p>
        </div>
      </div>
    </section>
  );
}
