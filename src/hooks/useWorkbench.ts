import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppEvent, WorkbenchState } from '../../shared/types';
import { errorText } from '../lib/presentation';
import type { Api, AuthPrompt, ChatMessage, WorkflowChoice } from '../types';

interface WorkbenchCallbacks {
  onError: (message: string) => void;
  onNotice: (message: string) => void;
  onAuthenticationRequired: () => void;
}

/** Owns the local API session, SSE updates, workflow loading and Pi streaming state. */
export function useWorkbench({ onError, onNotice, onAuthenticationRequired }: WorkbenchCallbacks) {
  const [state, setState] = useState<WorkbenchState | null>(null);
  const [connected, setConnected] = useState(false);
  const [workflows, setWorkflows] = useState<WorkflowChoice[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [authPrompt, setAuthPrompt] = useState<AuthPrompt | null>(null);
  const [authEvents, setAuthEvents] = useState<Record<string, unknown>[]>([]);
  const [piPending, setPiPending] = useState(false);
  const csrf = useRef('');
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const workflowRequest = useRef(0);

  const api = useCallback<Api>(async (url, body, method) => {
    const mutation = method ?? (body === undefined ? 'GET' : 'POST');
    const response = await fetch(url, {
      method: mutation,
      headers: {
        Accept: 'application/json',
        ...(mutation === 'GET'
          ? {}
          : { 'Content-Type': 'application/json', 'X-Tantei-Token': csrf.current }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok)
      throw new Error(
        typeof data.error === 'string'
          ? data.error
          : typeof data.message === 'string'
            ? data.message
            : `请求失败（${response.status}），请检查连接后重试。`,
      );
    return data;
  }, []);
  const refresh = useCallback(async () => {
    const next = await api<WorkbenchState & { csrfToken: string }>('/api/state');
    if (next.csrfToken) csrf.current = next.csrfToken;
    setState(next);
    return next;
  }, [api]);
  const workflowsLoaded = useCallback((items: WorkflowChoice[]) => {
    workflowRequest.current++;
    setWorkflows(items);
  }, []);

  useEffect(() => {
    void refresh().catch((e) => onError(errorText(e)));
    const events = new EventSource('/api/events');
    events.onopen = () => setConnected(true);
    events.onerror = () => setConnected(false);
    events.onmessage = (message) => {
      let event: AppEvent;
      try {
        event = JSON.parse(message.data);
      } catch {
        return;
      }
      if (event.type === 'task.deleted') {
        setMessages((previous) =>
          previous.filter((item) => item.contextKey !== `task:${event.taskId}`),
        );
      }
      if (event.type === 'pi.text.delta') {
        setMessages((previous) => {
          const index = previous.findIndex(
            (item) => item.runId === event.runId && item.role === 'assistant',
          );
          if (index < 0)
            return [
              ...previous,
              {
                id: crypto.randomUUID(),
                role: 'assistant',
                runId: String(event.runId),
                contextKey: String(event.contextKey ?? 'workbench'),
                text: String(event.delta ?? ''),
              },
            ];
          return previous.map((item, i) =>
            i === index ? { ...item, text: item.text + String(event.delta ?? '') } : item,
          );
        });
      } else {
        if (event.type === 'pi.chat.started') setPiPending(true);
        if (event.type === 'pi.chat.complete') {
          setPiPending(false);
          setMessages((previous) =>
            previous.some((item) => item.runId === event.runId)
              ? previous.map((item) =>
                  item.runId === event.runId && typeof event.text === 'string'
                    ? { ...item, text: event.text }
                    : item,
                )
              : [
                  ...previous,
                  {
                    id: crypto.randomUUID(),
                    role: 'assistant',
                    text: String(event.text ?? ''),
                    runId: String(event.runId),
                    contextKey: String(event.contextKey ?? 'workbench'),
                  },
                ],
          );
        }
        if (event.type === 'pi.chat.error') {
          setPiPending(false);
          setMessages((previous) => [
            ...previous,
            {
              id: crypto.randomUUID(),
              role: 'notice',
              contextKey: String(event.contextKey ?? 'workbench'),
              text: String(event.message ?? 'Pi 回应未完成，请重试。'),
            },
          ]);
        }
        if (event.type === 'pi.auth.prompt') {
          setAuthPrompt({
            promptId: String(event.promptId),
            prompt: (event.prompt ?? {}) as Record<string, unknown>,
          });
          onAuthenticationRequired();
        }
        if (event.type === 'pi.auth.notify')
          setAuthEvents((previous) => [...previous, event.event as Record<string, unknown>]);
        if (event.type === 'pi.auth.prompt.closed') setAuthPrompt(null);
        if (event.type === 'pi.auth.complete') {
          setAuthPrompt(null);
          setAuthEvents([]);
          onNotice('Pi 已连接，可以选择模型。');
        }
        if (event.type === 'pi.auth.error') {
          setAuthPrompt(null);
          onError(String(event.message ?? '登录失败，请重新连接。'));
        }
        if (event.type === 'pi.auth.cancelled') {
          setAuthPrompt(null);
          setAuthEvents([]);
        }
        if (event.type === 'notice') onNotice(String(event.message ?? ''));
        if (!refreshTimer.current)
          refreshTimer.current = setTimeout(() => {
            refreshTimer.current = null;
            void refresh().catch(() => {});
          }, 350);
      }
    };
    return () => {
      events.close();
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    };
  }, [refresh, onError, onNotice, onAuthenticationRequired]);
  useEffect(() => {
    const request = ++workflowRequest.current;
    setWorkflows([]);
    if (state?.settings.dograhCredentialSet)
      void api<{ workflows: WorkflowChoice[] }>('/api/workflows')
        .then((result) => {
          if (workflowRequest.current === request) setWorkflows(result.workflows);
        })
        .catch(() => {});
    return () => {
      workflowRequest.current++;
    };
  }, [
    state?.settings.dograhCredentialSet,
    state?.settings.dograhAuthMode,
    state?.settings.dograhTokenSet,
    state?.settings.dograhKeySet,
    state?.settings.dograhBaseUrl,
    api,
  ]);

  return {
    state,
    connected,
    workflows,
    workflowsLoaded,
    messages,
    setMessages,
    authPrompt,
    authEvents,
    piPending,
    setPiPending,
    api,
    refresh,
  };
}
