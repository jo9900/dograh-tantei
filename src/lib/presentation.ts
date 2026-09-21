import { removeRetiredAudioCaveats } from '../../shared/review-text';
import type { Finding, HandlingAssessment } from '../../shared/types';
import type { CallDetail, FindingCategory, ScenarioResult } from '../types';

export const statusNames: Record<string, string> = {
  draft: '草稿',
  running: '进行中',
  connecting: '连接中',
  paused: '已暂停',
  stopped: '已停止',
  completed: '已完成',
  error: '连接失败',
  interrupted: '意外中断',
};

export const findingNames = { candidate: '待确认', confirmed: '已确认', dismissed: '已忽略' };

export const severityNames = { high: '高', medium: '中', low: '低' };

export const scenarioNames: Record<ScenarioResult['status'], string> = {
  observed: '文本中已观察到场景',
  not_observed: '场景未发生',
  contradicted: '模拟来电者偏离场景',
  uncertain: '场景证据不足',
  not_applicable: '无需特定场景',
};

export const formatTime = (seconds: number) =>
  `${Math.floor(Math.max(0, seconds) / 60)
    .toString()
    .padStart(2, '0')}:${Math.floor(Math.max(0, seconds) % 60)
    .toString()
    .padStart(2, '0')}`;

export const dateLabel = (date: string) =>
  new Date(date).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });

export const errorText = (error: unknown) =>
  error instanceof Error ? error.message : '操作失败，请重试。';

export function friendlyEvaluationError(message: string): string {
  if (
    message.includes('evidenceIds') &&
    /(?:too_big|at most|<=)/i.test(message) &&
    /\b20\b/.test(message)
  )
    return '证据引用超过旧版上限，请打开通话重新评审。';
  if (/^\s*[\[{]/.test(message) && /(?:invalid_type|too_big|invalid_value|ZodError)/.test(message))
    return '旧版评审结果格式不符合要求，请打开通话重新评审。';
  return message;
}

export const DEFAULT_PI_MODEL = 'gpt-5.6-sol';

export const piProviderNames: Record<string, string> = {
  'openai-codex': 'Codex 订阅',
  openai: 'OpenAI API',
  anthropic: 'Claude API',
};

export const defaultPiModel = (provider: string) =>
  provider === 'anthropic' ? 'claude-opus-5' : DEFAULT_PI_MODEL;

export const ENVIRONMENT_LOADED = '已从 .env / 环境变量加载';

export function verifiedDograhRunUrl(detail: CallDetail | null): string | null {
  if (
    !detail?.dograhRunUrl ||
    !Number.isSafeInteger(detail.call.workflowId) ||
    detail.call.workflowId <= 0 ||
    !Number.isSafeInteger(detail.call.runId) ||
    (detail.call.runId ?? 0) <= 0
  )
    return null;
  try {
    const url = new URL(detail.dograhRunUrl);
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== `/workflow/${detail.call.workflowId}/run/${detail.call.runId}`
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}

export function findingCategory(finding: Finding): FindingCategory {
  if (finding.source === 'timer') return 'timing';
  return (finding.evaluatorVersion ?? 0) >= 3 && finding.category ? finding.category : 'legacy';
}

export const categoryNames: Record<FindingCategory, string> = {
  business_outcome: '目标未完成',
  agent_behavior: 'AI 客服问题',
  observation: '补充观察',
  legacy: '旧版未区分',
  timing: '时间检测',
};

export const handlingNames: Record<HandlingAssessment['status'], string> = {
  appropriate: 'AI 客服应对合理',
  inappropriate: 'AI 客服应对不合理',
  uncertain: '应对证据不足',
  not_applicable: '无需单独判断应对',
};

/** Hide retired recording-review boilerplate in already-saved reports. */
export function findingText(text: string): string {
  return removeRetiredAudioCaveats(text)
    .replaceAll('业务目标未达成不等于客服处理错误；后台原因尚需执行记录核实。', '')
    .replaceAll('低优先观察，不计为目标失败。', '')
    .replaceAll('客服行为候选问题。', '')
    .replaceAll('请试听确认。', '')
    .replaceAll('尚未独立核对录音；', '')
    .replaceAll('片段按转写到达本地的时间定位。', '')
    .replaceAll('包含独立录音转写；定位为音频片段范围，识别仍可能出错。', '')
    .replaceAll('不代表逐字声学对齐。', '')
    .replaceAll(
      '部分转写在录音结束后才到达，回放范围已限制在录音内；这些迟到片段无法精确对齐，请同时检查通话尾部。',
      '',
    )
    .trim();
}
