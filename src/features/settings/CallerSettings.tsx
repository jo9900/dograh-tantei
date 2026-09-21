import { Check, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Busy, Field } from '../../components/ui';
import { CredentialField } from './CredentialField';
import { savedConnectionSettings, type SettingsPanelProps } from './settingsTypes';

export function CallerSettings({ state, api, pending, perform, onNotice }: SettingsPanelProps) {
  const [key, setKey] = useState('');
  const [voice, setVoice] = useState(state.settings.voice);
  useEffect(() => {
    setVoice(state.settings.voice);
  }, [state.settings.voice]);
  return (
    <section className="settings-section" aria-labelledby="caller-settings-title">
      <div className="settings-heading">
        <div>
          <h2 id="caller-settings-title">模拟来电者</h2>
          <p>使用 GPT-Live 1，与 AI 客服进行语音对话。</p>
        </div>
        <span className={`connection-badge ${state.settings.openaiKeySet ? 'set' : ''}`}>
          {state.settings.openaiKeySet ? '已配置' : '待配置'}
        </span>
      </div>
      <form
        className="settings-fields"
        onSubmit={(event) => {
          event.preventDefault();
          if (!pending)
            void perform('caller', async () => {
              await api('/api/settings', {
                ...savedConnectionSettings(state),
                voice,
                ...(!state.settings.environment?.openaiApiKey && key.trim()
                  ? { openaiApiKey: key }
                  : {}),
              });
              setKey('');
              onNotice('模拟来电者设置已保存。');
            });
        }}
      >
        <CredentialField
          label="OpenAI API Key"
          environmentKey={state.settings.environment?.openaiApiKey ? 'OPENAI_API_KEY' : undefined}
          saved={state.settings.openaiKeySet}
          value={key}
          onChange={setKey}
          disabled={!!pending}
        />
        <p className="settings-note">语音通话使用 API 额度，与 Pi 的 Codex 订阅独立。</p>
        <div className="settings-short-field">
          <Field label="来电者声音">
            <select
              value={voice}
              disabled={!!pending}
              onChange={(event) => setVoice(event.target.value)}
            >
              <option value="marin">Marin</option>
              <option value="cedar">Cedar</option>
            </select>
          </Field>
        </div>
        <div className="environment-line">
          <span className={`status-dot ${state.audioReady ? 'ready-dot' : ''}`} />
          <div>
            <strong>{state.audioReady ? '音频环境已就绪' : '音频环境需要安装'}</strong>
            {!state.audioReady && (
              <p>
                在项目终端执行 <code>npm run setup:audio</code>，完成后刷新状态。
              </p>
            )}
          </div>
          {state.audioReady ? (
            <span className="environment-detail">无需麦克风</span>
          ) : (
            <button
              type="button"
              className="text-button"
              disabled={!!pending}
              onClick={() =>
                void perform('audio-check', async () => {
                  await api('/api/audio/check', {});
                })
              }
            >
              {pending === 'audio-check' ? <Busy /> : <RefreshCw size={13} />}刷新
            </button>
          )}
        </div>
        <div className="settings-actions">
          <button className="button primary" disabled={!!pending}>
            {pending === 'caller' ? <Busy /> : <Check size={14} />}保存设置
          </button>
        </div>
      </form>
    </section>
  );
}
