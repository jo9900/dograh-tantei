import { ArrowRight, Check, ExternalLink, Headphones, Play, RefreshCw, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { Finding } from '../../../shared/types';
import { Busy, Status } from '../../components/ui';
import {
  categoryNames,
  dateLabel,
  errorText,
  findingCategory,
  findingNames,
  formatTime,
  findingText,
  friendlyEvaluationError,
  handlingNames,
  severityNames,
  verifiedDograhRunUrl,
} from '../../lib/presentation';
import type { Api, CallDetail } from '../../types';
import {
  FindingBadge,
  FindingGroups,
  FindingScenarioLabel,
  HandlingResult,
} from '../findings/FindingPresentation';
import { EvaluationSummary, isRetiredEvaluation } from './EvaluationSummary';
import { useAudioPlayback } from './useAudioPlayback';

export function EvidenceDrawer({
  callId,
  startMs,
  api,
  liveFindings,
  onClose,
  onFinding,
  onAskPi,
}: {
  callId: string;
  startMs?: number;
  api: Api;
  liveFindings: Finding[];
  onClose: () => void;
  onFinding: (id: string, state: Finding['state']) => void;
  onAskPi: (text: string) => void;
}) {
  const [detail, setDetail] = useState<CallDetail | null>(null);
  const retiredEvaluation = isRetiredEvaluation(detail?.evaluation);
  const dograhRunUrl = verifiedDograhRunUrl(detail);
  const [error, setError] = useState('');
  const detailRequest = useRef(0);
  const {
    audio,
    audioLoadError,
    audioReload,
    applyRequestedSeek,
    seek,
    retryAudio,
    handleAudioError,
    handleTimeUpdate,
  } = useAudioPlayback(startMs);
  const [focusedFinding, setFocusedFinding] = useState<string | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    let failures = 0;
    async function load() {
      try {
        const request = ++detailRequest.current;
        const next = await api<CallDetail>(`/api/calls/${callId}`);
        if (cancelled || request !== detailRequest.current) return;
        setDetail(next);
        setError('');
        failures = 0;
        attempts++;
        if (
          attempts < 600 &&
          (next.reviewPending ||
            next.call.status === 'running' ||
            next.call.status === 'connecting' ||
            next.call.evaluationStatus === 'pending')
        )
          timer = setTimeout(() => void load(), 2000);
      } catch (e) {
        if (cancelled) return;
        if (++failures < 3) timer = setTimeout(() => void load(), 2000);
        else setError(errorText(e));
      }
    }
    void load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [api, callId]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    panel.current?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeRef.current();
      if (event.key === 'Tab') {
        const elements = panel.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), a[href], input, select, textarea, audio[controls], [tabindex="0"]',
        );
        if (!elements?.length) return;
        const first = elements[0],
          last = elements[elements.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', key);
    return () => {
      document.body.style.overflow = overflow;
      document.removeEventListener('keydown', key);
      previous?.focus();
    };
  }, []);
  const findings = (detail?.findings ?? liveFindings.filter((finding) => finding.callId === callId))
    .filter((finding) => !retiredEvaluation || finding.source !== 'judge')
    .map((finding) => {
      const live = liveFindings.find((item) => item.id === finding.id);
      return live ? { ...finding, state: live.state, reviewNote: live.reviewNote } : finding;
    });
  const transcript = detail?.dograh?.transcript ?? [];
  return (
    <div
      className="drawer-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="evidence-drawer"
        ref={panel}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="evidence-title"
      >
        <div className="drawer-header">
          <div>
            <h2 id="evidence-title">通话证据</h2>
            {dograhRunUrl ? (
              <a
                className="dograh-run-link"
                href={dograhRunUrl}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`在新窗口打开 Dograh #${detail!.call.runId}`}
              >
                Dograh #{detail!.call.runId}
                <ExternalLink size={12} />
              </a>
            ) : (
              <span>
                {detail?.call.runId ? `Dograh #${detail.call.runId}` : callId.slice(0, 8)}
              </span>
            )}
          </div>
          <button className="icon-button" onClick={onClose} aria-label="关闭证据">
            <X size={21} />
          </button>
        </div>
        {error ? (
          <div className="inline-warning" role="alert">
            {error}
          </div>
        ) : !detail ? (
          <div className="drawer-loading">
            <Busy />
            正在读取录音与事件…
          </div>
        ) : (
          <>
            <div className="call-summary">
              <Status value={detail.call.status} />
              <span>{dateLabel(detail.call.startedAt)}</span>
              <span className="tabular">{formatTime(detail.call.durationSeconds)}</span>
            </div>
            {detail.call.versionIntegrity === 'changed' && (
              <p className="inline-warning">
                通话中的 workflow 定义与任务基线不一致。请先核对版本，再比较回归结果。
              </p>
            )}
            {detail.call.finalUsageConfirmed === false && (
              <p className="usage-note">本次语音用量尚未得到模型服务的最终确认。</p>
            )}
            {detail.call.error && <p className="inline-warning">{detail.call.error}</p>}
            <section className="audio-evidence">
              <h3>通话录音</h3>
              {detail.dograh?.recordings.mixed ? (
                <>
                  <audio
                    key={audioReload}
                    ref={audio}
                    controls
                    preload="metadata"
                    src={`/api/calls/${callId}/dograh-audio/mixed`}
                    aria-label="完整通话录音"
                    onLoadedMetadata={applyRequestedSeek}
                    onCanPlay={applyRequestedSeek}
                    onProgress={applyRequestedSeek}
                    onError={handleAudioError}
                    onTimeUpdate={handleTimeUpdate}
                  />
                  {audioLoadError && (
                    <div className="inline-warning audio-load-warning" role="alert">
                      <span>{audioLoadError}</span>
                      <button className="text-button" onClick={retryAudio}>
                        <RefreshCw size={13} />
                        重新加载录音
                      </button>
                    </div>
                  )}
                </>
              ) : (
                <div className="audio-unavailable">
                  <Headphones size={21} />
                  <span>
                    {detail.call.status === 'running' || detail.call.status === 'connecting'
                      ? '通话结束后可播放录音。'
                      : '这次通话没有可用录音。'}
                  </span>
                </div>
              )}
              <div className="audio-markers" aria-label="发现时间点">
                {findings.map((finding) => (
                  <button
                    key={finding.id}
                    className={`category-${findingCategory(finding)} ${focusedFinding === finding.id ? 'active' : ''}`}
                    onClick={() => {
                      seek(Math.max(0, finding.startMs / 1000 - 2));
                      setFocusedFinding(finding.id);
                    }}
                  >
                    <span className={`marker-dot severity-${finding.severity}`} />
                    {formatTime(finding.startMs / 1000)}
                    <FindingBadge finding={finding} />
                    <span>{finding.title}</span>
                  </button>
                ))}
              </div>
            </section>
            <div className="drawer-body">
              {!retiredEvaluation && detail.evaluationAttempt?.status === 'failed' && (
                <div className="inline-warning review-attempt-warning" role="alert">
                  <strong>本次重新评审未完成{detail.evaluation ? '，已保留原报告' : ''}。</strong>
                  <span>{friendlyEvaluationError(detail.evaluationAttempt.error)}</span>
                </div>
              )}
              {detail.dograhError && <p className="inline-warning">{detail.dograhError}</p>}
              {detail.dograh && (
                <section className="transcript-section">
                  <h3>Gathered Context</h3>
                  <p className="small muted">Dograh 保存的通话上下文</p>
                  <pre className="gathered-context">
                    {detail.dograh.gatheredContext == null
                      ? '这通电话没有保存上下文。'
                      : JSON.stringify(detail.dograh.gatheredContext, null, 2)}
                  </pre>
                </section>
              )}
              <EvaluationSummary detail={detail} />
              {findings.length > 0 && (
                <section className="drawer-findings">
                  <h3>
                    发现与证据 <span>{findings.length}</span>
                  </h3>
                  <FindingGroups
                    findings={findings}
                    render={(finding) => (
                      <article
                        key={finding.id}
                        className={`evidence-finding category-${findingCategory(finding)} ${focusedFinding === finding.id ? 'focused' : ''}`}
                      >
                        <div className="finding-meta">
                          <FindingBadge finding={finding} />
                          <span>
                            {findingCategory(finding) === 'observation'
                              ? '低'
                              : severityNames[finding.severity]}
                            优先级
                          </span>
                          <span>{findingNames[finding.state]}</span>
                          <FindingScenarioLabel finding={finding} />
                          <button
                            className="timestamp"
                            onClick={() => seek(Math.max(0, finding.startMs / 1000 - 2))}
                          >
                            <Play size={12} />
                            {formatTime(finding.startMs / 1000)}–{formatTime(finding.endMs / 1000)}
                          </button>
                        </div>
                        <h4>{finding.title}</h4>
                        <p>{findingText(finding.detail)}</p>
                        {(finding.evaluatorVersion ?? 0) >= 3 && (
                          <HandlingResult handling={finding.handling} compact />
                        )}
                        {finding.reviewNote && (
                          <p className="chat-text">复核备注：{finding.reviewNote}</p>
                        )}

                        <div className="finding-controls">
                          <button
                            className={`button small-button ${finding.state === 'confirmed' ? 'confirmed' : 'secondary'}`}
                            disabled={finding.state === 'confirmed'}
                            onClick={() => onFinding(finding.id, 'confirmed')}
                          >
                            <Check size={13} />
                            确认记录
                          </button>
                          <button
                            className="text-button"
                            onClick={() =>
                              onFinding(
                                finding.id,
                                finding.state === 'dismissed' ? 'candidate' : 'dismissed',
                              )
                            }
                          >
                            {finding.state === 'dismissed' ? '恢复待确认' : '忽略'}
                          </button>
                          <button
                            className="text-button ask-pi"
                            onClick={() =>
                              onAskPi(
                                `请分析任务 ${detail.task?.name ?? detail.call.taskId}，通话 ${callId} 的这条发现：${finding.title}。时间 ${formatTime(finding.startMs / 1000)}–${formatTime(finding.endMs / 1000)}。${findingText(finding.detail)} 分类：${categoryNames[findingCategory(finding)]}。${finding.handling ? `可观察应对判断：${handlingNames[finding.handling.status]}。${finding.handling.reason}` : ''} 请先核对证据，分别说明业务目标与可观察应对，不要仅凭对话推断后台或工具状态；如需改动，给出最小建议。`,
                              )
                            }
                          >
                            交给 Pi 分析
                            <ArrowRight size={13} />
                          </button>
                        </div>
                      </article>
                    )}
                  />
                </section>
              )}
              <section className="transcript-section">
                <div className="section-heading">
                  <h3>通话转写</h3>
                  <span className="small muted">以录音为准</span>
                </div>
                {transcript.length ? (
                  <>
                    <div className="transcript">
                      {transcript.map((turn, index) => (
                        <div className={`transcript-turn ${turn.speaker}`} key={index}>
                          <div>
                            <strong>{turn.speaker === 'caller' ? '模拟来电者' : 'AI 客服'}</strong>
                            <button className="timestamp" onClick={() => seek(turn.atMs / 1000)}>
                              {formatTime(turn.atMs / 1000)}
                            </button>
                          </div>
                          <p>{turn.text}</p>
                        </div>
                      ))}
                    </div>
                  </>
                ) : (
                  <p className="empty-text">暂无通话转写。</p>
                )}
              </section>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
