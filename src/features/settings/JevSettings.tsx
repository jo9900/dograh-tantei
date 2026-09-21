import { Check } from 'lucide-react';
import { useState } from 'react';
import { Busy } from '../../components/ui';
import { CredentialField } from './CredentialField';
import type { SettingsPanelProps } from './settingsTypes';

export function JevSettings({ state, api, pending, perform, onNotice }: SettingsPanelProps) {
  const [key, setKey] = useState('');
  const managed = !!state.settings.environment?.typesafeApiKey;
  return (
    <section className="settings-section" aria-labelledby="jev-settings-title">
      <div className="settings-heading">
        <div>
          <h2 id="jev-settings-title">Jev</h2>
          <p>根据测试目标、Dograh 对话和通话上下文判断结果。</p>
        </div>
        <span className={`connection-badge ${state.settings.typesafeKeySet ? 'set' : ''}`}>
          {state.settings.typesafeKeySet ? '已配置' : '待配置'}
        </span>
      </div>
      <form
        className="settings-fields"
        onSubmit={(event) => {
          event.preventDefault();
          if (!pending && !managed)
            void perform('jev', async () => {
              await api('/api/settings/jev', key.trim() ? { apiKey: key } : {});
              setKey('');
              onNotice('Jev 设置已保存。');
            });
        }}
      >
        <CredentialField
          label="Jev API Key"
          environmentKey={managed ? 'TYPESAFE_API_KEY' : undefined}
          saved={state.settings.typesafeKeySet}
          value={key}
          onChange={setKey}
          disabled={!!pending}
        />
        {!managed && (
          <div className="settings-actions">
            <button
              className="button primary"
              disabled={!!pending || (!key.trim() && !state.settings.typesafeKeySet)}
            >
              {pending === 'jev' ? <Busy /> : <Check size={14} />}保存设置
            </button>
          </div>
        )}
      </form>
    </section>
  );
}
