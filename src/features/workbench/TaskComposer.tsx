import { ArrowRight, CheckCheck, ChevronDown, Play } from 'lucide-react';
import type { FormEvent } from 'react';
import { useEffect, useState } from 'react';
import type { TestRules, TestTask } from '../../../shared/types';
import { Busy, Field } from '../../components/ui';
import { errorText } from '../../lib/presentation';
import type { Api, WorkflowChoice } from '../../types';

export function TaskComposer({
  api,
  workflows,
  maxConcurrency,
  piReady,
  ready,
  onSettings,
  onCreated,
  onError,
}: {
  api: Api;
  workflows: WorkflowChoice[];
  maxConcurrency: number;
  piReady: boolean;
  ready: boolean;
  onSettings: () => void;
  onCreated: (task: TestTask) => void;
  onError: (message: string) => void;
}) {
  const [name, setName] = useState('');
  const [workflowId, setWorkflowId] = useState(workflows[0]?.id ?? 0);
  const [language, setLanguage] = useState('ja');
  const [requirement, setRequirement] = useState('');
  const [concurrency, setConcurrency] = useState(Math.min(5, maxConcurrency));
  const [maxCalls, setMaxCalls] = useState(10);
  const [duration, setDuration] = useState(600);
  const [minutes, setMinutes] = useState(100);
  const [timeout, setTimeoutValue] = useState('');
  const [rules, setRules] = useState<TestRules | null>(null);
  const [pending, setPending] = useState<'plan' | 'start' | null>(null);
  useEffect(() => {
    if (!workflowId && workflows.length) setWorkflowId(workflows[0].id);
  }, [workflows, workflowId]);
  const resetPlan = () => setRules(null);
  async function plan() {
    if (!workflowId || !requirement.trim()) {
      onError('请选择 workflow，并写下要验证的行为。');
      return;
    }
    setPending('plan');
    try {
      const result = await api<{ rules: TestRules }>('/api/tasks/plan', {
        requirement,
        language,
        workflowId,
        ...(timeout ? { responseTimeoutSeconds: Number(timeout) } : {}),
      });
      setRules(result.rules);
    } catch (e) {
      onError(errorText(e));
    } finally {
      setPending(null);
    }
  }
  async function start(event: FormEvent) {
    event.preventDefault();
    if (!rules) return;
    setPending('start');
    try {
      const workflow = workflows.find((item) => item.id === workflowId)!;
      const result = await api<{ task?: TestTask } & TestTask>('/api/tasks', {
        name: name.trim() || `${workflow.name} · ${new Date().toLocaleDateString('zh-CN')}`,
        workflowId,
        workflowName: workflow.name,
        requirement,
        language,
        concurrency,
        maxCalls,
        maxDurationSeconds: duration,
        maxVoiceMinutes: minutes,
        rules,
      });
      onCreated(result.task ?? result);
    } catch (e) {
      onError(errorText(e));
    } finally {
      setPending(null);
    }
  }
  return (
    <section className="composer">
      <div className="section-heading">
        <h2>定义一场测试</h2>
        <span className="step-indicator">
          {rules ? '检查条件 → 开始运行' : '描述目标 → 整理条件'}
        </span>
      </div>
      <form onSubmit={start}>
        <div className="form-grid two">
          <Field label="AI 客服 workflow">
            <select
              data-autofocus
              value={workflowId || ''}
              onChange={(event) => {
                setWorkflowId(Number(event.target.value));
                resetPlan();
              }}
              required
            >
              <option value="" disabled>
                {workflows.length ? '选择一个 workflow' : '连接 Dograh 后读取 workflows'}
              </option>
              {workflows.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="测试名称">
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="例如：订单数量确认与回应时延"
              maxLength={120}
            />
          </Field>
        </div>
        <Field label="你想发现什么问题？">
          <textarea
            rows={3}
            value={requirement}
            onChange={(event) => {
              setRequirement(event.target.value);
              resetPlan();
            }}
            placeholder="例如：用日语询问订单，将数量从一件改为两件，并请 AI 客服复述最终数量。如果 AI 客服超过 10 秒没有回应，记录发生时间。"
            required
          />
        </Field>
        <div className="form-grid limits">
          <Field label="对话语言">
            <select
              value={language}
              onChange={(event) => {
                setLanguage(event.target.value);
                resetPlan();
              }}
            >
              <option value="ja">日语</option>
              <option value="zh">中文</option>
              <option value="en">英语</option>
              <option value="ko">韩语</option>
            </select>
          </Field>
          <Field label="并发通话">
            <input
              type="number"
              min={1}
              max={maxConcurrency}
              value={concurrency}
              onChange={(event) => setConcurrency(Number(event.target.value))}
              required
            />
          </Field>
          <Field label="最多通话次数">
            <input
              type="number"
              min={1}
              max={1000}
              value={maxCalls}
              onChange={(event) => setMaxCalls(Number(event.target.value))}
              required
            />
          </Field>
          <Field label="单次上限（秒）">
            <input
              type="number"
              min={20}
              max={900}
              value={duration}
              onChange={(event) => setDuration(Number(event.target.value))}
              required
            />
          </Field>
          <Field label="总语音上限（分钟）">
            <input
              type="number"
              min={1}
              max={10000}
              value={minutes}
              onChange={(event) => setMinutes(Number(event.target.value))}
              required
            />
          </Field>
          <Field label="回应超时（秒）">
            <input
              type="number"
              min={1}
              max={300}
              value={timeout}
              onChange={(event) => {
                setTimeoutValue(event.target.value);
                resetPlan();
              }}
              placeholder="按目标解析"
            />
          </Field>
        </div>
        {rules ? (
          <div className="rules-preview">
            <div className="preview-title">
              <CheckCheck size={17} />
              <h3>确认测试条件</h3>
              <span>{rules.source === 'pi' ? 'Pi 整理' : '手动设置'}</span>
            </div>
            <p>{rules.interpretation}</p>
            <p className="small muted">
              使用 Dograh 转写评审，并保留录音与 Gathered Context；不额外请求语音转写。
            </p>
            <Field
              label="原需求的主目标 · 每行一条，最多 8 条"
              hint="只列原需求明确要求的目标；细节与异常话术作为证据或补充观察，不新增主目标。"
            >
              <textarea
                rows={Math.max(2, Math.min(5, rules.assertions.length))}
                value={rules.assertions.join('\n')}
                onChange={(event) =>
                  setRules({
                    ...rules,
                    source: 'manual',
                    assertions: event.target.value.split('\n').filter(Boolean).slice(0, 8),
                  })
                }
                placeholder="写下可判定的要求，例如：结束前必须确认最终订单数量。"
              />
            </Field>
            <details>
              <summary>
                查看与调整模拟来电者指令 <ChevronDown size={14} />
              </summary>
              <textarea
                rows={5}
                aria-label="模拟来电者指令"
                value={rules.callerInstructions}
                onChange={(event) =>
                  setRules({ ...rules, source: 'manual', callerInstructions: event.target.value })
                }
              />
            </details>
            <p className="small muted">
              {rules.responseTimeoutSeconds
                ? `回应超过 ${rules.responseTimeoutSeconds} 秒会标记为候选问题。`
                : '未设定声学回应超时规则。'}{' '}
              业务判断与时间检测分别保留证据。
            </p>
          </div>
        ) : (
          !piReady && (
            <p className="inline-hint">
              当前可提取明确的时延要求。连接 Pi 后可进一步整理业务检查项。
              <button type="button" className="text-button" onClick={onSettings}>
                去连接
                <ArrowRight size={13} />
              </button>
            </p>
          )
        )}
        <div className="composer-footer">
          <span>{concurrency} 路并发 · 达到任一上限即停止派发新通话</span>
          <div className="button-group">
            {rules ? (
              <>
                <button type="button" className="button secondary" onClick={() => setRules(null)}>
                  重新整理
                </button>
                <button
                  className="button primary"
                  type="submit"
                  disabled={!!pending || !ready || !workflowId}
                >
                  {pending === 'start' ? <Busy /> : <Play size={15} />}开始测试
                </button>
              </>
            ) : (
              <button
                className="button primary"
                type="button"
                onClick={() => void plan()}
                disabled={!!pending || !workflowId || !requirement.trim()}
              >
                {pending === 'plan' ? <Busy /> : <ArrowRight size={16} />}用Pi整理测试条件
              </button>
            )}
          </div>
        </div>
        {rules && !ready && (
          <p className="inline-hint">
            开始测试前，请完成 Dograh、语音密钥与音频环境配置。
            <button type="button" className="text-button" onClick={onSettings}>
              查看连接
            </button>
          </p>
        )}
      </form>
    </section>
  );
}
