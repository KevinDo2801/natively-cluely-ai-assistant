import { BrowserWindow, clipboard } from 'electron';
import type { AppState } from '../main';
import { loadNativeModule, type NativeModule } from '../audio/nativeModuleLoader';
import { SettingsManager } from '../services/SettingsManager';
import { CodexCliService } from '../services/CodexCliService';
import { CodexAppServerService } from '../services/CodexAppServerService';
import { DictateMediaController } from './DictateMediaController';
import {
  buildDictateCleanupPrompt, DEFAULT_DICTATE_PREFERENCES, DICTATE_CLEANUP_INSTRUCTIONS,
  modifiersMatch, normalizeCleanupOutput, sanitizeDictatePreferences, selectCheapestCodexModel,
  type DictatePhase, type DictatePreferences,
} from './dictateCore';

const POLL_MS = 20;

export class SystemDictationController {
  private timer: NodeJS.Timeout | null = null;
  private native: NativeModule | null = null;
  private held = false;
  private phase: DictatePhase = 'idle';
  private targetWindow = '';
  private readonly media = new DictateMediaController();
  private mediaPausePromise: Promise<void> | null = null;
  private cancelled = false;

  constructor(private readonly appState: AppState) {}

  public start(): void {
    if (this.timer) return;
    this.native = loadNativeModule();
    if (!this.native?.getGlobalModifierState) {
      console.warn('[SystemDictation] Passive modifier monitor unavailable; rebuild the native module.');
      return;
    }
    this.timer = setInterval(() => this.poll(), POLL_MS);
    this.timer.unref?.();
  }

