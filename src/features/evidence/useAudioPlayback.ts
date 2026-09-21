import type { SyntheticEvent } from 'react';
import { useRef, useState } from 'react';

/** Preserve requested evidence offsets until the audio can actually seek. */
export function useAudioPlayback(startMs?: number) {
  const [audioLoadError, setAudioLoadError] = useState('');
  const [audioReload, setAudioReload] = useState(0);
  const playbackPosition = useRef((startMs ?? 0) / 1000);
  const requestedSeek = useRef<{ seconds: number; play: boolean } | null>({
    seconds: (startMs ?? 0) / 1000,
    play: false,
  });
  const audio = useRef<HTMLAudioElement>(null);
  const applyRequestedSeek = () => {
    const element = audio.current;
    const request = requestedSeek.current;
    if (!element || !request || element.readyState < 1 || !Number.isFinite(element.duration))
      return;
    const target = Math.max(0, Math.min(request.seconds, element.duration));
    const targetAvailable =
      target === 0 ||
      Array.from(
        { length: element.seekable.length },
        (_, index) =>
          target >= element.seekable.start(index) && target <= element.seekable.end(index),
      ).some(Boolean);
    if (!targetAvailable) return;
    element.currentTime = target;
    playbackPosition.current = target;
    requestedSeek.current = null;
    if (request.play) void element.play().catch(() => {});
  };
  const seek = (seconds: number) => {
    requestedSeek.current = { seconds, play: true };
    applyRequestedSeek();
  };
  const retryAudio = () => {
    requestedSeek.current = {
      seconds: requestedSeek.current?.seconds ?? playbackPosition.current,
      play: requestedSeek.current?.play ?? false,
    };
    setAudioLoadError('');
    setAudioReload((value) => value + 1);
  };
  const handleAudioError = (event: SyntheticEvent<HTMLAudioElement>) => {
    if (event.currentTarget === audio.current)
      setAudioLoadError('录音加载失败，请重试。若仍无法播放，可打开 Dograh 通话页面核对原始记录。');
  };
  const handleTimeUpdate = () => {
    if (!requestedSeek.current && audio.current)
      playbackPosition.current = audio.current.currentTime;
  };
  return {
    audio,
    audioLoadError,
    audioReload,
    applyRequestedSeek,
    seek,
    retryAudio,
    handleAudioError,
    handleTimeUpdate,
  };
}
