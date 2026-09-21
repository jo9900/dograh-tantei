import { createHash } from 'node:crypto';
import { DograhAuthError, normalizeDograhCredential } from './dograh-auth.js';
import type { DograhAuthMode } from './dograh-auth.js';

export type JsonObject = Record<string, unknown>;
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export type WorkflowId = number | string;

export interface DograhConfig {
  /** Backend origin or explicit API base, e.g. https://host/backend/api/v1. */
  baseUrl: string;
  /** Defaults to API key authentication for existing installations. */
  authMode?: DograhAuthMode;
  apiKey?: string;
  loginToken?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface WorkflowSummary extends JsonObject {
  id: number;
  name: string;
  status?: string;
}

export interface Workflow extends WorkflowSummary {
  workflow_definition: JsonObject;
  current_definition_id?: number | null;
  version_number?: number | null;
  version_status?: string | null;
}

export interface WorkflowRun extends JsonObject {
  id: number;
  workflow_id?: number;
  definition_id?: number | null;
  is_completed?: boolean;
}

export interface WorkflowVersion extends JsonObject {
  id: number;
  version_number: number;
  status: string;
  workflow_json: JsonObject;
  workflow_configurations?: JsonObject;
  template_context_variables?: JsonObject;
}

export interface TextSession extends JsonObject {
  workflow_run_id: number;
  workflow_id: number;
  revision: number;
  is_completed: boolean;
  session_data: JsonObject;
}

export interface CreateTextSessionOptions {
  name?: string;
  initial_context?: JsonObject;
  annotations?: JsonObject;
}

export interface PromptField {
  nodeId: string;
  nodeName: string;
  /** JSON Pointer relative to workflow_definition, including the node index. */
  path: string;
  value: string;
}

export interface PromptChange {
  nodeId: string;
  path: string;
  before: string;
  after: string;
}

export interface DefinitionSnapshot {
  workflowId: number;
  hash: string;
  createdAt: string;
  workflow: Workflow;
}

export interface PromptPreview {
  workflowId: number;
  baselineHash: string;
  changes: PromptChange[];
  workflowDefinition: JsonObject;
}

export interface PromptApplyResult {
  workflow: Workflow;
  before: DefinitionSnapshot;
  after: DefinitionSnapshot;
  changes: PromptChange[];
  verified: true;
  /** The upstream PUT has no compare-and-swap contract. */
  atomic: false;
}

export class DograhError extends Error {
  readonly code: string;
  readonly status?: number;
  constructor(code: string, message: string, status?: number) {
    super(message);
    this.name = 'DograhError';
    this.code = code;
    this.status = status;
  }
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function idPath(id: WorkflowId): string {
  if (!/^[1-9]\d*$/.test(String(id)) || !Number.isSafeInteger(Number(id))) {
    throw new DograhError('INVALID_ID', 'A positive workflow or run ID is required.');
  }
  return String(id);
}

export function normalizeApiBaseUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new DograhError('INVALID_BASE_URL', 'Enter a complete HTTP(S) backend URL.');
  }
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new DograhError(
      'INVALID_BASE_URL',
      'The backend URL must use HTTP(S) without credentials, query parameters, or fragments.',
    );
  }
  let path = url.pathname.replace(/\/+$/, '');
  if (!path || /^\/workflow(?:\/.*)?$/.test(path)) path = '/api/v1';
  else if (path === '/api') path = '/api/v1';
  // A nonstandard path is an explicit API base. Do not guess proxy prefixes.
  url.pathname = path;
  return url.toString().replace(/\/+$/, '');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Hash edit-relevant state, excluding run counts and other volatile counters. */
export function hashWorkflowDefinition(workflow: Workflow): string {
  const state: JsonObject = {};
  for (const key of [
    'id',
    'name',
    'status',
    'workflow_definition',
    'current_definition_id',
    'version_number',
    'version_status',
    'template_context_variables',
    'workflow_configurations',
    'call_disposition_codes',
  ]) {
    if (workflow[key] !== undefined) state[key] = workflow[key];
  }
  return createHash('sha256').update(stableJson(state)).digest('hex');
}