  public stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    void this.cancel();
  }

  public getPreferences(): DictatePreferences {
    const s = SettingsManager.getInstance();
    return sanitizeDictatePreferences({
      microphoneId: s.get('dictateMicrophoneId'), language: s.get('dictateLanguage'),
      shortcut: s.get('dictateShortcut'), autoPaste: s.get('dictateAutoPaste'),
      dictationSounds: s.get('dictateSounds'), pauseMedia: s.get('dictatePauseMedia'),
      textCleanup: s.get('dictateTextCleanup'), activationMode: s.get('dictateActivationMode'),
    });
  }

  public setPreferences(value: unknown): DictatePreferences {
    const next = sanitizeDictatePreferences(value);
    const s = SettingsManager.getInstance();
    const writes = [
      s.set('dictateMicrophoneId', next.microphoneId), s.set('dictateLanguage', next.language),
      s.set('dictateShortcut', next.shortcut), s.set('dictateAutoPaste', next.autoPaste),
      s.set('dictateSounds', next.dictationSounds), s.set('dictatePauseMedia', next.pauseMedia),
      s.set('dictateTextCleanup', next.textCleanup), s.set('dictateActivationMode', next.activationMode),
    ];
    if (writes.some((ok) => !ok)) throw new Error('Dictate preferences could not be persisted.');
    this.broadcast('system-dictate:preferences', next);
    return next;
  }

  public getState(): { phase: DictatePhase } { return { phase: this.phase }; }

  /** Toggle dictation from an explicit control (e.g. the TopPill brand mark).
   *  Starts when idle, stops when recording. Unlike the passive hotkey, a
   *  manual toggle is NOT governed by the hold/toggle activation mode. */
  public toggle(): void {
    if (this.phase === 'idle') void this.begin(true);
    else if (this.phase === 'recording') void this.finish();
  }

  public async cancel(): Promise<void> {
    if (this.phase === 'idle') return;
    this.cancelled = true;
    await this.appState.cancelDictation().catch(() => undefined);
    await this.resumeMedia();
    this.setPhase('idle');
  }

  private poll(): void {
    if (!this.native?.getGlobalModifierState) return;
    let active = false;
    try {
      const shortcut = this.getPreferences().shortcut;
      const mainKey = shortcut.find((key) => !['Ctrl', 'Alt', 'Shift', 'Meta'].includes(key));
      active = modifiersMatch(this.native.getGlobalModifierState(), shortcut)
        && (!mainKey || this.native.isGlobalKeyDown?.(mainKey) === true);
    }
    catch { return; }
    if (active === this.held) return;
    this.held = active;
    if (active) {
      // Shortcut just pressed.
      if (this.getPreferences().activationMode === 'toggle') {
        if (this.phase === 'idle') void this.begin();
        else if (this.phase === 'recording') void this.finish();
      } else {
        void this.begin();
      }
    } else if (this.getPreferences().activationMode === 'hold' && this.phase === 'recording') {
      // Shortcut just released (hold mode only).
      void this.finish();
    }
  }

  private async begin(manual = false): Promise<void> {
    if (this.phase !== 'idle') return;
    const prefs = this.getPreferences();
    this.cancelled = false;
    this.targetWindow = this.native?.getForegroundWindowId?.() || '';
    try {
      await this.appState.startDictation(
        prefs.microphoneId === 'system-default' ? undefined : prefs.microphoneId,
        (level) => this.broadcast('system-dictate:level', level),
        (result) => void this.complete(result, prefs),
        { provider: 'assemblyai', language: prefs.language },
      );
      this.setPhase('recording');
      this.cue('start', prefs);
      if (prefs.pauseMedia) {
        this.mediaPausePromise = this.media.pausePlaying().then(async () => {
          if (this.phase !== 'recording') await this.media.resumePaused();
        }).finally(() => { this.mediaPausePromise = null; });
      }
      if (!manual && prefs.activationMode === 'hold' && !this.held) void this.finish();
    } catch (error) {
      await this.resumeMedia();
      this.fail(error);
    }
  }

  private async finish(): Promise<void> {
    if (this.phase !== 'recording') return;
    const prefs = this.getPreferences();
    this.setPhase('cleaning');
    this.cue('stop', prefs);
    try { await this.complete(await this.appState.stopDictation(), prefs); }
    catch (error) { this.fail(error); }
  }

  private async complete(result: { text: string; error?: string }, prefs: DictatePreferences): Promise<void> {
    if (this.cancelled || this.phase === 'idle') return;
    let text = result.text.trim();
    let warning = result.error;
    if (!text) {
      await this.resumeMedia();
      this.fail(warning || 'No speech was detected.');
      return;
    }
    if (prefs.textCleanup) {
      try {
        const startedAt = Date.now();
        const cleanupModel = selectCheapestCodexModel(await CodexAppServerService.getInstance().listModels());
        const cleaned = await CodexCliService.run('', {
          model: cleanupModel, prompt: buildDictateCleanupPrompt(text),
          instructions: DICTATE_CLEANUP_INSTRUCTIONS, timeoutMs: 30_000,
          sandboxMode: 'read-only', modelReasoningEffort: 'low', serviceTier: 'fast',
        });
        text = normalizeCleanupOutput(cleaned, text);
        console.log(`[SystemDictation] cleanup ${cleanupModel} ${Date.now() - startedAt}ms`);
      } catch (error) {
        warning = `AI cleanup failed; pasted raw transcript. ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    if (this.cancelled) {
      this.resumeMedia();
      return;
    }
    clipboard.writeText(text);
    let pasted = false;
    if (prefs.autoPaste) pasted = this.native?.pasteToWindow?.(this.targetWindow || null) === true;
    await this.resumeMedia();
    this.broadcast('system-dictate:finished', { text, pasted, copied: true, warning });
    this.setPhase('idle');
  }

  private async resumeMedia(): Promise<void> {
    await this.mediaPausePromise?.catch(() => undefined);
    await this.media.resumePaused().catch(() => false);
  }

  private setPhase(phase: DictatePhase): void {
    this.phase = phase;
    this.broadcast('system-dictate:state', { phase });
  }

  private cue(cue: 'start' | 'stop', prefs: DictatePreferences): void {
    if (prefs.dictationSounds) this.broadcast('system-dictate:cue', cue);
  }

  private fail(error: unknown): void {
    void this.resumeMedia();
    const message = error instanceof Error ? error.message : String(error);
    console.error('[SystemDictation]', message);
    this.broadcast('system-dictate:error', message);
    this.setPhase('idle');
  }

  private broadcast(channel: string, payload: unknown): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(channel, payload);
    }
  }
}

export { DEFAULT_DICTATE_PREFERENCES };
