import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JevEvaluator, buildJevRequest, requestJev } from './jev.js';
import { LocalStore } from './store.js';
import type { CallRecord, TestTask } from '../shared/types.js';
import { readEnvironmentConfig, environmentFlags } from './environment.js';
import { jevResult } from '../src/features/workbench/taskResults.js';
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
const evidence = {
  transcript: [
    {
      id: 'dograh:1',
      line: null,
      speaker: 'caller' as const,
      text: '崇城大学前まで',
      atMs: 1000,
      source: 'dograh_transcript',
      providerStartMs: 1000,
      providerEndMs: null,
    },
  ],
  gatheredContext: { dropoff_location: '崇城大学前駅' },
  recordings: { mixed: true, caller: true, agent: true },
  timingBasis: 'provider time',
};
const response = (choice = 'pass') => ({
  model: 'jev-test',
  answers: {
    requirement: {
      type: 'choice',
      choice,
      confidence: 0.9,
      probabilities: { pass: 0.95, fail: 0.03, inconclusive: 0.02 },
    },
  },
  usage: { input_tokens: 100, output_tokens: 10 },
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'tantei-jev-'));
  dirs.push(dir);
  const store = new LocalStore(dir);
  await store.init();
  const task = {
    id: 'task',
    requirement: '两次修改后，最终目的地是崇城大学前。',
    status: 'completed',
  } as TestTask;
  const call = {
    id: 'call',
    taskId: task.id,
    workflowId: 19,
    runId: 821,
    status: 'completed',
    versionIntegrity: 'checked',
    evaluationOverall: 'inconclusive',
  } as CallRecord;
  store.calls.push(call);
  store.tasks.push(task);
  await store.write('calls/call/dograh-evidence.json', evidence);
  return { store, call, task };
}
describe('Jev judgments', () => {
  it('uses original requirements and Dograh context without Pi output or extra proof requirements', () => {
    const req = buildJevRequest({ requirement: '目的地改成崇城大学前' }, evidence);
    expect(req.state).toEqual({
      testRequirement: '目的地改成崇城大学前',
      gatheredContext: evidence.gatheredContext,
      transcript: [{ speaker: 'caller', text: '崇城大学前まで' }],
    });
    expect(req.questions.requirement.instructions.scope).toContain(
      'A matching value is sufficient',
    );
    expect(Object.keys(req.questions.requirement.criteria)).toEqual([
      'pass',
      'fail',
      'inconclusive',
    ]);
  });
  it('validates typed responses, uses official endpoint and does not retry malformed replies', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(response())));
    await requestJev(
      buildJevRequest({ requirement: 'test' }, evidence),
      'private-key',
      new AbortController().signal,
      fetcher,
    );
    expect(fetcher.mock.calls[0]![0]).toBe('https://api.typesafe.ai/v1/systemone');
    expect(fetcher.mock.calls[0]![1]).toMatchObject({
      redirect: 'error',
      headers: { Authorization: 'Bearer private-key' },
    });
    expect(fetcher.mock.calls[0]![1].body).not.toContain('private-key');
    fetcher.mockResolvedValue(new Response(JSON.stringify(response('invented'))));
    await expect(
      requestJev(
        buildJevRequest({ requirement: 'test' }, evidence),
        'private-key',
        new AbortController().signal,
        fetcher,
      ),
    ).rejects.toThrow('有效判断');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('deduplicates concurrent and repeated requests, saves provenance and keeps Pi results', async () => {
    const f = await fixture();
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(response())));
    const jev = new JevEvaluator(f.store, 'private-key', vi.fn(), fetcher);
    await Promise.all([jev.evaluate(f.task, f.call), jev.evaluate(f.task, f.call)]);
    await jev.evaluate(f.task, f.call);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(f.call.jevEvaluation).toMatchObject({
      status: 'complete',
      overall: 'pass',
      model: 'jev-test',
    });
    expect(f.call.evaluationOverall).toBe('inconclusive');
    const saved = await readFile(join(f.store.dir, 'calls/call/jev-evaluation.json'), 'utf8');
    expect(saved).not.toContain('private-key');
    expect(JSON.parse(saved).request.state.gatheredContext).toEqual(evidence.gatheredContext);
    expect(jevResult(f.call)).toBe('通过');
  });
  it('does not call the API without a key or for an unverified call', async () => {
    const f = await fixture();
    const fetcher = vi.fn();
    await new JevEvaluator(f.store, undefined, vi.fn(), fetcher).evaluate(f.task, f.call);
    f.call.versionIntegrity = 'unverified';
    await new JevEvaluator(f.store, 'key', vi.fn(), fetcher).evaluate(f.task, f.call);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('keeps authentication errors private and marks failure unavailable instead of passing', async () => {
    const f = await fixture();
    const fetcher = vi.fn().mockResolvedValue(new Response('private-key', { status: 401 }));
    await new JevEvaluator(f.store, 'private-key', vi.fn(), fetcher).evaluate(f.task, f.call);
    expect(f.call.jevEvaluation).toMatchObject({
      status: 'unavailable',
      error: 'Jev API Key 无效或无权限。',
    });
    expect(JSON.stringify(f.call)).not.toContain('private-key');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('cancels in-flight judgments and recovers pending state without a new API request', async () => {
    const f = await fixture();
    const fetcher = vi.fn(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) =>
          init.signal.addEventListener('abort', () => reject(new Error('cancelled'))),
        ),
    );
    const jev = new JevEvaluator(f.store, 'key', vi.fn(), fetcher);
    const pending = jev.evaluate(f.task, f.call);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    jev.cancel(f.task.id);
    await pending;
    expect(f.call.jevEvaluation?.status).toBe('unavailable');
    f.call.jevEvaluation = { status: 'pending', generatedAt: 'now' };
    await f.store.persist();
    const restarted = new LocalStore(f.store.dir);
    await restarted.init();
    expect(restarted.calls[0]!.jevEvaluation?.status).toBe('unavailable');
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('loads TypeSafe credentials as environment-only settings and exposes only presence', () => {
    const env = readEnvironmentConfig({ TYPESAFE_API_KEY: 'private-key' });
    expect(env.typesafeApiKey).toBe('private-key');
    expect(environmentFlags(env).typesafeApiKey).toBe(true);
    expect(JSON.stringify(environmentFlags(env))).not.toContain('private-key');
    expect(() => readEnvironmentConfig({ TYPESAFE_API_KEY: 'secret\nheader' })).toThrow(
      'TYPESAFE_API_KEY 格式',
    );
  });
});
