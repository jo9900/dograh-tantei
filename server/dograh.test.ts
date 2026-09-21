import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  DograhClient,
  DograhError,
  createDefinitionSnapshot,
  hashWorkflowDefinition,
  listPromptFields,
  normalizeApiBaseUrl,
  previewPromptChanges,
} from './dograh.js';
import type { FetchLike, PromptChange, Workflow } from './dograh.js';
import { normalizeDograhCredential, normalizeLoginToken } from './dograh-auth.js';

const key = 'private-dograh-key-test';
const workflow = (): Workflow => ({
  id: 7,
  name: 'Japanese Taxi Ride Demo (dev)',
  status: 'active',
  current_definition_id: 50,
  version_number: 4,
  version_status: 'draft',
  total_runs: 32,
  workflow_configurations: { llm: { temperature: 0.6 }, private_unknown: 'keep' },
  template_context_variables: { language: 'ja' },
  workflow_definition: {
    nodes: [
      {
        id: 'greeting',
        type: 'agent',
        position: { x: 21, y: 35 },
        data: {
          name: 'Greeting',
          prompt: '行き先はどちらですか？',
          voice: 'original',
          nested: { keep: true },
        },
      },
      {
        id: 'finish',
        type: 'end',
        data: { name: 'Finish', prompt: 'ありがとうございます。', tool_config: { enabled: true } },
      },
    ],
    edges: [
      { id: 'e1', source: 'greeting', target: 'finish', data: { condition: 'trip complete' } },
    ],
    viewport: { zoom: 0.8 },
    unknown_extension: { preserve: true },
  },
});
const change = (): PromptChange => ({
  nodeId: 'greeting',
  path: '/nodes/0/data/prompt',
  before: '行き先はどちらですか？',
  after: '目的地を確認してから、料金の目安をお伝えください。',
});
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

test('normalizes UI/root URLs while preserving explicit API prefixes', () => {
  assert.equal(
    normalizeApiBaseUrl('https://dograh.example/workflow/7'),
    'https://dograh.example/api/v1',
  );
  assert.equal(normalizeApiBaseUrl('https://dograh.example/'), 'https://dograh.example/api/v1');
  assert.equal(
    normalizeApiBaseUrl('https://dograh.example/backend/api/v1/'),
    'https://dograh.example/backend/api/v1',
  );
  assert.equal(normalizeApiBaseUrl('http://localhost:8000/api'), 'http://localhost:8000/api/v1');
  for (const invalid of [
    'file:///tmp/a',
    'https://user:secret@example.org',
    'https://example.org?key=private',
  ]) {
    assert.throws(() => normalizeApiBaseUrl(invalid), DograhError);
  }
});

test('lists every workflow from the documented unpaginated route and authenticates by header', async () => {
  const all = Array.from({ length: 237 }, (_, index) => ({
    id: index + 1,
    name: `Agent ${index}`,
  }));
  let calls = 0;
  const client = new DograhClient({
    baseUrl: 'https://dograh.example',
    apiKey: key,
    fetchImpl: async (input, init) => {
      calls++;
      assert.equal(String(input), 'https://dograh.example/api/v1/workflow/fetch?status=active');
      assert.equal(new Headers(init?.headers).get('X-API-Key'), key);
      assert.equal(init?.redirect, 'manual');
      return json(all);
    },
  });
  assert.equal((await client.listWorkflows({ status: 'active' })).length, 237);
  assert.equal(calls, 1);
  assert.ok(!JSON.stringify(client).includes(key));
});

test('does not silently accept a first-page workflow envelope from an incompatible deployment', async () => {
  const client = new DograhClient({
    baseUrl: 'https://dograh.example',
    apiKey: key,
    fetchImpl: async () => json({ workflows: [{ id: 1, name: 'One' }], total_pages: 3 }),
  });
  await assert.rejects(client.listWorkflows(), { code: 'INVALID_RESPONSE' });
});

