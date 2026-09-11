/**
 * Types for electron/audio/dictationSession.mjs — the one-shot voice-dictation
 * lifecycle shared by the overlay composer.
 *
 * The capture and STT ends are typed structurally (the smallest surface this
 * module actually touches) rather than as the concrete MicrophoneCapture /
 * STTProvider classes: the module has to stay constructible with fakes in tests,
 * and it must not pull a native or provider import into its own graph.
 */

/** The slice of MicrophoneCapture this module drives. */
export interface DictationCapture {
  start(): void;
  stop(): Promise<void> | void;
  destroy?(): Promise<void> | void;
  disablePreWarm?(): void;
  on(event: string, listener: (...args: any[]) => void): any;
  removeAllListeners?(event?: string): any;
}

/** The slice of an STTProvider this module drives. */
export interface DictationStt {
  start?(): void;
  stop?(): void;
  write?(chunk: Buffer | Uint8Array): void;
  finalize?(): void;
  notifySpeechEnded?(): void;
  setSampleRate?(rate: number): void;
  on(event: string, listener: (...args: any[]) => void): any;
  removeAllListeners?(event?: string): any;
}

export interface DictationSessionDeps {
  createCapture: (deviceId?: string) => DictationCapture;
  /** Returns null when no STT provider is configured ('none' / missing key). */
  createStt: () => DictationStt | null;
  emitLevel?: (level: number) => void;
  /** Called only when the session stops itself at the duration ceiling. */
  onAutoStop?: (result: DictationResult) => void;
  finalizeGraceMs?: number;
  maxMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => any;
  clearTimer?: (handle: any) => void;
}

export interface DictationResult {
  text: string;
  /** First error the capture or provider reported, if any. Text is still
   *  returned when a partial transcript survived the failure. */
  error: Error | null;
}

export interface DictationSession {
  start(deviceId?: string): { startedAt: number };
  stop(): Promise<DictationResult>;
  cancel(): Promise<DictationResult>;
  readonly isActive: boolean;
  readonly elapsedMs: number;
}

/** RMS of a 16-bit mono PCM chunk, normalised to 0..1. */
export function computeRmsLevel(chunk: Buffer | Uint8Array): number;

export const DICTATION_FINALIZE_GRACE_MS: number;
export const DICTATION_MAX_MS: number;
export const DICTATION_EMPTY_TEXT: string;

export function createDictationSession(deps: DictationSessionDeps): DictationSession;
