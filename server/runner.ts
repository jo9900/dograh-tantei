import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { LocalStore } from './store.js';
import {
  dograhAuthMode,
  dograhCredential,
  dograhClientConfig,
  settingsFingerprint,
  connectionSecrets,
} from './connection.js';
export { connectionFingerprint } from './connection.js';
import { DograhClient, hashWorkflowDefinition } from './dograh.js';
import { buildCallerInstructions } from './caller-instructions.js';
import type { AppEvent, TestTask, CallRecord, Finding } from '../shared/types.js';

export const pythonPath = () =>
  process.env.TANTEI_PYTHON ||
  path.resolve('.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
export async function audioAvailable() {
  try {
    await promisify(execFile)(pythonPath(), ['-c', 'import aiortc, av, numpy, websockets'], {
      timeout: 15000,
    });
    return true;
  } catch {
    return false;
  }
}
export function safeError(error: unknown, secrets: string[] = []) {
  let s = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) if (secret) s = s.split(secret).join('[redacted]');
  return s
    .replace(/([?&](?:api_key|token)=)[^\s&]+/gi, '$1[redacted]')
    .replace(/sk-[\w-]+/g, '[redacted]')
    .slice(0, 1500);
}
export class AudioRunner {
  constructor(
    private store: LocalStore,
    private emit: (event: AppEvent) => void,
    private onCompleted?: (task: TestTask, call: CallRecord) => Promise<void>,
  ) {}
  async execute(task: TestTask, call: CallRecord, signal: AbortSignal) {
    const settings = { ...this.store.settings };
    const secrets = connectionSecrets(settings);
    const dir = this.store.callDir(call.id);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    try {
      if (signal.aborted) {
        call.status = 'stopped';
        return;
      }
      if (task.connectionFingerprint !== settingsFingerprint(settings))
        throw new Error('Dograh 连接已更改，请为当前账号新建任务。');
      const client = new DograhClient({
        ...dograhClientConfig(settings),
        timeoutMs: 20000,
        signal,
      });
      const snapshot = await client.snapshotWorkflow(task.workflowId);
      if (task.workflowHash && snapshot.hash !== task.workflowHash)
        throw new Error('Workflow 已修改。当前任务已暂停；请创建新版本回归任务，保留旧版本统计。');
      task.workflowHash ??= snapshot.hash;
      call.workflowHash = snapshot.hash;
      await this.store.write(`calls/${call.id}/workflow.json`, snapshot);
      await this.store.write(`calls/${call.id}/rules.json`, task.rules);
      const callerInstructions = buildCallerInstructions(task.rules.callerInstructions);
      await this.store.write(`calls/${call.id}/caller-instructions.json`, {
        version: 1,
        instructions: callerInstructions,
      });
      const workflow = snapshot.workflow as any;
      call.version = workflow.version_number;
      call.versionIntegrity = 'unverified';
      if (signal.aborted) {
        call.status = 'stopped';
        return;
      }
      const run = (await client.createVoiceRun(
        task.workflowId,
        `Tantei ${task.name} ${call.id.slice(0, 8)}`,
      )) as any;
      call.runId = Number(run.id ?? run.workflow_run_id ?? run.run_id);
      if (!Number.isFinite(call.runId) || !call.runId)
        throw new Error('Dograh 没有返回有效的通话运行 ID。');
      call.definitionId = run.definition_id;
      if (signal.aborted) {
        call.status = 'stopped';
        return;
      }
      const afterCreation = await client.snapshotWorkflow(task.workflowId);
      if (afterCreation.hash !== snapshot.hash) {
        call.versionIntegrity = 'changed';
        throw new Error('创建通话时工作流发生变化；已暂停，尚未连接语音模型。');
      }
      if (typeof workflow.version_number === 'number') {
        const versions = await client.listVersions(task.workflowId);
        const actual = versions.find((v) => v.id === run.definition_id);
        if (
          !actual ||
          hashWorkflowDefinition({
            ...snapshot.workflow,
            workflow_definition: actual.workflow_json,
            workflow_configurations: actual.workflow_configurations,
            template_context_variables: actual.template_context_variables,
            version_number: actual.version_number,
            version_status: actual.status,
          }) !== snapshot.hash
        ) {
          call.versionIntegrity = 'changed';
          throw new Error('Dograh 为通话选择的定义与本轮快照不一致，尚未连接语音模型。');
        }
        await this.store.write(`calls/${call.id}/run-definition.json`, actual);
        call.versionIntegrity = 'checked';
      }
      if (signal.aborted) {
        call.status = 'stopped';
        return;
      }
      this.emit({ type: 'call.updated', call });
      let childCompleted = false;
      let workerError = '';
      let terminalReason = '';
      let forcedTimer: NodeJS.Timeout | undefined;
      let killTimer: NodeJS.Timeout | undefined;
      await new Promise<void>((resolve, reject) => {
        const proc = spawn(pythonPath(), ['-m', 'audio_worker.worker'], {
          cwd: process.cwd(),
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, PYTHONUNBUFFERED: '1' },
        });
        proc.stdin.on('error', () => {});
        const terminate = () => {
          proc.kill('SIGTERM');
          killTimer = setTimeout(() => proc.kill('SIGKILL'), 5000);
        };
        const abort = () => {
          if (!proc.stdin.destroyed) proc.stdin.write(JSON.stringify({ type: 'stop' }) + '\n');
          forcedTimer = setTimeout(terminate, 20000);
        };
        signal.addEventListener('abort', abort, { once: true });
        const watchdog = setTimeout(
          () => {
            workerError = '音频进程超出连接/通话时间上限，已终止。';
            terminate();
          },
          (task.maxDurationSeconds + 30) * 1000,
        );
        const lines = createInterface({ input: proc.stdout });
        const eventsFile = path.join(dir, 'bridge-events.jsonl');
        let append = Promise.resolve();
        lines.on('line', (line) => {
          let event: any;
          try {
            event = JSON.parse(line);
          } catch {
            return;
          }
          append = append
            .then(() => fs.appendFile(eventsFile, JSON.stringify(event) + '\n', { mode: 0o600 }))
            .catch(() => {});
          if (event.type === 'state' && event.state === 'connected') {
            call.status = 'running';
            this.emit({ type: 'call.updated', call });
          }
          if (
            typeof event.atMs === 'number' &&
            !['completed', 'usage', 'diagnostic'].includes(event.type)
          )
            call.durationSeconds = Math.max(call.durationSeconds, event.atMs / 1000);
          if (event.type === 'artifacts' && typeof event.durationMs === 'number')
            call.durationSeconds = event.durationMs / 1000;
          if (event.type === 'finding') {
            const finding: Finding = {
              id: randomUUID(),
              taskId: task.id,
              callId: call.id,
              kind: event.code ?? 'response_timeout',
              title: event.title ?? '回应等待超过阈值',
              detail: `桥接端声学检测：等待超过 ${task.rules.responseTimeoutSeconds} 秒。请试听片段确认有效发言边界；声音活动不等于实质性回答。`,
              severity: 'high',
              startMs: Number(event.startMs ?? 0),
              endMs: Number(event.endMs ?? event.atMs ?? 0),
              measuredSeconds:
                Math.max(0, Number(event.endMs ?? event.atMs) - Number(event.startMs)) / 1000,
              source: 'timer',
              state: 'candidate',
              createdAt: new Date().toISOString(),
              evidence: [event.evidenceSource ?? 'local_audio_rms'],
            };
            this.store.findings.unshift(finding);
            task.resultRevision = (task.resultRevision ?? 0) + 1;
            this.emit({ type: 'finding.created', finding });
            void this.store.persist();
          }
          if (event.type === 'error') workerError = safeError(event.message ?? event.code, secrets);
          if (event.type === 'completed') {
            childCompleted = true;
            terminalReason = String(event.reason ?? '');
            call.finalUsageConfirmed = event.finalUsageConfirmed === true;
            call.usage = event.usage;
          }
          this.emit({ type: 'call.event', callId: call.id, taskId: task.id, event });
        });
        let stderr = '';
        proc.stderr.on('data', (buf) => {
          stderr = (stderr + safeError(String(buf), secrets)).slice(-2000);
        });
        proc.once('error', (e) => {
          clearTimeout(watchdog);
          signal.removeEventListener('abort', abort);
          reject(new Error(safeError(e, secrets)));
        });
        proc.once('close', async (code) => {
          clearTimeout(watchdog);
          if (forcedTimer) clearTimeout(forcedTimer);
          if (killTimer) clearTimeout(killTimer);
          signal.removeEventListener('abort', abort);
          await append;
          if (signal.aborted) {
            call.status = 'stopped';
            resolve();
          } else if (workerError || code !== 0 || !childCompleted) {
            reject(new Error(workerError || stderr || '音频连接意外结束，未收到完整结束事件。'));
          } else {
            call.status = terminalReason === 'stopped' ? 'stopped' : 'completed';
            resolve();
          }
        });
        proc.stdin.write(
          JSON.stringify({
            dograhBaseUrl: client.baseUrl,
            dograhAuthMode: dograhAuthMode(settings),
            ...(dograhAuthMode(settings) === 'token'
              ? { dograhLoginToken: dograhCredential(settings) }
              : { dograhApiKey: dograhCredential(settings) }),
            workflowId: task.workflowId,
            runId: call.runId,
            openaiApiKey: settings.openaiApiKey,
            instructions: callerInstructions,
            voice: settings.voice,
            maxDurationSeconds: task.maxDurationSeconds,
            responseTimeoutSeconds: task.rules.responseTimeoutSeconds,
            outputDir: dir,
          }) + '\n',
        );
        if (signal.aborted) abort();
      });
      try {
        const result = await client.getRun(task.workflowId, call.runId!);
        await this.store.write(`calls/${call.id}/dograh-run.json`, result);
        const r = result as any;
        call.definitionId = r.definition_id ?? call.definitionId;
      } catch (e) {
        this.emit({ type: 'notice', message: '通话已保存；Dograh 详情暂时无法读取。' });
      }
      try {
        const after = await client.snapshotWorkflow(task.workflowId);
        await this.store.write(`calls/${call.id}/workflow-after.json`, after);
        if (after.hash !== snapshot.hash) {
          call.versionIntegrity = 'changed';
          task.status = 'paused';
          task.pauseReason =
            '通话期间工作流发生变化，已暂停以免混合版本。该通话保留证据，但不自动评审。';
          call.error = task.pauseReason;
        }
      } catch {
        call.versionIntegrity = 'unverified';
      }
    } catch (e) {
      call.status = signal.aborted ? 'stopped' : 'error';
      call.error = safeError(e, secrets);
    } finally {
      call.endedAt = new Date().toISOString();
      const exists = async (name: string) =>
        !!(await fs.stat(path.join(dir, name)).catch(() => null));
      call.audio = {
        caller: await exists('caller.wav'),
        agent: await exists('agent.wav'),
        mixed: await exists('mixed.wav'),
      };
      await this.store.write(`calls/${call.id}/metadata.json`, call);
      this.emit({ type: 'call.updated', call });
    }
    if (call.status === 'completed' && call.versionIntegrity !== 'checked') {
      call.evaluationStatus = 'unavailable';
      task.evaluationError =
        call.error || '无法完整核对本次通话的工作流版本；录音已保留，自动业务评审未执行。';
      await this.store.write(`calls/${call.id}/evaluation.json`, {
        status: 'unavailable',
        overall: null,
        error: task.evaluationError,
      });
    } else if (call.status === 'completed' && this.onCompleted)
      void this.onCompleted(task, call).catch((e) => {
        task.evaluationError = safeError(e);
        call.evaluationStatus = 'unavailable';
        this.emit({ type: 'call.updated', call });
        void this.store.persist();
      });
  }
}