test('paginates all run pages and rejects page-limit truncation', async () => {
  const calls: string[] = [];
  const fetchImpl: FetchLike = async (input) => {
    const url = new URL(String(input));
    calls.push(String(input));
    const page = Number(url.searchParams.get('page'));
    return json({ page, total_pages: 3, runs: [{ id: page }], total_count: 3 });
  };
  const client = new DograhClient({ baseUrl: 'https://dograh.example', apiKey: key, fetchImpl });
  assert.deepEqual(
    (await client.listRuns(7)).map((run) => run.id),
    [1, 2, 3],
  );
  assert.equal(calls.length, 3);
  await assert.rejects(client.listRuns(7, { maxPages: 2 }), { code: 'PAGINATION_LIMIT' });
});

test('uses real voice and text routes, exact payloads and optimistic text revisions', async () => {
  const requests: Array<{ path: string; method: string; body: unknown }> = [];
  const client = new DograhClient({
    baseUrl: 'https://dograh.example/api/v1',
    apiKey: key,
    fetchImpl: async (input, init) => {
      requests.push({
        path: new URL(String(input)).pathname,
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return json({
        id: 90,
        workflow_run_id: 90,
        workflow_id: 7,
        revision: 2,
        is_completed: false,
        session_data: {},
      });
    },
  });
  await client.createVoiceRun(7, 'batch-1');
  await client.createTextSession(7, { name: 'Taxi', initial_context: { language: 'ja' } });
  await client.sendTextMessage(7, 90, '東京駅までお願いします。', 2);
  await client.endTextSession(7, 90, 3);
  assert.deepEqual(requests, [
    {
      path: '/api/v1/workflow/7/runs',
      method: 'POST',
      body: { mode: 'smallwebrtc', name: 'batch-1' },
    },
    {
      path: '/api/v1/workflow/7/text-chat/sessions',
      method: 'POST',
      body: { name: 'Taxi', initial_context: { language: 'ja' } },
    },
    {
      path: '/api/v1/workflow/7/text-chat/sessions/90/messages',
      method: 'POST',
      body: { text: '東京駅までお願いします。', expected_revision: 2 },
    },
    {
      path: '/api/v1/workflow/7/text-chat/sessions/90/end',
      method: 'POST',
      body: { expected_revision: 3 },
    },
  ]);
});

test('preview changes exactly one prompt and preserves graph, other prompts and unknown metadata', () => {
  const original = workflow();
  const snapshot = createDefinitionSnapshot(original);
  const preview = previewPromptChanges(snapshot, [change()]);
  const expected = workflow().workflow_definition;
  (expected.nodes as Array<{ data: Record<string, unknown> }>)[0].data.prompt = change().after;
  assert.deepEqual(preview.workflowDefinition, expected);
  assert.deepEqual(original, workflow());
  assert.deepEqual(snapshot.workflow, original);
  assert.equal(listPromptFields(original).length, 2);
  assert.throws(
    () => previewPromptChanges(snapshot, [{ ...change(), path: '/nodes/0/data/voice' }]),
    { code: 'INVALID_PATCH' },
  );
  assert.throws(() => previewPromptChanges(snapshot, [{ ...change(), nodeId: 'finish' }]), {
    code: 'INVALID_PATCH',
  });
  assert.throws(
    () => previewPromptChanges(snapshot, [{ ...change(), before: 'not the original' }]),
    { code: 'INVALID_PATCH' },
  );
  assert.throws(() => previewPromptChanges(snapshot, [change(), change()]), {
    code: 'INVALID_PATCH',
  });
});

test('snapshot hash ignores test-run counts but detects unrelated edits and snapshot tampering', () => {
  const original = workflow();
  const same = workflow();
  same.total_runs = 400;
  assert.equal(hashWorkflowDefinition(original), hashWorkflowDefinition(same));
  same.template_context_variables = { language: 'en' };
  assert.notEqual(hashWorkflowDefinition(original), hashWorkflowDefinition(same));
  const snapshot = createDefinitionSnapshot(original);
  snapshot.workflow.name = 'tampered';
  assert.throws(() => previewPromptChanges(snapshot, [change()]), { code: 'INVALID_SNAPSHOT' });
});

test('stale snapshot stops before any write', async () => {
  const requests: string[] = [];
  const modified = workflow();
  modified.workflow_definition.unknown_extension = { preserve: 'a concurrent edit' };
  const client = new DograhClient({
    baseUrl: 'https://dograh.example',
    apiKey: key,
    fetchImpl: async (_input, init) => {
      requests.push(init?.method ?? 'GET');
      return json(modified);
    },
  });
  await assert.rejects(
    client.applyPromptChanges(createDefinitionSnapshot(workflow()), [change()]),
    { code: 'STALE_WORKFLOW' },
  );
  assert.deepEqual(requests, ['GET']);
});

test('refuses prompt updates on deployments that do not expose modern draft metadata', async () => {
  const legacy = workflow();
  delete legacy.version_status;
  delete legacy.version_number;
  let calls = 0;
  const client = new DograhClient({
    baseUrl: 'https://dograh.example',
    apiKey: key,
    fetchImpl: async () => {
      calls++;
      return json(legacy);
    },
  });
  await assert.rejects(client.applyPromptChanges(createDefinitionSnapshot(legacy), [change()]), {
    code: 'UNSUPPORTED_DRAFTS',
  });
  assert.equal(calls, 0);
});

test('apply rereads, saves complete definition only, never publishes, and verifies readback', async () => {
  let current = workflow();
  const requests: Array<{ path: string; method: string; body?: unknown }> = [];
  const client = new DograhClient({
    baseUrl: 'https://dograh.example',
    apiKey: key,
    fetchImpl: async (input, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ path: new URL(String(input)).pathname, method: init?.method ?? 'GET', body });
      if (init?.method === 'PUT')
        current = { ...current, workflow_definition: body.workflow_definition };
      return json(current);
    },
  });
  const result = await client.applyPromptChanges(createDefinitionSnapshot(workflow()), [change()]);
  assert.equal(result.verified, true);
  assert.equal(result.atomic, false);
  assert.deepEqual(
    requests.map((request) => request.method),
    ['GET', 'PUT', 'GET'],
  );
  assert.deepEqual(Object.keys(requests[1].body as object), ['workflow_definition']);
  assert.ok(requests.every((request) => !request.path.includes('publish')));
  assert.deepEqual(result.before.workflow, workflow());
  assert.deepEqual(result.workflow.workflow_configurations, workflow().workflow_configurations);
  assert.equal(listPromptFields(result.workflow)[0].value, change().after);
});

