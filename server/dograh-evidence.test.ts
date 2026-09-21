import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  downloadArtifact,
  parseDograhTranscript,
  redactContext,
  dograhParsedEvidence,
} from './dograh-evidence.js';

afterEach(() => vi.unstubAllGlobals());
describe('Dograh saved evidence', () => {
  it('preserves multiline provider turns, roles and run-relative timestamps', () => {
    const turns = parseDograhTranscript(
      '[2026-09-21T07:40:01Z] assistant: こんにちは\n[2026-09-21T07:40:03Z] user: 崇城大学前\nお願いします',
      '2026-09-21T07:40:00Z',
    );
    expect(turns.map((t) => [t.id, t.speaker, t.atMs, t.text])).toEqual([
      ['dograh:1', 'agent', 1000, 'こんにちは'],
      ['dograh:2', 'caller', 3000, '崇城大学前\nお願いします'],
    ]);
    expect(turns.every((t) => t.audioVerified === false)).toBe(true);
    expect(
      dograhParsedEvidence(
        {
          transcript: turns,
          gatheredContext: null,
          recordings: { mixed: false, caller: false, agent: false },
          timingBasis: '',
        },
        2,
      ).durationMs,
    ).toBe(3000);
  });
  it('rejects missing speakers, malformed headers and backwards timestamps instead of silently truncating', () => {
    const start = '2026-09-21T07:40:00Z';
    expect(() => parseDograhTranscript('[2026-09-21T07:40:01Z] user: hello', start)).toThrow(
      '双方',
    );
    expect(() => parseDograhTranscript('[invalid] user: hello', start)).toThrow('时间');
    expect(() =>
      parseDograhTranscript(
        '[2026-09-21T07:40:03Z] user: hi\n[2026-09-21T07:40:01Z] assistant: hi',
        start,
      ),
    ).toThrow('顺序');
    expect(() => parseDograhTranscript('unknown format', start)).toThrow('格式');
  });
  it('removes nested credentials and signed links while keeping business context', () => {
    expect(
      redactContext(
        {
          destination: '崇城大学前',
          nested: [{ api_key: 'secret', note: 'known-key', link: 'https://host/file?token=abc' }],
        },
        ['known-key'],
      ),
    ).toEqual({
      destination: '崇城大学前',
      nested: [{ api_key: '[redacted]', note: '[redacted]', link: '[URL omitted]' }],
    });
  });
  it('restricts downloads to same-origin artifact routes without forwarding credentials or redirects', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('transcript'));
    vi.stubGlobal('fetch', fetcher);
    await expect(
      downloadArtifact(
        'https://other/api/v1/public/download/workflow/abc/transcript',
        'https://dograh.test',
        100,
      ),
    ).rejects.toThrow('范围');
    await expect(
      downloadArtifact('https://dograh.test/settings', 'https://dograh.test', 100),
    ).rejects.toThrow('范围');
    expect(fetcher).not.toHaveBeenCalled();
    const result = await downloadArtifact(
      'https://dograh.test/api/v1/public/download/workflow/abc/transcript',
      'https://dograh.test',
      100,
    );
    expect(result.toString()).toBe('transcript');
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ redirect: 'manual' });
    expect(fetcher.mock.calls[0]![1]).not.toHaveProperty('headers');
  });
  it('follows only a bounded same-origin recording redirect and rejects external redirects', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: 'https://evil.test/file' } }),
      );
    vi.stubGlobal('fetch', fetcher);
    const url = 'https://dograh.test/api/v1/public/download/workflow/abc/transcript';
    await expect(downloadArtifact(url, 'https://dograh.test', 100)).rejects.toThrow('跳转');
    expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: '/voice-audio/transcripts/821.txt?signature=private' },
        }),
      )
      .mockResolvedValueOnce(new Response('text'));
    expect((await downloadArtifact(url, 'https://dograh.test', 100)).toString()).toBe('text');
    expect(fetcher.mock.calls[2]![1]).toMatchObject({ redirect: 'error' });
    expect(fetcher.mock.calls[2]![1]).not.toHaveProperty('headers');
  });

  it('bounds streamed artifact size', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('too long')));
    await expect(
      downloadArtifact(
        'https://dograh.test/api/v1/public/download/workflow/abc/transcript',
        'https://dograh.test',
        2,
      ),
    ).rejects.toThrow('上限');
  });
});
