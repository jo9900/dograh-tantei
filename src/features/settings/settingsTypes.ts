import type { WorkbenchState } from '../../../shared/types';
import type { Api } from '../../types';

export type SettingsPage = 'dograh' | 'caller' | 'pi' | 'jev' | 'runtime';
export interface SettingsPanelProps {
  state: WorkbenchState;
  api: Api;
  refresh: () => Promise<WorkbenchState>;
  pending: string;
  perform: (id: string, action: () => Promise<void>) => Promise<void>;
  onNotice: (message: string) => void;
}

/** Preserve saved values in other categories; never submit their uncommitted drafts. */
export function savedConnectionSettings(state: WorkbenchState) {
  return {
    dograhBaseUrl: state.settings.dograhBaseUrl,
    dograhAuthMode: 'token' as const,
    voice: state.settings.voice,
    maxConcurrency: state.settings.maxConcurrency,
  };
}