test('readback mismatch reports that write occurred and performs no destructive rollback', async () => {
  const methods: string[] = [];
  const client = new DograhClient({
    baseUrl: 'https://dograh.example',
    apiKey: key,
    fetchImpl: async (_input, init) => {
      methods.push(init?.method ?? 'GET');
      return json(workflow());
    },
  });
  await assert.rejects(
    client.applyPromptChanges(createDefinitionSnapshot(workflow()), [change()]),
    { code: 'POST_APPLY_VERIFICATION_FAILED' },
  );
  assert.deepEqual(methods, ['GET', 'PUT', 'GET']);
});

test('sanitizes errors, rejecting API redirects without following or exposing secrets', async () => {
  for (const fetchImpl of [
    async () => json({ detail: `echoed ${key}` }, 403),
    async () => {
      throw new Error(`request X-API-Key=${key}`);
    },
    async () =>
      new Response(null, {
        status: 302,
        headers: { location: `https://other.example?secret=${key}` },
      }),
  ]) {
    const client = new DograhClient({ baseUrl: 'https://dograh.example', apiKey: key, fetchImpl });
    await assert.rejects(client.listWorkflows(), (error) => {
      assert.ok(error instanceof DograhError);
      assert.ok(!String(error).includes(key));
      assert.ok(!JSON.stringify(error).includes(key));
      return true;
    });
  }
});

test('media forwards Dograh key only to its own origin, strips it on storage redirects', async () => {
  const requests: Array<{ url: string; key: string | null }> = [];
  const client = new DograhClient({
    baseUrl: 'https://dograh.example',
    apiKey: key,
    fetchImpl: async (input, init) => {
      requests.push({ url: String(input), key: new Headers(init?.headers).get('X-API-Key') });
      return requests.length === 1
        ? new Response(null, {
            status: 302,
            headers: { location: 'https://storage.example/recording.wav?signature=private' },
          })
        : new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'audio/wav' } });
    },
  });
  const result = await client.fetchMedia('https://dograh.example/api/v1/download/recording');
  assert.equal(result.contentType, 'audio/wav');
  assert.deepEqual([...result.data], [1, 2, 3]);
  assert.deepEqual(
    requests.map((request) => request.key),
    [key, null],
  );
});