function validateWorkflow(value: unknown): Workflow {
  if (
    !isObject(value) ||
    !Number.isSafeInteger(value.id) ||
    typeof value.name !== 'string' ||
    !isObject(value.workflow_definition)
  ) {
    throw new DograhError('INVALID_RESPONSE', 'Dograh returned an unsupported workflow response.');
  }
  return value as Workflow;
}

export function createDefinitionSnapshot(workflow: Workflow): DefinitionSnapshot {
  const copy = structuredClone(validateWorkflow(workflow));
  return {
    workflowId: copy.id,
    hash: hashWorkflowDefinition(copy),
    createdAt: new Date().toISOString(),
    workflow: copy,
  };
}

const EDITABLE_PROMPT_KEYS = new Set(['prompt', 'system_prompt', 'qa_system_prompt']);

export function listPromptFields(workflow: Workflow): PromptField[] {
  const nodes = workflow.workflow_definition.nodes;
  if (!Array.isArray(nodes)) return [];
  const fields: PromptField[] = [];
  nodes.forEach((node: unknown, index) => {
    if (!isObject(node) || typeof node.id !== 'string' || !isObject(node.data)) return;
    for (const key of EDITABLE_PROMPT_KEYS) {
      if (typeof node.data[key] !== 'string') continue;
      fields.push({
        nodeId: node.id,
        nodeName: typeof node.data.name === 'string' ? node.data.name : node.id,
        path: `/nodes/${index}/data/${key}`,
        value: node.data[key],
      });
    }
  });
  return fields;
}

export function previewPromptChanges(
  snapshot: DefinitionSnapshot,
  changes: PromptChange[],
): PromptPreview {
  if (
    snapshot.workflowId !== snapshot.workflow.id ||
    hashWorkflowDefinition(snapshot.workflow) !== snapshot.hash
  ) {
    throw new DograhError(
      'INVALID_SNAPSHOT',
      'The saved workflow baseline has changed. Fetch a new snapshot.',
    );
  }
  if (!Array.isArray(changes) || changes.length === 0) {
    throw new DograhError('INVALID_PATCH', 'Choose at least one prompt field to change.');
  }
  const allowed = new Map(listPromptFields(snapshot.workflow).map((field) => [field.path, field]));
  const seen = new Set<string>();
  const definition = structuredClone(snapshot.workflow.workflow_definition);
  for (const change of changes) {
    const field = allowed.get(change.path);
    if (
      !field ||
      field.nodeId !== change.nodeId ||
      field.value !== change.before ||
      typeof change.after !== 'string' ||
      !change.after.trim() ||
      change.before === change.after ||
      seen.has(change.path)
    ) {
      throw new DograhError(
        'INVALID_PATCH',
        'A prompt change does not match an editable field and its exact baseline.',
      );
    }
    seen.add(change.path);
    // Only pointers discovered above are writable. No arbitrary JSON Pointer traversal.
    const [, , index, , key] = field.path.split('/');
    const node = (definition.nodes as JsonObject[])[Number(index)];
    (node.data as JsonObject)[key] = change.after;
  }
  return {
    workflowId: snapshot.workflowId,
    baselineHash: snapshot.hash,
    changes: structuredClone(changes),
    workflowDefinition: definition,
  };
}

export class DograhClient {
  readonly baseUrl: string;
  readonly authMode: DograhAuthMode;
  #credential: string;
  #fetch: FetchLike;
  #timeoutMs: number;
  #signal?: AbortSignal;

