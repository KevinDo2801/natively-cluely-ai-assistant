import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  ChevronDown,
  Command,
  Languages,
  Mic,
  Pause,
  Sparkles,
  Volume2,
  WandSparkles,
} from 'lucide-react';
import { useT } from '../../i18n';
import {
  DEFAULT_DICTATE_PREFERENCES,
  loadDictatePreferences,
  saveDictatePreferences,
  subscribeToDictatePreferences,
  type DictatePreferences,
} from '../../lib/dictateUi';
import { SettingsToggle } from './SettingsToggle';
import { VoiceBrandMarkIcon } from '../ui/VoiceBrandMarkIcon';

const MODIFIER_KEYS = new Set(['Control', 'Alt', 'Shift', 'Meta']);
const DICTATE_LANGUAGES = [
  { value: 'auto', label: 'Auto detect' },
  { value: 'english-us', label: 'English' },
  { value: 'vietnamese', label: 'Vietnamese' },
  { value: 'spanish', label: 'Spanish' },
  { value: 'french', label: 'French' },
  { value: 'german', label: 'German' },
  { value: 'japanese', label: 'Japanese' },
  { value: 'korean', label: 'Korean' },
  { value: 'chinese', label: 'Chinese' },
];

function keyboardEventToKeys(event: React.KeyboardEvent): string[] {
  const keys: string[] = [];
  if (event.ctrlKey) keys.push('Ctrl');
  if (event.altKey) keys.push('Alt');
  if (event.shiftKey) keys.push('Shift');
  if (event.metaKey) keys.push('Meta');
  if (!MODIFIER_KEYS.has(event.key)) {
    keys.push(event.code.startsWith('Key') ? event.key.toUpperCase() : event.key);
  }
  return keys;
}

function useDictatePreferences() {
  const [preferences, setPreferences] = useState<DictatePreferences>(loadDictatePreferences);

  useEffect(() => subscribeToDictatePreferences(setPreferences), []);

  const updatePreferences = (patch: Partial<DictatePreferences>) => {
    setPreferences((current) => {
      const next = { ...current, ...patch };
      saveDictatePreferences(next);
      return next;
    });
  };

  return { preferences, updatePreferences };
}

interface DictateShortcutControlProps {
  compact?: boolean;
}

export function DictateShortcutControl({ compact = false }: DictateShortcutControlProps) {
  const t = useT();
  const { preferences, updatePreferences } = useDictatePreferences();
  const [recording, setRecording] = useState(false);
  const [draftKeys, setDraftKeys] = useState<string[]>([]);
  const recorderRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (recording) recorderRef.current?.focus();
  }, [recording]);

  const commitShortcut = (keys: string[]) => {
    if (keys.length < 2) return;
    updatePreferences({ shortcut: keys });
    setDraftKeys([]);
    setRecording(false);
  };

  const visibleKeys = recording && draftKeys.length > 0 ? draftKeys : preferences.shortcut;

  return (
    <div className={`flex items-center ${compact ? 'gap-2' : 'gap-3'}`}>
      <button
        ref={recorderRef}
        type="button"
        data-dictate-shortcut-recorder="true"
        aria-label={recording ? t('Press and hold a shortcut') : t('Change Dictate shortcut')}
        aria-pressed={recording}
        onClick={() => {
          setDraftKeys([]);
          setRecording(true);
        }}
        onBlur={() => {
          setDraftKeys([]);
          setRecording(false);
        }}
        onKeyDown={(event) => {
          if (!recording) return;
          event.preventDefault();
          event.stopPropagation();
          if (event.key === 'Escape') {
            setDraftKeys([]);
            setRecording(false);
            return;
          }
          const keys = keyboardEventToKeys(event);
          setDraftKeys(keys);
          if (!MODIFIER_KEYS.has(event.key)) commitShortcut(keys);
        }}
        onKeyUp={(event) => {
          if (!recording) return;
          event.preventDefault();
          event.stopPropagation();
          if (MODIFIER_KEYS.has(event.key)) commitShortcut(draftKeys);
        }}
        className={`flex min-h-8 items-center justify-center gap-1 rounded-lg border transition-colors focus:outline-none focus:ring-2 focus:ring-accent-primary/30 ${
          recording
            ? 'border-accent-primary bg-accent-primary/10 text-accent-primary'
            : 'border-border-subtle bg-bg-input text-text-secondary hover:border-text-tertiary'
        } ${compact ? 'px-2 py-1' : 'px-3 py-1.5'}`}
      >
        {recording && visibleKeys.length === 0 ? (
          <span className="px-1 text-[11px] font-medium">{t('Hold keys…')}</span>
        ) : (
          visibleKeys.map((key) => (
            <kbd
              key={key}
              className="min-w-7 rounded-md border border-border-subtle bg-bg-elevated px-1.5 py-0.5 text-center text-[11px] font-medium text-text-primary shadow-sm"
            >
              {key}
            </kbd>
          ))
        )}
      </button>
      {!compact && preferences.shortcut.join('+') !== DEFAULT_DICTATE_PREFERENCES.shortcut.join('+') ? (
        <button
          type="button"
          onClick={() => updatePreferences({ shortcut: DEFAULT_DICTATE_PREFERENCES.shortcut })}
          className="text-[11px] font-medium text-text-tertiary transition-colors hover:text-text-primary"
        >
          {t('Reset')}
        </button>
      ) : null}
    </div>
  );
}