test('direct cross-origin media gets no credentials and oversized downloads are stopped', async () => {
  const client = new DograhClient({
    baseUrl: 'https://dograh.example',
    apiKey: key,
    fetchImpl: async (_input, init) => {
      assert.equal(new Headers(init?.headers).get('X-API-Key'), null);
      return new Response(new Uint8Array([1, 2, 3]));
    },
  });
  await assert.rejects(
    client.fetchMedia('https://storage.example/recording.wav', { maxBytes: 2 }),
    { code: 'MEDIA_TOO_LARGE' },
  );
  await assert.rejects(client.fetchMedia('recordings/1.wav'), { code: 'INVALID_MEDIA_URL' });
});

const loginToken = 'synthetic-header.synthetic-payload.synthetic-signature';

test('normalizes a single login credential without assuming every token is a JWT', () => {
  for (const input of [
    loginToken,
    `  ${loginToken}  `,
    `Bearer ${loginToken}`,
    `bearer   ${loginToken}`,
    `dograh_auth_token=${loginToken}`,
  ]) {
    assert.equal(normalizeLoginToken(input), loginToken);
  }
  assert.equal(normalizeLoginToken('opaque_A-b.c~d+e/f=='), 'opaque_A-b.c~d+e/f==');
  assert.equal(normalizeLoginToken(normalizeLoginToken(`Bearer ${loginToken}`)), loginToken);
  assert.equal(normalizeDograhCredential('token', `dograh_auth_token=${loginToken}`), loginToken);
  assert.equal(normalizeDograhCredential('apiKey', ` ${key} `), key);
});

test('rejects copied curl, cookie lists, quotes, blank credentials and header controls without echoing them', () => {
  for (const input of [
    '',
    ' ',
    'Bearer',
    'dograh_auth_token=',
    `Bearer ${loginToken}\r\n`,
    `${loginToken}\n`,
    `${loginToken}\t`,
    `${loginToken}\u0000`,
    `${loginToken}\u007f`,
    `Bearer ${loginToken} another-token`,
    `dograh_auth_token=${loginToken}; theme=dark`,
    `dograh_auth_token=${loginToken};`,
    `'${loginToken}'`,
    `"${loginToken}"`,
    `curl https://example.invalid -H 'Authorization: Bearer ${loginToken}'`,
  ]) {
    assert.throws(
      () => normalizeLoginToken(input),
      (error) => {
        assert.equal((error as { code: string }).code, 'INVALID_LOGIN_TOKEN');
        assert.ok(!String(error).includes(loginToken));
        return true;
      },
    );
  }
  for (const input of ['', '  ', `${key}\n`, `Bearer ${loginToken}`, 'key with spaces']) {
    assert.throws(() => normalizeDograhCredential('apiKey', input), { code: 'INVALID_API_KEY' });
  }
});

test('token-only configuration sends exactly one normalized Bearer header', async () => {
  const client = new DograhClient({
    baseUrl: 'https://dograh.example',
    authMode: 'token',
    loginToken: `dograh_auth_token=${loginToken}`,
    fetchImpl: async (_input, init) => {
      const headers = new Headers(init?.headers);
      assert.equal(headers.get('Authorization'), `Bearer ${loginToken}`);
      assert.equal(headers.get('X-API-Key'), null);
      return json([]);
    },
  });
  await client.listWorkflows();
  assert.equal(client.authMode, 'token');
  assert.ok(!JSON.stringify(client).includes(loginToken));
});

