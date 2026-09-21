export type TaskStatus = 'draft' | 'running' | 'paused' | 'stopped' | 'completed';
export interface TestRules {
  callerInstructions: string;
  responseTimeoutSeconds: number | null;
  assertions: string[];
  interpretation: string;
  source: 'pi' | 'manual';
  /** Independent transcription of saved audio; incurs separate API usage. */
  audioReview?: boolean;
}
export interface TestTask {
  id: string;
  name: string;
  workflowId: number;
  workflowName: string;
  requirement: string;
  language: string;
  concurrency: number;
  maxCalls: number;
  maxDurationSeconds: number;
  maxVoiceMinutes: number;
  rules: TestRules;
  status: TaskStatus;
  createdAt: string;
  completedCalls: number;
  failedCalls: number;
  consumedSeconds: number;
  workflowHash?: string;
  connectionFingerprint?: string;
  pauseReason?: string;
  evaluationError?: string;
  resultRevision?: number;
  summary?: TaskSummary;
}
export interface JevEvaluation {
  status: 'pending' | 'complete' | 'unavailable';
  overall?: 'pass' | 'fail' | 'inconclusive';
  generatedAt: string;
  inputHash?: string;
  model?: string;
  error?: string;
}
export interface CallRecord {
  jevEvaluation?: JevEvaluation;
  id: string;
  taskId: string;
  workflowId: number;
  runId?: number;
  status: 'connecting' | 'running' | 'completed' | 'error' | 'stopped' | 'interrupted';
  startedAt: string;
  endedAt?: string;
  durationSeconds: number;
  workflowHash?: string;
  definitionId?: number | string;
  version?: number | string;
  error?: string;
  evaluationStatus?: 'pending' | 'complete' | 'unavailable';
  evaluationOverall?: 'pass' | 'fail' | 'inconclusive';
  audio?: { caller?: boolean; agent?: boolean; mixed?: boolean };
  finalUsageConfirmed?: boolean;
  usage?: unknown;
  versionIntegrity?: 'checked' | 'changed' | 'unverified';
}
export type AssessmentCategory = 'agent_behavior' | 'business_outcome' | 'observation';
export type TaskSummaryCategory = AssessmentCategory | 'timing' | 'legacy';
export interface TaskSummaryGroup {
  id: string;
  title: string;
  detail: string;
  severity: Finding['severity'];
  category: TaskSummaryCategory;
  findingIds: string[];
  callIds: string[];
}
export interface TaskSummary {
  version: 1;
  revisionId: string;
  resultRevision: number;
  generatedAt: string;
  reviewedCallIds: string[];
  findingIds: string[];
  passCallIds: string[];
  inconclusiveCallIds: string[];
  headline: string;
  body: string;
  points: string[];
  groups: TaskSummaryGroup[];
}
export interface HandlingAssessment {
  status: 'appropriate' | 'inappropriate' | 'uncertain' | 'not_applicable';
  reason: string;
  evidenceIds: string[];
}
export interface Finding {
  id: string;
  taskId: string;
  callId: string;
  kind: string;
  title: string;
  detail: string;
  severity: 'high' | 'medium' | 'low';
  startMs: number;
  endMs: number;
  measuredSeconds?: number;
  source: 'timer' | 'judge';
  state: 'candidate' | 'confirmed' | 'dismissed';
  createdAt: string;
  evidence?: string[];
  evaluatorVersion?: number;
  category?: AssessmentCategory;
  handling?: HandlingAssessment;
  reviewNote?: string;
}
export interface AppEvent {
  type: string;
  taskId?: string;
  callId?: string;
  [key: string]: unknown;
}
export interface PublicSettings {
  dograhBaseUrl: string;
  dograhKeySet: boolean;
  openaiKeySet: boolean;
  typesafeKeySet?: boolean;
  dograhAuthMode: 'apiKey' | 'token';
  dograhTokenSet: boolean;
  dograhCredentialSet: boolean;
  maxConcurrency: number;
  voice: string;
  dataDir: string;
  environment?: {
    dograhBaseUrl: boolean;
    dograhLoginToken: boolean;
    openaiApiKey: boolean;
    piOpenaiApiKey: boolean;
    piAnthropicApiKey?: boolean;
    typesafeApiKey?: boolean;
  };
}
export interface Settings {
  dograhBaseUrl: string;
  dograhApiKey: string;
  openaiApiKey: string;
  typesafeApiKey?: string;
  dograhAuthMode?: 'apiKey' | 'token';
  dograhLoginToken?: string;
  dograhApiKeyBaseUrl?: string;
  dograhLoginTokenBaseUrl?: string;
  maxConcurrency: number;
  voice: string;
}
export interface WorkbenchState {
  tasks: TestTask[];
  calls: CallRecord[];
  findings: Finding[];
  settings: PublicSettings;
  activeCalls: number;
  summaryRunningTaskIds: string[];
  pi: Record<string, unknown>;
  audioReady: boolean;
}
