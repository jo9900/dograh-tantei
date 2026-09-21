import { X } from 'lucide-react';
import { useState } from 'react';
import { MAX_CONFIGURABLE_CONCURRENCY } from '../../../shared/limits';
import { Busy } from '../../components/ui';
import { useDialogFocus } from '../../hooks/useDialogFocus';
import { errorText } from '../../lib/presentation';
import type { Api } from '../../types';

export function ConcurrencyDialog({
  current,
  active,
  api,
  onSaved,
  onClose,
  onError,
}: {
  current: number;
  active: number;
  api: Api;
  onSaved: () => Promise<void>;
  onClose: () => void;
  onError: (message: string) => void;
}) {
  const [value, setValue] = useState(current);
  const [pending, setPending] = useState(false);
  const dialog = useDialogFocus<HTMLElement>(true, () => {
    if (!pending) onClose();
  });
  const valid =
    Number.isInteger(value) &&
    value >= Math.max(1, active) &&
    value <= MAX_CONFIGURABLE_CONCURRENCY;
  async function save() {
    if (!valid || pending) return;
    setPending(true);
    try {
      await api('/api/settings/concurrency', { maxConcurrency: value });
      await onSaved();
      onClose();
    } catch (failure) {
      onError(errorText(failure));
    } finally {
      setPending(false);
    }
  }
  return (
    <div
      className="workbench-dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !pending) onClose();
      }}
    >
      <section
        ref={dialog}
        className="workbench-dialog concurrency-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="concurrency-title"
        tabIndex={-1}
      >
        <div className="workbench-dialog-heading">
          <div>
            <span>共享并发容量</span>
            <h2 id="concurrency-title">调整全局并发上限</h2>
          </div>
          <button className="icon-button" onClick={onClose} disabled={pending} aria-label="关闭">
            <X size={19} />
          </button>
        </div>
        <label className="field">
          <span className="field-label">最大同时通话数（1–{MAX_CONFIGURABLE_CONCURRENCY} 路）</span>
          <input
            data-autofocus
            type="number"
            min={1}
            max={MAX_CONFIGURABLE_CONCURRENCY}
            value={value}
            aria-invalid={!valid}
            aria-describedby="concurrency-note"
            onChange={(event) => setValue(Number(event.target.value))}
          />
        </label>
        <div className="concurrency-current">
          <span>当前正在通话</span>
          <strong>{active} 路</strong>
        </div>
        <p id="concurrency-note" className={!valid ? 'error-ink' : ''} role="status">
          {!valid && value < active
            ? `当前有 ${active} 路正在通话，上限不能低于当前占用。`
            : !valid
              ? `请输入 1–${MAX_CONFIGURABLE_CONCURRENCY} 之间的整数。`
              : '保存后立即用于下一次派发；提高上限可能马上启动等待中的通话。实际容量仍受 Dograh、OpenAI 与本机音频能力限制。'}
        </p>
        <div className="workbench-dialog-footer">
          <button className="button secondary" onClick={onClose} disabled={pending}>
            取消
          </button>
          <button
            className="button primary"
            onClick={() => void save()}
            disabled={!valid || pending}
          >
            {pending && <Busy />}
            保存上限
          </button>
        </div>
      </section>
    </div>
  );
}
