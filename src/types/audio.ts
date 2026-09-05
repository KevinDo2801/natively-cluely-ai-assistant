export interface AudioResult {
  text: string;
  timestamp: number;
}

/** Audio channels enabled for a meeting recording. */
export const AUDIO_SOURCE_MODES = ['both', 'microphone', 'system'] as const;

export type AudioSourceMode = typeof AUDIO_SOURCE_MODES[number];

export function isAudioSourceMode(value: unknown): value is AudioSourceMode {
  return typeof value === 'string' && (AUDIO_SOURCE_MODES as readonly string[]).includes(value);
}

export function normalizeAudioSourceMode(value: unknown): AudioSourceMode {
  return isAudioSourceMode(value) ? value : 'both';
}

export function audioSourceIncludesMicrophone(source: AudioSourceMode): boolean {
  return source === 'both' || source === 'microphone';
}

export function audioSourceIncludesSystem(source: AudioSourceMode): boolean {
  return source === 'both' || source === 'system';
}
