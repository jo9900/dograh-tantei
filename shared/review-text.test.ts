import { describe, expect, it } from 'vitest';
import { removeRetiredAudioCaveats } from './review-text';

describe('retired audio caveats', () => {
  it('removes the obsolete requirement while preserving the actual verdict', () => {
    expect(removeRetiredAudioCaveats('其余4通不确定，且缺少工具执行记录与独立录音核对。')).toBe(
      '其余4通不确定。',
    );
    expect(removeRetiredAudioCaveats('尚未独立核对录音；最终目的地未更新。')).toBe(
      '最终目的地未更新。',
    );
  });
  it('preserves concrete voice-agent problems', () => {
    expect(removeRetiredAudioCaveats('录音中客服重复确认旧地址。')).toBe(
      '录音中客服重复确认旧地址。',
    );
  });
});
