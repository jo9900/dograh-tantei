import { LoaderCircle } from 'lucide-react';
import type { ReactNode } from 'react';
import { statusNames } from '../lib/presentation';

export const Busy = () => <LoaderCircle size={16} className="spin" aria-hidden="true" />;

export function Status({ value }: { value: string }) {
  return (
    <span className={`status status-${value}`}>
      <span className="status-dot" />
      {statusNames[value] ?? value}
    </span>
  );
}

export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}