test('explicit mode never mixes credentials or silently falls back to the other mode', async () => {
  for (const authMode of ['token', 'apiKey'] as const) {
    const client = new DograhClient({
      baseUrl: 'https://dograh.example',
      authMode,
      loginToken,
      apiKey: key,
      fetchImpl: async (_input, init) => {
        const headers = new Headers(init?.headers);
        assert.equal(
          headers.get('Authorization'),
          authMode === 'token' ? `Bearer ${loginToken}` : null,
        );
        assert.equal(headers.get('X-API-Key'), authMode === 'apiKey' ? key : null);
        return json([]);
      },
    });
    await client.listWorkflows();
  }
  assert.throws(
    () => new DograhClient({ baseUrl: 'https://dograh.example', authMode: 'token', apiKey: key }),
    { code: 'INVALID_LOGIN_TOKEN' },
  );
  assert.throws(() => new DograhClient({ baseUrl: 'https://dograh.example', loginToken }), {
    code: 'INVALID_API_KEY',
  });
  assert.throws(
    () =>
      new DograhClient({
        baseUrl: 'https://dograh.example',
        authMode: 'token',
        loginToken: `${loginToken}\r\n`,
      }),
    { code: 'INVALID_LOGIN_TOKEN' },
  );
});

test('rejected login tokens prompt reconnection while error bodies and network errors remain private', async () => {
  const client = new DograhClient({
    baseUrl: 'https://dograh.example',
    authMode: 'token',
    loginToken,
    fetchImpl: async () => json({ detail: `expired ${loginToken}` }, 401),
  });
  await assert.rejects(client.listWorkflows(), (error) => {
    assert.ok(error instanceof DograhError);
    assert.equal(error.status, 401);
    assert.match(error.message, /重新登录/);
    assert.ok(!String(error).includes(loginToken));
    return true;
  });
  const networkClient = new DograhClient({
    baseUrl: 'https://dograh.example',
    authMode: 'token',
    loginToken,
    fetchImpl: async () => {
      throw new Error(`Authorization: Bearer ${loginToken}`);
    },
  });
  await assert.rejects(networkClient.listWorkflows(), (error) => {
    assert.ok(error instanceof DograhError);
    assert.equal(error.code, 'NETWORK_ERROR');
    assert.ok(!String(error).includes(loginToken));
    return true;
  });
});

test('media uses Bearer on the Dograh origin and neither credential on a redirected storage origin', async () => {
  const requests: Array<{ bearer: string | null; apiKey: string | null }> = [];
  const client = new DograhClient({
    baseUrl: 'https://dograh.example',
    authMode: 'token',
    loginToken,
    apiKey: key,
    fetchImpl: async (_input, init) => {
      const headers = new Headers(init?.headers);
      requests.push({ bearer: headers.get('Authorization'), apiKey: headers.get('X-API-Key') });
      return requests.length === 1
        ? new Response(null, {
            status: 302,
            headers: { location: 'https://storage.example/recording.wav' },
          })
        : new Response(new Uint8Array([1, 2]));
    },
  });
  await client.fetchMedia('https://dograh.example/api/v1/download/recording');
  assert.deepEqual(requests, [
    { bearer: `Bearer ${loginToken}`, apiKey: null },
    { bearer: null, apiKey: null },
  ]);
});

test('token mode rejects API redirects and sanitizes authenticated media errors', async () => {
  let calls = 0;
  const client = new DograhClient({
    baseUrl: 'https://dograh.example',
    authMode: 'token',
    loginToken,
    fetchImpl: async () => {
      calls++;
      return new Response(null, {
        status: 302,
        headers: { location: `https://other.example?token=${loginToken}` },
      });
    },
  });
  await assert.rejects(client.listWorkflows(), (error) => {
    assert.ok(error instanceof DograhError);
    assert.equal(error.code, 'API_REDIRECT');
    assert.ok(!String(error).includes(loginToken));
    return true;
  });
  assert.equal(calls, 1);
  const mediaClient = new DograhClient({
    baseUrl: 'https://dograh.example',
    authMode: 'token',
    loginToken,
    fetchImpl: async () => json({ error: loginToken }, 401),
  });
  await assert.rejects(
    mediaClient.fetchMedia('https://dograh.example/api/v1/download/recording'),
    (error) => {
      assert.ok(error instanceof DograhError);
      assert.match(error.message, /重新登录/);
      assert.ok(!String(error).includes(loginToken));
      return true;
    },
  );
});