interface PreferenceRowProps {
  icon: React.ReactNode;
  title: string;
  description: string;
  children: React.ReactNode;
}

function PreferenceRow({ icon, title, description, children }: PreferenceRowProps) {
  return (
    <div className="flex items-center justify-between gap-5 px-4 py-3.5">
      <div className="flex min-w-0 items-center gap-3.5">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border-subtle bg-bg-item-surface text-text-secondary">
          {icon}
        </div>
        <div className="min-w-0">
          <div className="text-sm font-medium text-text-primary">{title}</div>
          <p className="mt-0.5 text-[11px] leading-relaxed text-text-tertiary">{description}</p>
        </div>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function SelectControl({
  value,
  onChange,
  children,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  children: React.ReactNode;
  label: string;
}) {
  return (
    <div className="relative">
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-label={label}
        className="h-9 min-w-40 appearance-none rounded-lg border border-border-subtle bg-bg-input pl-3 pr-9 text-xs font-medium text-text-primary outline-none transition-colors hover:border-text-tertiary focus:border-accent-primary"
      >
        {children}
      </select>
      <ChevronDown
        size={14}
        aria-hidden="true"
        className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-text-tertiary"
      />
    </div>
  );
}

export function DictateSettings() {
  const t = useT();
  const { preferences, updatePreferences } = useDictatePreferences();
  const [microphones, setMicrophones] = useState<MediaDeviceInfo[]>([]);

  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      try {
        const devices = await navigator.mediaDevices?.enumerateDevices?.();
        if (alive) setMicrophones(devices?.filter((device) => device.kind === 'audioinput') ?? []);
      } catch {
        if (alive) setMicrophones([]);
      }
    };
    void refresh();
    navigator.mediaDevices?.addEventListener?.('devicechange', refresh);
    return () => {
      alive = false;
      navigator.mediaDevices?.removeEventListener?.('devicechange', refresh);
    };
  }, []);

  const uniqueMicrophones = useMemo(() => {
    const seen = new Set<string>();
    return microphones.filter((device) => {
      if (!device.deviceId || seen.has(device.deviceId)) return false;
      seen.add(device.deviceId);
      return true;
    });
  }, [microphones]);

  const toggle = (key: 'autoPaste' | 'dictationSounds' | 'pauseMedia' | 'textCleanup') => {
    updatePreferences({ [key]: !preferences[key] });
  };

  return (
    <div className="space-y-6 animated fadeIn pb-4" data-settings-stagger>
      <div>
        <h3 className="mb-1 text-lg font-bold text-text-primary">{t('Dictate')}</h3>
        <p className="text-xs text-text-secondary">
          {t('Hold your shortcut, speak naturally, then release to paste polished text.')}
        </p>
      </div>

      <div className="relative overflow-hidden rounded-2xl border border-accent-primary/20 bg-gradient-to-br from-accent-primary/12 via-bg-card to-bg-card p-5">
        <div className="absolute -right-12 -top-16 h-40 w-40 rounded-full bg-accent-primary/10 blur-3xl" />
        <div className="relative flex items-center justify-between gap-6">
          <div>
            <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-text-primary">
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-accent-primary text-on-accent">
                <VoiceBrandMarkIcon size={16} />
              </span>
              {t('Hold to dictate')}
            </div>
            <p className="max-w-md text-xs leading-relaxed text-text-secondary">
              {t('The TopPill becomes a live waveform while you hold the shortcut. Release it to clean up and paste your words.')}
            </p>
          </div>
          <DictateShortcutControl />
        </div>
      </div>

      <section>
        <div className="mb-3">
          <h4 className="text-sm font-bold text-text-primary">{t('Input')}</h4>
          <p className="mt-0.5 text-[11px] text-text-tertiary">{t('Choose how Natively listens and transcribes.')}</p>
        </div>
        <div className="divide-y divide-border-subtle overflow-hidden rounded-xl border border-border-subtle bg-bg-card">
          <PreferenceRow
            icon={<Mic size={16} />}
            title={t('Microphone')}
            description={t('Input device used for Dictate')}
          >
            <SelectControl
              value={preferences.microphoneId}
              onChange={(microphoneId) => updatePreferences({ microphoneId })}
              label={t('Dictate microphone')}
            >
              <option value="system-default">{t('System default')}</option>
              {uniqueMicrophones.map((device, index) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label || `${t('Microphone')} ${index + 1}`}
                </option>
              ))}
            </SelectControl>
          </PreferenceRow>
          <PreferenceRow
            icon={<Languages size={16} />}
            title={t('Language')}
            description={t('Language AssemblyAI should expect')}
          >
            <SelectControl
              value={preferences.language}
              onChange={(language) => updatePreferences({ language })}
              label={t('Dictation language')}
            >
              {DICTATE_LANGUAGES.map((language) => (
                <option key={language.value} value={language.value}>
                  {t(language.label)}
                </option>
              ))}
            </SelectControl>
          </PreferenceRow>
          <PreferenceRow
            icon={<Command size={16} />}
            title={t('Activation')}
            description={t('Keep the shortcut held while speaking')}
          >
            <div className="flex items-center gap-2 rounded-full border border-accent-primary/20 bg-accent-primary/10 px-3 py-1.5 text-[11px] font-semibold text-accent-primary">
              <Check size={12} /> {t('Hold')}
            </div>
          </PreferenceRow>
        </div>
      </section>

      <section>
        <div className="mb-3">
          <h4 className="text-sm font-bold text-text-primary">{t('Behavior')}</h4>
          <p className="mt-0.5 text-[11px] text-text-tertiary">{t('Preferences applied after every dictation.')}</p>
        </div>
        <div className="divide-y divide-border-subtle overflow-hidden rounded-xl border border-border-subtle bg-bg-card">
          <PreferenceRow
            icon={<Sparkles size={16} />}
            title={t('Automatic paste')}
            description={t('Paste the result into the app you were using')}
          >
            <SettingsToggle checked={preferences.autoPaste} onChange={() => toggle('autoPaste')} label={t('Automatic paste')} />
          </PreferenceRow>
          <PreferenceRow
            icon={<Volume2 size={16} />}
            title={t('Dictation sounds')}
            description={t('Play a quiet tone when recording starts and stops')}
          >
            <SettingsToggle checked={preferences.dictationSounds} onChange={() => toggle('dictationSounds')} label={t('Dictation sounds')} />
          </PreferenceRow>
          <PreferenceRow
            icon={<Pause size={16} />}
            title={t('Pause media')}
            description={t('Pause music and video while you are speaking')}
          >
            <SettingsToggle checked={preferences.pauseMedia} onChange={() => toggle('pauseMedia')} label={t('Pause media')} />
          </PreferenceRow>
        </div>
      </section>

      <section>
        <div className="mb-3">
          <h4 className="text-sm font-bold text-text-primary">{t('AI cleanup')}</h4>
          <p className="mt-0.5 text-[11px] text-text-tertiary">{t('Polish the transcript without changing your meaning.')}</p>
        </div>
        <div className="overflow-hidden rounded-xl border border-border-subtle bg-bg-card">
          <PreferenceRow
            icon={<WandSparkles size={16} />}
            title={t('Enable text cleanup')}
            description={t('Remove filler words, fix grammar, and polish punctuation')}
          >
            <SettingsToggle checked={preferences.textCleanup} onChange={() => toggle('textCleanup')} label={t('Enable text cleanup')} />
          </PreferenceRow>
          {preferences.textCleanup ? (
            <div className="grid grid-cols-2 gap-3 border-t border-border-subtle bg-bg-subtle/20 px-4 py-3">
              <div className="rounded-lg border border-border-subtle bg-bg-input px-3 py-2.5">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-text-tertiary">{t('Transcription')}</div>
                <div className="mt-1 text-xs font-semibold text-text-primary">AssemblyAI</div>
              </div>
              <div className="rounded-lg border border-border-subtle bg-bg-input px-3 py-2.5">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-text-tertiary">{t('Cleanup')}</div>
                <div className="mt-1 flex items-center gap-1.5 text-xs font-semibold text-text-primary">
                  Codex CLI
                  <span className="rounded-full bg-emerald-500/12 px-1.5 py-0.5 text-[9px] font-bold text-emerald-500">{t('Lowest cost')}</span>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}