  constructor(config: DograhConfig) {
    this.baseUrl = normalizeApiBaseUrl(config.baseUrl);
    this.authMode = config.authMode ?? 'apiKey';
    try {
      this.#credential = normalizeDograhCredential(
        this.authMode,
        this.authMode === 'token' ? (config.loginToken ?? '') : (config.apiKey ?? ''),
      );
    } catch (error) {
      if (error instanceof DograhAuthError) throw new DograhError(error.code, error.message);
      throw new DograhError('INVALID_CREDENTIAL', 'Dograh 认证信息格式不正确。');
    }
    this.#fetch = config.fetchImpl ?? fetch;
    this.#timeoutMs = config.timeoutMs ?? 120_000;
    this.#signal = config.signal;
  }

  #authHeaders(): Record<string, string> {
    return this.authMode === 'token'
      ? { Authorization: `Bearer ${this.#credential}` }
      : { 'X-API-Key': this.#credential };
  }

  #authenticationHint(status: number): string {
    if (status === 401 && this.authMode === 'token') {
      return 'Dograh 登录 Token 已过期或被拒绝，请重新登录 Dograh，并在连接设置中更新 Token。';
    }
    return status === 401
      ? 'Dograh API Key 无效或已失效，请在连接设置中检查密钥。'
      : 'Dograh 拒绝访问，请确认当前账号或凭据有权访问所选组织。';
  }

  async #request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          ...this.#authHeaders(),
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'manual',
        signal: this.#signal
          ? AbortSignal.any([this.#signal, AbortSignal.timeout(this.#timeoutMs)])
          : AbortSignal.timeout(this.#timeoutMs),
      });
    } catch {
      // Never forward native errors: an upstream error may echo headers or URLs.
      throw new DograhError('NETWORK_ERROR', 'Could not reach Dograh, or the request timed out.');
    }
    if (response.status >= 300 && response.status < 400) {
      throw new DograhError(
        'API_REDIRECT',
        'Dograh redirected the API request. Enter the final backend API base URL.',
        response.status,
      );
    }
    if (!response.ok) {
      const hint =
        response.status === 401 || response.status === 403
          ? this.#authenticationHint(response.status)
          : response.status === 404
            ? 'This Dograh endpoint or resource was not found. Check the backend URL and deployment version.'
            : response.status === 429
              ? 'Dograh rate or concurrency limits were reached.'
              : 'Dograh could not complete the request.';
      throw new DograhError('HTTP_ERROR', `${hint} (HTTP ${response.status})`, response.status);
    }
    if (response.status === 204) return undefined as T;
    try {
      return (await response.json()) as T;
    } catch {
      throw new DograhError(
        'INVALID_RESPONSE',
        'Dograh returned a non-JSON response. Check the backend API URL.',
      );
    }
  }

  /** Upstream /workflow/fetch is explicitly unpaginated and returns every workflow. */
  async listWorkflows(
    options: { status?: 'active' | 'archived' | 'active,archived' } = {},
  ): Promise<WorkflowSummary[]> {
    const suffix = options.status ? `?status=${encodeURIComponent(options.status)}` : '';
    const data = await this.#request<unknown>(`/workflow/fetch${suffix}`);
    if (
      !Array.isArray(data) ||
      data.some(
        (item) =>
          !isObject(item) || !Number.isSafeInteger(item.id) || typeof item.name !== 'string',
      )
    ) {
      throw new DograhError(
        'INVALID_RESPONSE',
        'Dograh returned an unsupported workflow list. No partial list was accepted.',
      );
    }
    return data as WorkflowSummary[];
  }

  async getWorkflow(id: WorkflowId): Promise<Workflow> {
    const requestedId = idPath(id);
    const workflow = validateWorkflow(await this.#request(`/workflow/fetch/${requestedId}`));
    if (String(workflow.id) !== requestedId)
      throw new DograhError(
        'INVALID_RESPONSE',
        'Dograh returned a different workflow than requested.',
      );
    return workflow;
  }

  async createVoiceRun(id: WorkflowId, name: string): Promise<WorkflowRun> {
    return this.#request(`/workflow/${idPath(id)}/runs`, 'POST', { mode: 'smallwebrtc', name });
  }

  async getRun(workflowId: WorkflowId, runId: WorkflowId): Promise<WorkflowRun> {
    return this.#request(`/workflow/${idPath(workflowId)}/runs/${idPath(runId)}`);
  }

  /** This endpoint, unlike workflow/fetch, is paginated. Fetch all pages. */
  async listRuns(
    workflowId: WorkflowId,
    options: { limit?: number; maxPages?: number } = {},
  ): Promise<WorkflowRun[]> {
    const limit = options.limit ?? 100;
    const maxPages = options.maxPages ?? 1000;
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      !Number.isInteger(maxPages) ||
      maxPages < 1
    ) {
      throw new DograhError(
        'INVALID_PAGINATION',
        'Use a page size of 1–100 and a positive page limit.',
      );
    }
    const results: WorkflowRun[] = [];
    const seen = new Set<number>();
    for (let page = 1; page <= maxPages; page++) {
      const data = await this.#request<unknown>(
        `/workflow/${idPath(workflowId)}/runs?page=${page}&limit=${limit}`,
      );
      if (
        !isObject(data) ||
        !Array.isArray(data.runs) ||
        !Number.isSafeInteger(data.total_pages) ||
        Number(data.total_pages) < 0 ||
        data.page !== page
      ) {
        throw new DograhError(
          'INVALID_RESPONSE',
          'Dograh returned an unsupported paginated run response.',
        );
      }
      for (const run of data.runs) {
        if (!isObject(run) || !Number.isSafeInteger(run.id))
          throw new DograhError('INVALID_RESPONSE', 'Dograh returned an invalid run.');
        if (!seen.has(run.id as number)) {
          seen.add(run.id as number);
          results.push(run as WorkflowRun);
        }
      }
      if (page >= Number(data.total_pages)) return results;
    }
    throw new DograhError(
      'PAGINATION_LIMIT',
      'The run list exceeded its page limit. No partial list was returned.',
    );
  }

  async createTextSession(
    id: WorkflowId,
    options: CreateTextSessionOptions = {},
  ): Promise<TextSession> {
    return this.#request(`/workflow/${idPath(id)}/text-chat/sessions`, 'POST', options);
  }

  async sendTextMessage(
    workflowId: WorkflowId,
    runId: WorkflowId,
    text: string,
    expectedRevision?: number,
  ): Promise<TextSession> {
    if (!text.trim())
      throw new DograhError('INVALID_MESSAGE', 'A nonempty test message is required.');
    return this.#request(
      `/workflow/${idPath(workflowId)}/text-chat/sessions/${idPath(runId)}/messages`,
      'POST',
      {
        text,
        ...(expectedRevision === undefined ? {} : { expected_revision: expectedRevision }),
      },
    );
  }

  async getTextSession(workflowId: WorkflowId, runId: WorkflowId): Promise<TextSession> {
    return this.#request(`/workflow/${idPath(workflowId)}/text-chat/sessions/${idPath(runId)}`);
  }

  async endTextSession(
    workflowId: WorkflowId,
    runId: WorkflowId,
    expectedRevision?: number,
  ): Promise<TextSession> {
    return this.#request(
      `/workflow/${idPath(workflowId)}/text-chat/sessions/${idPath(runId)}/end`,
      'POST',
      {
        ...(expectedRevision === undefined ? {} : { expected_revision: expectedRevision }),
      },
    );
  }

  async snapshotWorkflow(id: WorkflowId): Promise<DefinitionSnapshot> {
    return createDefinitionSnapshot(await this.getWorkflow(id));
  }

  async listVersions(id: WorkflowId): Promise<WorkflowVersion[]> {
    const data = await this.#request<unknown>(`/workflow/${idPath(id)}/versions`);
    if (
      !Array.isArray(data) ||
      data.some((v) => !isObject(v) || !Number.isSafeInteger(v.id) || !isObject(v.workflow_json))
    )
      throw new DograhError('INVALID_RESPONSE', 'Dograh returned an unsupported version list.');
    return data as WorkflowVersion[];
  }

  listPromptFields(workflow: Workflow): PromptField[] {
    return listPromptFields(workflow);
  }
  previewPromptChanges(snapshot: DefinitionSnapshot, changes: PromptChange[]): PromptPreview {
    return previewPromptChanges(snapshot, changes);
  }

  /** Only call after the user has reviewed the exact field changes. Never publishes. */
  async applyPromptChanges(
    snapshot: DefinitionSnapshot,
    changes: PromptChange[],
  ): Promise<PromptApplyResult> {
    const preview = previewPromptChanges(snapshot, changes);
    if (
      !['draft', 'published'].includes(snapshot.workflow.version_status ?? '') ||
      !Number.isSafeInteger(snapshot.workflow.version_number)
    ) {
      throw new DograhError(
        'UNSUPPORTED_DRAFTS',
        'This deployment did not report a supported draft version. Automatic prompt updates are disabled.',
      );
    }
    const current = await this.getWorkflow(snapshot.workflowId);
    if (hashWorkflowDefinition(current) !== snapshot.hash) {
      throw new DograhError(
        'STALE_WORKFLOW',
        'The workflow changed after the preview. Refresh it and review a new diff before applying.',
      );
    }
    await this.#request(`/workflow/${idPath(snapshot.workflowId)}`, 'PUT', {
      workflow_definition: preview.workflowDefinition,
    });
    const saved = await this.getWorkflow(snapshot.workflowId);
    if (stableJson(saved.workflow_definition) !== stableJson(preview.workflowDefinition)) {
      throw new DograhError(
        'POST_APPLY_VERIFICATION_FAILED',
        'The draft was saved, but its readback differs from the reviewed definition. Inspect the saved draft and backup; no automatic rollback was attempted.',
      );
    }
    return {
      workflow: saved,
      before: structuredClone(snapshot),
      after: createDefinitionSnapshot(saved),
      changes: preview.changes,
      verified: true,
      atomic: false,
    };
  }

  /** Use *_public_url or an absolute authenticated artifact URL, not a storage key. */
  async fetchMedia(
    input: string,
    options: { maxBytes?: number } = {},
  ): Promise<{ data: Uint8Array; contentType: string }> {
    const maxBytes = options.maxBytes ?? 100 * 1024 * 1024;
    let url: URL;
    try {
      if (!/^https?:\/\//i.test(input) && !input.startsWith('/')) throw new Error();
      url = new URL(input, `${this.baseUrl}/`);
    } catch {
      throw new DograhError(
        'INVALID_MEDIA_URL',
        'Use a full recording download URL, not an object storage key.',
      );
    }
    for (let hop = 0; hop <= 5; hop++) {
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
        throw new DograhError(
          'INVALID_MEDIA_URL',
          'Recording URLs must use HTTP(S) without embedded credentials.',
        );
      }
      let response: Response;
      try {
        response = await this.#fetch(url, {
          headers: url.origin === new URL(this.baseUrl).origin ? this.#authHeaders() : {},
          redirect: 'manual',
          signal: AbortSignal.timeout(this.#timeoutMs),
        });
      } catch {
        throw new DograhError('MEDIA_NETWORK_ERROR', 'Could not download the recording.');
      }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location)
          throw new DograhError(
            'MEDIA_REDIRECT',
            'The recording download has an invalid redirect.',
          );
        try {
          url = new URL(location, url);
        } catch {
          throw new DograhError(
            'MEDIA_REDIRECT',
            'The recording download has an invalid redirect.',
          );
        }
        continue;
      }
      if (!response.ok) {
        const hint =
          url.origin === new URL(this.baseUrl).origin &&
          (response.status === 401 || response.status === 403)
            ? this.#authenticationHint(response.status)
            : 'Could not download the recording.';
        throw new DograhError(
          'MEDIA_HTTP_ERROR',
          `${hint} (HTTP ${response.status})`,
          response.status,
        );
      }
      if (Number(response.headers.get('content-length')) > maxBytes)
        throw new DograhError('MEDIA_TOO_LARGE', 'The recording exceeds the download size limit.');
      const reader = response.body?.getReader();
      if (!reader)
        return {
          data: new Uint8Array(),
          contentType: response.headers.get('content-type') ?? 'application/octet-stream',
        };
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > maxBytes) {
            await reader.cancel();
            throw new DograhError(
              'MEDIA_TOO_LARGE',
              'The recording exceeds the download size limit.',
            );
          }
          chunks.push(value);
        }
      } catch (error) {
        if (error instanceof DograhError) throw error;
        throw new DograhError('MEDIA_NETWORK_ERROR', 'The recording download was interrupted.');
      }
      const data = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        data.set(chunk, offset);
        offset += chunk.length;
      }
      return {
        data,
        contentType: response.headers.get('content-type') ?? 'application/octet-stream',
      };
    }
    throw new DograhError('MEDIA_REDIRECT', 'The recording download exceeded its redirect limit.');
  }
}
