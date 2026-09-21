import { Check, ExternalLink } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { WorkbenchState } from '../../../shared/types';
import { Busy, Field } from '../../components/ui';
import {
  DEFAULT_PI_MODEL,
  defaultPiModel,
  errorText,
  piProviderNames,
} from '../../lib/presentation';
import type { Api, AuthPrompt, PiStatus } from '../../types';
import { AuthNotification } from './AuthNotification';
import { CredentialField } from './CredentialField';

export function PiConnectionSettings({
  state,
  api,
  refresh,
  authPrompt,
  authEvents,
  onError,
  onNotice,
  pending,
  perform,
}: {
  state: WorkbenchState;
  api: Api;
  refresh: () => Promise<WorkbenchState>;
  authPrompt: AuthPrompt | null;
  authEvents: Record<string, unknown>[];
  onError: (message: string) => void;
  onNotice: (message: string) => void;
  pending: string;
  perform: (id: string, action: () => Promise<void>) => Promise<void>;
}) {
  const environment = state.settings.environment;
  const [piKeys, setPiKeys] = useState<Record<string, string>>({ openai: '', anthropic: '' });
  const [authAnswer, setAuthAnswer] = useState('');
  const pi = state.pi as PiStatus;
  const [provider, setProvider] = useState(
    pi.model?.provider ?? (environment?.piOpenaiApiKey ? 'openai' : 'openai-codex'),
  );
  const [modelId, setModelId] = useState(pi.model?.id ?? DEFAULT_PI_MODEL);
  const [models, setModels] = useState<Array<{ provider: string; id: string; name: string }>>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const modelDraftEdited = useRef(false);
  useEffect(() => {
    let active = true;
    setModelsLoading(true);
    setModels([]);
    void api<{ models: Array<{ provider: string; id: string; name: string }> }>(
      `/api/pi/models?provider=${encodeURIComponent(provider)}`,
    )
      .then((result) => {
        if (!active) return;
        const preferred = result.models.find((item) => item.id === defaultPiModel(provider));
        setModels(
          preferred
            ? [preferred, ...result.models.filter((item) => item !== preferred)]
            : result.models,
        );
        setModelId((current) =>
          result.models.some((item) => item.id === current)
            ? current
            : (preferred?.id ?? result.models[0]?.id ?? ''),
        );
      })
      .catch((e) => {
        if (active) onError(errorText(e));
      })
      .finally(() => {
        if (active) setModelsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [api, provider, pi.configured, onError]);
  useEffect(() => {
    if (!pending && !modelDraftEdited.current && pi.model?.provider && pi.model.id) {
      setProvider(pi.model.provider);
      setModelId(pi.model.id);
    }
  }, [pi.model?.provider, pi.model?.id, pending]);
  const selectedProvider = pi.providers?.find((item) => item.id === provider);
  const providerConnected = !!selectedProvider?.configured;
  const piKeyFromEnvironment =
    selectedProvider?.authSource === 'environment' ||
    (provider === 'openai'
      ? environment?.piOpenaiApiKey || pi.environmentApiKeySet
      : provider === 'anthropic'
        ? environment?.piAnthropicApiKey || pi.environmentAnthropicApiKeySet
        : false);
  const piKey = piKeys[provider] ?? '';
  const piDraftChanged = provider !== pi.model?.provider || modelId !== pi.model?.id;
  const applyPiModel = async () => {
    let keySaved = false;
    if (provider !== 'openai-codex' && !piKeyFromEnvironment && piKey.trim()) {
      await api('/api/pi/key', { key: piKey.trim(), provider });
      keySaved = true;
      setPiKeys((previous) => ({ ...previous, [provider]: '' }));
    }
    try {
      await api('/api/pi/model', { provider, id: modelId });
    } catch (failure) {
      await refresh();
      throw new Error(`${keySaved ? '密钥已保存，但模型未能应用：' : ''}${errorText(failure)}`);
    }
    modelDraftEdited.current = false;
    onNotice(`Pi 已使用 ${piProviderNames[provider] ?? provider} · ${modelId}。`);
  };
  return (
    <section className="settings-section">
      <div className="settings-heading">
        <div>
          <h2>Pi 助手</h2>
          <p>整理测试条件、评审通话、汇总问题和协助迭代 Dograh Voice Agent。</p>
        </div>
        <span className={`connection-badge ${pi.configured && !pi.modelError ? 'set' : ''}`}>
          {pi.modelError ? '模型待配置' : pi.configured ? '已连接' : '待连接'}
        </span>
      </div>
      <div className="settings-fields">
        <h3 className="settings-field-title">连接方式</h3>
        <div className="pi-provider-options" aria-label="Pi 连接方式">
          {(['openai-codex', 'openai', 'anthropic'] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={provider === value}
              className={provider === value ? 'selected' : ''}
              disabled={!!pending || !!pi.login}
              onClick={() => {
                modelDraftEdited.current = true;
                setProvider(value);
                setModelId(defaultPiModel(value));
              }}
            >
              <strong>{piProviderNames[value]}</strong>
            </button>
          ))}
        </div>
        <div className="pi-provider-fields">
          {provider === 'openai-codex' ? (
            <div className="pi-codex-connection">
              <div>
                <strong>{providerConnected ? 'Codex 账号已连接' : '登录自己的 Codex 账号'}</strong>
                <p>通过账号授权使用订阅额度。</p>
              </div>
              <button
                className="button secondary"
                disabled={!!pending || !!pi.busy || !!pi.login}
                onClick={() =>
                  void perform('oauth', async () => {
                    await api('/api/pi/login', {});
                  })
                }
              >
                {pending === 'oauth' || pi.login ? <Busy /> : <ExternalLink size={14} />}
                {pi.login ? '等待登录完成' : providerConnected ? '重新登录' : '登录 Codex'}
              </button>
            </div>
          ) : (
            <CredentialField
              label={provider === 'anthropic' ? 'Claude API Key' : 'Pi OpenAI API Key'}
              environmentKey={
                piKeyFromEnvironment
                  ? provider === 'anthropic'
                    ? 'PI_ANTHROPIC_API_KEY'
                    : environment?.piOpenaiApiKey
                      ? 'PI_OPENAI_API_KEY'
                      : 'OPENAI_API_KEY'
                  : undefined
              }
              saved={providerConnected}
              value={piKey}
              disabled={!!pending || !!pi.busy}
              onChange={(value) => {
                modelDraftEdited.current = true;
                setPiKeys((previous) => ({ ...previous, [provider]: value }));
              }}
              hint="用于 Pi 分析和评审；已保存的密钥留空保留。"
            />
          )}
        </div>
        {(pi.login || authPrompt || authEvents.length > 0) && (
          <div className="auth-progress">
            <h3>完成账号授权</h3>
            {authEvents.map((event, index) => (
              <AuthNotification key={index} event={event} />
            ))}
            {authPrompt && (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void perform('answer', async () => {
                    await api('/api/pi/login/answer', {
                      promptId: authPrompt.promptId,
                      value: authAnswer,
                    });
                    setAuthAnswer('');
                  });
                }}
              >
                <Field
                  label={String(
                    authPrompt.prompt.message ??
                      authPrompt.prompt.title ??
                      authPrompt.prompt.label ??
                      '输入授权结果',
                  )}
                >
                  {authPrompt.prompt.type === 'select' &&
                  Array.isArray(authPrompt.prompt.options) ? (
                    <select
                      value={authAnswer}
                      onChange={(event) => setAuthAnswer(event.target.value)}
                    >
                      <option value="">请选择</option>
                      {(authPrompt.prompt.options as Array<Record<string, unknown>>).map(
                        (option, index) => (
                          <option
                            key={index}
                            value={String(option.value ?? option.id ?? option.label)}
                          >
                            {String(option.label ?? option.value ?? option.id)}
                          </option>
                        ),
                      )}
                    </select>
                  ) : (
                    <input
                      type={authPrompt.prompt.type === 'secret' ? 'password' : 'text'}
                      value={authAnswer}
                      onChange={(event) => setAuthAnswer(event.target.value)}
                      autoComplete="off"
                      placeholder={String(authPrompt.prompt.placeholder ?? '粘贴授权码或回调地址')}
                    />
                  )}
                </Field>
                <button className="button primary" disabled={!!pending || !authAnswer.trim()}>
                  {pending === 'answer' ? <Busy /> : <Check size={14} />}继续
                </button>
              </form>
            )}
            <button
              className="text-button"
              onClick={() =>
                void perform('cancel-login', async () => {
                  await api('/api/pi/login/cancel', {});
                })
              }
            >
              取消登录
            </button>
          </div>
        )}
        <div className="model-picker">
          <Field
            label="分析模型"
            hint={
              provider === 'anthropic'
                ? '默认 Claude Opus 5，也可选择其他可用模型。'
                : '默认 gpt-5.6-sol，也可选择其他可用模型。'
            }
          >
            <select
              value={modelId}
              disabled={modelsLoading || !!pending || !!pi.busy}
              onChange={(event) => {
                modelDraftEdited.current = true;
                setModelId(event.target.value);
              }}
            >
              {!models.length && (
                <option value="">{modelsLoading ? '正在读取模型…' : '暂无可用模型'}</option>
              )}
              {models.map((model) => (
                <option key={`${model.provider}:${model.id}`} value={model.id}>
                  {model.name || model.id}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div className="pi-apply-row">
          <button
            className="button primary"
            disabled={
              !!pending ||
              !!pi.login ||
              modelsLoading ||
              !modelId ||
              (!providerConnected && !(provider !== 'openai-codex' && piKey.trim())) ||
              !!pi.busy
            }
            onClick={() => void perform('model', applyPiModel)}
          >
            {pending === 'model' ? <Busy /> : <Check size={14} />}
            保存并使用
          </button>
          <span className="small muted model-hint">
            {pi.busy
              ? 'Pi 正在工作，结束后可切换。'
              : !providerConnected && !piKey.trim()
                ? provider === 'openai-codex'
                  ? '先完成账号授权。'
                  : '先填写所选提供方的密钥。'
                : piDraftChanged || piKey.trim()
                  ? '更改尚未应用。'
                  : '与当前使用的模型一致。'}
          </span>
        </div>
        <div className="pi-current-model">
          <span>当前使用</span>
          <strong>
            {pi.model && pi.configured
              ? `${piProviderNames[pi.model.provider] ?? pi.model.provider} · ${pi.model.id}`
              : '尚未连接模型'}
          </strong>
          {pi.modelError && (
            <p className="error-ink" role="alert">
              {pi.modelError}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
