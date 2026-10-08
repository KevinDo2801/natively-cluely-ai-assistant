export type DictateUiPhase = 'idle' | 'recording' | 'cleaning';

export type DictateActivationMode = 'hold' | 'toggle';

export interface DictatePreferences {
  microphoneId: string;
  language: string;
  shortcut: string[];
  autoPaste: boolean;
  dictationSounds: boolean;
  pauseMedia: boolean;
  textCleanup: boolean;
  activationMode: DictateActivationMode;
}

export const DEFAULT_DICTATE_PREFERENCES: DictatePreferences = {
  microphoneId: 'system-default',
  language: 'auto',
  shortcut: ['Ctrl', 'Alt'],
  autoPaste: true,
  dictationSounds: true,
  pauseMedia: false,
  textCleanup: true,
  activationMode: 'hold',
};

const PREFERENCES_KEY = 'natively_dictate_preferences_v1';
const PHASE_KEY = 'natively_dictate_ui_phase_v1';
export const DICTATE_PREFERENCES_EVENT = 'natively:dictate-preferences';
export const DICTATE_PHASE_EVENT = 'natively:dictate-phase';

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

function sanitizePreferences(value: unknown): DictatePreferences {
  if (!value || typeof value !== 'object') return DEFAULT_DICTATE_PREFERENCES;
  const candidate = value as Partial<DictatePreferences>;
  const legacyLanguages: Record<string, string> = {
    en: 'english-us', vi: 'vietnamese', es: 'spanish', fr: 'french', de: 'german',
    ja: 'japanese', ko: 'korean', zh: 'chinese',
  };
  const rawLanguage = typeof candidate.language === 'string'
    ? candidate.language
    : DEFAULT_DICTATE_PREFERENCES.language;
  return {
    microphoneId:
      typeof candidate.microphoneId === 'string'
        ? candidate.microphoneId
        : DEFAULT_DICTATE_PREFERENCES.microphoneId,
    language: legacyLanguages[rawLanguage] || rawLanguage,
    shortcut:
      Array.isArray(candidate.shortcut) && candidate.shortcut.every((key) => typeof key === 'string')
        ? candidate.shortcut
        : DEFAULT_DICTATE_PREFERENCES.shortcut,
    autoPaste: isBoolean(candidate.autoPaste)
      ? candidate.autoPaste
      : DEFAULT_DICTATE_PREFERENCES.autoPaste,
    dictationSounds: isBoolean(candidate.dictationSounds)
      ? candidate.dictationSounds
      : DEFAULT_DICTATE_PREFERENCES.dictationSounds,
    pauseMedia: isBoolean(candidate.pauseMedia)
      ? candidate.pauseMedia
      : DEFAULT_DICTATE_PREFERENCES.pauseMedia,
    textCleanup: isBoolean(candidate.textCleanup)
      ? candidate.textCleanup
      : DEFAULT_DICTATE_PREFERENCES.textCleanup,
    activationMode: candidate.activationMode === 'toggle' ? 'toggle' : 'hold',
  };
}

export function loadDictatePreferences(): DictatePreferences {
  try {
    return sanitizePreferences(JSON.parse(localStorage.getItem(PREFERENCES_KEY) ?? 'null'));
  } catch {
    return DEFAULT_DICTATE_PREFERENCES;
  }
}

export function saveDictatePreferences(next: DictatePreferences): void {
  const sanitized = sanitizePreferences(next);
  localStorage.setItem(PREFERENCES_KEY, JSON.stringify(sanitized));
  void window.electronAPI?.setSystemDictatePreferences?.(sanitized).catch((error) => {
    console.error('Failed to save Dictate preferences:', error);
  });
  window.dispatchEvent(
    new CustomEvent<DictatePreferences>(DICTATE_PREFERENCES_EVENT, { detail: sanitized }),
  );
}

export function subscribeToDictatePreferences(
  listener: (preferences: DictatePreferences) => void,
): () => void {
  const onCustomEvent = (event: Event) => {
    listener((event as CustomEvent<DictatePreferences>).detail);
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key === PREFERENCES_KEY) listener(loadDictatePreferences());
  };
  window.addEventListener(DICTATE_PREFERENCES_EVENT, onCustomEvent);
  window.addEventListener('storage', onStorage);
  const unsubscribeBackend = window.electronAPI?.onSystemDictatePreferences?.((preferences) => {
    const sanitized = sanitizePreferences(preferences);
    localStorage.setItem(PREFERENCES_KEY, JSON.stringify(sanitized));
    listener(sanitized);
  });
  void window.electronAPI?.getSystemDictatePreferences?.().then((preferences) => {
    const sanitized = sanitizePreferences(preferences);
    localStorage.setItem(PREFERENCES_KEY, JSON.stringify(sanitized));
    listener(sanitized);
  }).catch(() => undefined);
  return () => {
    unsubscribeBackend?.();
    window.removeEventListener(DICTATE_PREFERENCES_EVENT, onCustomEvent);
    window.removeEventListener('storage', onStorage);
  };
}

export function publishDictateUiPhase(phase: DictateUiPhase): void {
  if (phase === 'idle') void window.electronAPI?.cancelSystemDictate?.();
  const payload = { phase, nonce: `${Date.now()}-${Math.random()}` };
  localStorage.setItem(PHASE_KEY, JSON.stringify(payload));
  window.dispatchEvent(
    new CustomEvent<DictateUiPhase>(DICTATE_PHASE_EVENT, { detail: phase }),
  );
}

export function subscribeToDictateUiPhase(
  listener: (phase: DictateUiPhase) => void,
): () => void {
  const onCustomEvent = (event: Event) => {
    listener((event as CustomEvent<DictateUiPhase>).detail);
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key !== PHASE_KEY || !event.newValue) return;
    try {
      const phase = JSON.parse(event.newValue)?.phase;
      if (phase === 'idle' || phase === 'recording' || phase === 'cleaning') listener(phase);
    } catch {
      // Ignore a malformed transient UI message.
    }
  };
  window.addEventListener(DICTATE_PHASE_EVENT, onCustomEvent);
  window.addEventListener('storage', onStorage);
  const unsubscribeBackend = window.electronAPI?.onSystemDictateState?.(({ phase }) => {
    if (phase === 'idle' || phase === 'recording' || phase === 'cleaning') listener(phase);
  });
  void window.electronAPI?.getSystemDictateState?.().then(({ phase }) => listener(phase)).catch(() => undefined);
  return () => {
    unsubscribeBackend?.();
    window.removeEventListener(DICTATE_PHASE_EVENT, onCustomEvent);
    window.removeEventListener('storage', onStorage);
  };
}

export function eventMatchesDictateShortcut(
  event: KeyboardEvent,
  shortcut: readonly string[],
): boolean {
  const wanted = new Set(shortcut);
  const modifiersMatch =
    event.ctrlKey === wanted.has('Ctrl') &&
    event.altKey === wanted.has('Alt') &&
    event.shiftKey === wanted.has('Shift') &&
    event.metaKey === wanted.has('Meta');
  if (!modifiersMatch) return false;

  const mainKey = shortcut.find((key) => !['Ctrl', 'Alt', 'Shift', 'Meta'].includes(key));
  if (!mainKey) return true;
  return event.key.toLocaleLowerCase() === mainKey.toLocaleLowerCase();
}
