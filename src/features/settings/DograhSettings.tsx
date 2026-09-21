import { Check, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Busy, Field } from '../../components/ui';
import { errorText } from '../../lib/presentation';
import type { WorkflowChoice } from '../../types';
import { CredentialField } from './CredentialField';
import { savedConnectionSettings, type SettingsPanelProps } from './settingsTypes';

export function DograhSettings({
  state,
  api,
  refresh,
  pending,
  perform,
  workflowsLoaded,
}: SettingsPanelProps & { workflowsLoaded: (items: WorkflowChoice[]) => void }) {
  const environment = state.settings.environment;
  const locked =
    !!environment?.dograhBaseUrl ||
    (!!environment?.dograhLoginToken && !!state.settings.dograhBaseUrl);
  const [baseUrl, setBaseUrl] = useState(state.settings.dograhBaseUrl);
  const [token, setToken] = useState('');
  const [result, setResult] = useState('');
  useEffect(() => {
    setBaseUrl(state.settings.dograhBaseUrl);
    setResult('');
  }, [state.settings.dograhBaseUrl]);
  const sameServer =
    baseUrl.trim().replace(/\/+$/, '') === state.settings.dograhBaseUrl.replace(/\/+$/, '');
  const saved = sameServer && state.settings.dograhTokenSet;
  async function saveAndCheck() {
    setResult('');
    await api('/api/settings', {
      ...savedConnectionSettings(state),
      dograhBaseUrl: locked ? state.settings.dograhBaseUrl : baseUrl,
      ...(!environment?.dograhLoginToken && token.trim() ? { dograhLoginToken: token } : {}),
    });
    setToken('');
    workflowsLoaded([]);
    const next = await refresh();
    if (!next.settings.dograhCredentialSet)
      throw new Error('设置已保存。请填写 Dograh 登录 Token，再验证连接。');
    try {
      const checked = await api<{ workflows: WorkflowChoice[] }>('/api/connection/check', {});
      workflowsLoaded(checked.workflows);
      setResult(`认证成功，已读取 ${checked.workflows.length} 个 workflows。`);
    } catch (error) {
      throw new Error(`设置已保存，但连接验证失败：${errorText(error)}`);
    }
  }
  return (
    <section className="settings-section" aria-labelledby="dograh-settings-title">
      <div className="settings-heading">
        <div>
          <h2 id="dograh-settings-title">Dograh 连接</h2>
          <p>连接你的 Dograh，读取可测试的 workflows。</p>
        </div>
        <span className={`connection-badge ${saved ? 'set' : ''}`}>
          {saved ? '已配置' : '待配置'}
        </span>
      </div>
      <form
        className="settings-fields"
        onSubmit={(event) => {
          event.preventDefault();
          if (!pending) void perform('dograh', saveAndCheck);
        }}
      >
        <Field
          label="后端地址"
          hint={
            environment?.dograhBaseUrl
              ? '来自 .env / 环境变量 · DOGRAH_BASE_URL'
              : locked
                ? '此地址与环境变量中的 Token 绑定，请在启动配置中一起更新。'
                : '通常填写站点域名；前后端分离时，填写后端 API 地址。'
          }
        >
          <input
            type="url"
            value={baseUrl}
            readOnly={locked}
            required
            disabled={!!pending}
            spellCheck={false}
            placeholder="https://dograh.example.com"
            onChange={(event) => {
              setBaseUrl(event.target.value);
              setResult('');
            }}
          />
        </Field>
        <CredentialField
          label="登录 Token"
          environmentKey={environment?.dograhLoginToken ? 'DOGRAH_LOGIN_TOKEN' : undefined}
          saved={saved}
          value={token}
          onChange={(value) => {
            setToken(value);
            setResult('');
          }}
          disabled={!!pending}
        />
        <details className="settings-help">
          <summary>如何获取或更新 Token</summary>
          <p>
            复制已登录 Dograh 的 dograh_auth_token Cookie 值，也可粘贴带 Bearer 前缀的
            Token。不要粘贴整段 curl 或其他 Cookie。Token 过期后重新登录获取；使用 .env 时，更新
            DOGRAH_LOGIN_TOKEN 并重启服务。更换服务器时同步更新地址与 Token。
          </p>
        </details>
        <div className="settings-actions">
          <button className="button primary" disabled={!!pending || !baseUrl.trim()}>
            {pending === 'dograh' ? <Busy /> : <RefreshCw size={14} />}
            {locked && environment?.dograhLoginToken ? '验证连接' : '保存并验证'}
          </button>
          {result && (
            <span className="success-message" role="status">
              <Check size={14} />
              {result}
            </span>
          )}
        </div>
      </form>
    </section>
  );
}
