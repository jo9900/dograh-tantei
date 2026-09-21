import { Check } from 'lucide-react';
import { Field } from '../../components/ui';

/** Environment credentials are represented by their source, never their value. */
export function CredentialField({
  label,
  environmentKey,
  saved,
  value,
  onChange,
  disabled,
  hint,
}: {
  label: string;
  environmentKey?: string;
  saved?: boolean;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  hint?: string;
}) {
  return environmentKey ? (
    <div className="field">
      <span className="field-label">{label}</span>
      <div className="credential-summary">
        <Check size={19} aria-hidden="true" />
        <div>
          <strong>已从 .env / 环境变量加载</strong>
          <code>{environmentKey}</code>
        </div>
        <span className="credential-source">环境变量</span>
      </div>
      <span className="field-hint">修改启动配置后，重启本地服务生效。</span>
    </div>
  ) : (
    <Field label={label} hint={hint}>
      <input
        type="password"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        autoComplete="new-password"
        spellCheck={false}
        placeholder={saved ? '已保存 · 留空保留' : `输入${label}`}
      />
    </Field>
  );
}
