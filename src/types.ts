import type {
  AssessmentCategory,
  CallRecord,
  Finding,
  HandlingAssessment,
  TestRules,
  TestTask,
} from '../shared/types';

export type Api = <T = Record<string, unknown>>(
  url: string,
  body?: unknown,
  method?: string,
) => Promise<T>;

export type WorkflowChoice = { id: number; name: string; status?: string };

export type PiStatus = {
  configured?: boolean;
  busy?: boolean;
  model?: { provider: string; id: string } | null;
  modelError?: string | null;
  environmentApiKeySet?: boolean;
  environmentAnthropicApiKeySet?: boolean;
  providers?: Array<{
    id: string;
    configured: boolean;
    authType?: string;
    authSource?: 'environment' | 'stored' | null;
  }>;
  login?: { id: string; provider: string } | null;
};

export type ChatMessage = {
  contextKey?: string;
  id: string;
  role: 'user' | 'assistant' | 'notice';
  text: string;
  runId?: string;
};

export type AuthPrompt = { promptId: string; prompt: Record<string, unknown> };

export type ScenarioResult = {
  status: 'observed' | 'not_observed' | 'contradicted' | 'uncertain' | 'not_applicable';
  reason: string;
  evidenceIds: string[];
};

export type AssertionResult = {
  assertionIndex: number;
  status: 'pass' | 'fail' | 'inconclusive';
  reason: string;
  scenario?: ScenarioResult;
  category?: AssessmentCategory;
  handling?: HandlingAssessment;
};

export type CallDetail = {
  dograh?: {
    transcript: Array<{ speaker: 'caller' | 'agent'; text: string; atMs: number }>;
    gatheredContext: unknown;
    recordings: Record<'mixed' | 'caller' | 'agent', boolean>;
    timingBasis: string;
  } | null;
  dograhError?: string | null;
  call: CallRecord;
  dograhRunUrl?: string | null;
  events: Record<string, unknown>[];
  findings: Finding[];
  task?: TestTask;
  reviewPending?: boolean;
  evaluationAttempt?: { status: 'failed'; error: string } | null;
  evaluation?: {
    source?: string;
    version?: number;
    status: 'complete' | 'unavailable';
    overall?: 'pass' | 'fail' | 'inconclusive' | null;
    rules?: Pick<TestRules, 'assertions'>;
    judgment?: { summary?: string; assertions?: AssertionResult[] };
    error?: string;
    limitations?: string[];
  } | null;
};

export type FindingCategory = AssessmentCategory | 'legacy' | 'timing';
