/** Remove obsolete audio cross-check caveats without changing test verdicts. */
export function removeRetiredAudioCaveats(text: string): string {
  return text
    .replace(
      /[，,；;]?[^，,；;。！？\n]*(?:独立[^，,；;。！？\n]{0,12}(?:录音|音频)|(?:录音|音频)[^，,；;。！？\n]{0,12}独立)[^，,；;。！？\n]*[；;]?/g,
      '',
    )
    .replace(/^[。！？；;，,\s]+/u, '')
    .replace(/([。！？])\s*[。！？]+/g, '$1')
    .trim();
}
