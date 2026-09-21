import {
  ArrowRight,
  ArrowUp,
  MessageSquare,
  Settings2,
  ShieldCheck,
  Square,
  X,
} from 'lucide-react';
import type { FormEvent } from 'react';
import { useEffect, useRef, useState } from 'react';
import type { TestTask } from '../../../shared/types';
import { Busy } from '../../components/ui';
import { errorText } from '../../lib/presentation';
import type { Api, ChatMessage, PiStatus } from '../../types';

export function PiPanel({
  pi,
  messages,
  setMessages,
  busy,
  setBusy,
  task,
  api,
  onError,
  onSettings,
  mobileOpen,
  onClose,
}: {
  pi: PiStatus;
  messages: ChatMessage[];
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  task?: TestTask;
  api: Api;
  onError: (message: string) => void;
  onSettings: () => void;
  mobileOpen: boolean;
  onClose: () => void;
}) {
  const contextKey = task ? `task:${task.id}` : 'workbench';
  const visibleMessages = messages.filter(
    (message) => (message.contextKey ?? 'workbench') === contextKey,
  );
  const currentContext = useRef(contextKey);
  currentContext.current = contextKey;
  const [draft, setDraft] = useState('');
  const [allowEdit, setAllowEdit] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setAllowEdit(false);
    setDraft('');
  }, [task?.id]);
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'nearest' });
  }, [messages, busy]);
  useEffect(() => {
    const receive = (event: Event) => setDraft((event as CustomEvent<string>).detail);
    window.addEventListener('tantei:pi-draft', receive);
    return () => window.removeEventListener('tantei:pi-draft', receive);
  }, []);
  async function send(event: FormEvent) {
    event.preventDefault();
    if (!draft.trim() || busy || !pi.configured) return;
    const text = draft.trim();
    const userMessageId = crypto.randomUUID();
    const editWorkflowId = allowEdit ? task?.workflowId : undefined;
    setDraft('');
    setBusy(true);
    setAllowEdit(false);
    setMessages((previous) => [...previous, { id: userMessageId, role: 'user', text, contextKey }]);
    try {
      const result = await api<{ text?: string; sessionId?: string }>('/api/pi/chat', {
        text,
        ...(task ? { taskId: task.id } : {}),
        ...(editWorkflowId ? { allowEditWorkflowId: editWorkflowId } : {}),
      });
      if (typeof result.text === 'string')
        setMessages((previous) => {
          const userIndex = previous.findIndex((message) => message.id === userMessageId);
          const assistantIndex = previous.findIndex(
            (message, index) =>
              index > userIndex &&
              message.role === 'assistant' &&
              message.contextKey === contextKey,
          );
          return assistantIndex >= 0
            ? previous.map((message, index) =>
                index === assistantIndex ? { ...message, text: result.text! } : message,
              )
            : [
                ...previous,
                { id: crypto.randomUUID(), role: 'assistant', text: result.text!, contextKey },
              ];
        });
    } catch (e) {
      onError(errorText(e));
      if (currentContext.current === contextKey) setDraft((current) => current || text);
    } finally {
      setBusy(false);
    }
  }
  return (
    <aside className={`pi-panel ${mobileOpen ? 'mobile-open' : ''}`} aria-label="Pi 分析助手">
      <div className="pi-header">
        <div>
          <span className="pi-symbol">π</span>
          <h2>Pi 助手</h2>
          <span className={`pi-ready ${pi.configured ? 'ready' : ''}`} />
        </div>
        <button
          className="icon-button pi-settings-button"
          onClick={onSettings}
          aria-label="Pi 连接设置"
        >
          <Settings2 size={17} />
        </button>
        <button className="icon-button mobile-pi-close" onClick={onClose} aria-label="收起助手">
          <X size={19} />
        </button>
      </div>
      <div className="pi-context">
        <span>当前上下文</span>
        <strong>{task ? task.name : '工作台'}</strong>
        {pi.model && <small>{pi.model.id}</small>}
      </div>
      <div className="pi-messages" aria-live="polite" aria-relevant="additions text">
        {!visibleMessages.length && (
          <div className="pi-intro">
            <div className="pi-line-art">
              <MessageSquare size={24} strokeWidth={1.3} />
            </div>
            <p>我可以整理测试目标、阅读通话证据，以及协助改进你选定的 AI 客服。</p>
            {pi.configured && task ? (
              <div className="pi-suggestions">
                <button
                  onClick={() =>
                    setDraft(
                      '帮我分析当前任务发现的问题，先对照录音和时间点，区分已确认的问题与候选问题。',
                    )
                  }
                >
                  分析当前任务的发现
                  <ArrowUp size={14} />
                </button>
                <button
                  onClick={() =>
                    setDraft('根据当前测试目标，建议几个容易漏测的对话场景。先给建议，不启动通话。')
                  }
                >
                  补充容易漏测的场景
                  <ArrowUp size={14} />
                </button>
              </div>
            ) : !pi.configured ? (
              <div className="pi-connect">
                <p>连接自己的 Codex 订阅或 API key，开始分析。</p>
                <button className="button secondary" onClick={onSettings}>
                  连接 Pi
                  <ArrowRight size={14} />
                </button>
              </div>
            ) : null}
            <div className="pi-quiet-note">
              <ShieldCheck size={14} />
              <span>草稿修改限定到你授权的 workflow，保留变更前快照。</span>
            </div>
          </div>
        )}
        {visibleMessages.map((message) => (
          <div className={`chat-message chat-${message.role}`} key={message.id}>
            {message.role !== 'notice' && (
              <span className="chat-author">{message.role === 'user' ? '你' : 'Pi'}</span>
            )}
            <div className="chat-text">{message.text}</div>
          </div>
        ))}
        {busy && (
          <div className="pi-thinking">
            <Busy />
            <span>Pi 正在处理…</span>
          </div>
        )}
        <div ref={bottom} />
      </div>
      <form className="pi-compose" onSubmit={send}>
        {task && (
          <label className="edit-permission">
            <input
              type="checkbox"
              checked={allowEdit}
              onChange={(event) => setAllowEdit(event.target.checked)}
            />
            <span>
              本轮对话允许修改 <strong>{task.workflowName}</strong> 的草稿
            </span>
          </label>
        )}
        <div className="pi-input-box">
          <textarea
            aria-label="发给 Pi 的消息"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            rows={3}
            placeholder={pi.configured ? '描述你想分析或改进的内容…' : '先连接 Pi，再开始对话'}
            disabled={!pi.configured}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
          />
          <div className="pi-compose-bottom">
            <span>{pi.configured ? '⌘ / Ctrl + Enter 发送' : '尚未连接'}</span>
            {busy ? (
              <button
                className="send-button stop"
                type="button"
                aria-label="停止 Pi 回应"
                onClick={() => void api('/api/pi/abort', {}).catch((e) => onError(errorText(e)))}
              >
                <Square size={14} />
              </button>
            ) : (
              <button
                className="send-button"
                type="submit"
                aria-label="发送消息"
                disabled={!draft.trim() || !pi.configured}
              >
                <ArrowUp size={17} />
              </button>
            )}
          </div>
        </div>
      </form>
    </aside>
  );
}
