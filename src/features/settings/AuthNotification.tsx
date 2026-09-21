import { ExternalLink } from 'lucide-react';

export function AuthNotification({ event }: { event: Record<string, unknown> }) {
  if (!event || typeof event !== 'object') return <p>{String(event)}</p>;
  const link = [event.url, event.verificationUri, event.verification_uri, event.authUrl].find(
    (value) => typeof value === 'string' && /^https?:\/\//.test(value),
  );
  const code = event.code ?? event.userCode ?? event.user_code;
  return (
    <div className="auth-notification">
      {typeof event.message === 'string' && <p>{event.message}</p>}
      {typeof event.instructions === 'string' && <p>{event.instructions}</p>}
      {typeof link === 'string' && (
        <a
          className="button secondary"
          href={String(link)}
          target="_blank"
          rel="noopener noreferrer"
        >
          打开授权页面
          <ExternalLink size={14} />
        </a>
      )}
      {code != null && (
        <p>
          授权码：<code>{String(code)}</code>
        </p>
      )}
      {!link && !code && !event.message && !event.instructions ? (
        <p>请按账号登录页面提示继续。</p>
      ) : null}
    </div>
  );
}
