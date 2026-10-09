import { useEffect, useState } from "react";
import { ChevronUp, ChevronDown, Mic, X } from "lucide-react";
import type { OverlayAppearance } from "../../lib/overlayAppearance";
import {
    publishDictateUiPhase,
    subscribeToDictateUiPhase,
    type DictateUiPhase,
} from "../../lib/dictateUi";
import { VoiceBrandMarkIcon } from "./VoiceBrandMarkIcon";

const WAVEFORM_BARS = [5, 9, 12, 7, 10, 14, 8, 11, 6];

// Dictation cue chime — a two-note sine "up" (start) / "down" (stop) interval,
// mirroring OpenWhispr's src/utils/dictationCues.js.
const CUE_NOTES: Record<'start' | 'stop', [number, number]> = {
    start: [523.25, 659.25], // C5 → E5 (ascending major third)
    stop: [587.33, 440],     // D5 → A4 (descending)
};
const CUE_NOTE_DURATION = 0.09;
const CUE_NOTE_GAP = 0.025;
const CUE_NOTE_ATTACK = 0.015;
const CUE_MAX_GAIN = 0.4;
const CUE_MIN_GAIN = 0.0001;

function DictateWaveform() {
    return (
        <div
            className="dictate-center-enter flex h-4 w-[52px] items-center justify-center gap-[3px]"
            role="img"
            aria-label="Recording dictation"
        >
            {WAVEFORM_BARS.map((height, index) => (
                <span
                    key={`${height}-${index}`}
                    className="dictate-waveform-bar w-[3px] rounded-full bg-current"
                    style={{
                        height,
                        animationDelay: `${index * -85}ms`,
                        animationDuration: `${620 + (index % 4) * 90}ms`,
                    }}
                />
            ))}
        </div>
    );
}

interface TopPillProps {
    onToggle: () => void;
    onQuit: () => void;
    appearance: OverlayAppearance;
    /** Whether a meeting (recording) is currently active. Drives the action
     *  button: mic (start) while idle, square/stop while recording. */
    meetingActive: boolean;
    /** Whether the overlay body is currently visible. Drives the center
     *  button label: "Ask" (overlay hidden) / "Hide" (overlay visible). */
    overlayVisible: boolean;
}

export default function TopPill({
    onToggle,
    onQuit,
    appearance,
    meetingActive,
    overlayVisible,
}: TopPillProps) {
    const [dictatePhase, setDictatePhase] = useState<DictateUiPhase>('idle');

    useEffect(() => subscribeToDictateUiPhase(setDictatePhase), []);

    useEffect(() => {
        if (!window.electronAPI?.onSystemDictateCue) return;
        return window.electronAPI.onSystemDictateCue((cue) => {
            try {
                const AudioContextCtor = window.AudioContext || (window as any).webkitAudioContext;
                const context = new AudioContextCtor();
                const baseTime = context.currentTime + 0.005;
                const notes = CUE_NOTES[cue] ?? CUE_NOTES.start;
                notes.forEach((frequency, index) => {
                    const startTime = baseTime + index * (CUE_NOTE_DURATION + CUE_NOTE_GAP);
                    const stopTime = startTime + CUE_NOTE_DURATION;
                    const oscillator = context.createOscillator();
                    const gain = context.createGain();
                    oscillator.type = 'sine';
                    oscillator.frequency.setValueAtTime(frequency, startTime);
                    gain.gain.setValueAtTime(CUE_MIN_GAIN, startTime);
                    gain.gain.linearRampToValueAtTime(CUE_MAX_GAIN, startTime + CUE_NOTE_ATTACK);
                    gain.gain.exponentialRampToValueAtTime(CUE_MIN_GAIN, stopTime);
                    oscillator.connect(gain).connect(context.destination);
                    oscillator.start(startTime);
                    oscillator.stop(stopTime + 0.01);
                    // Close the context once the LAST note finishes.
                    if (index === notes.length - 1) {
                        oscillator.addEventListener('ended', () => void context.close(), { once: true });
                    }
                });
            } catch {
                // Audio cues are optional; recording must never depend on them.
            }
        });
    }, []);

    const dictateActive = dictatePhase !== 'idle';
    const dictateCleaning = dictatePhase === 'cleaning';

    return (
        <div className="flex justify-center select-none z-50">
            <div
                className={`
          top-pill-shell
          ${dictateCleaning ? "top-pill-shell-cleaning" : ""}
          draggable-area
          flex items-center gap-2
          rounded-full
          border
          overlay-pill-surface
          backdrop-blur-md
          px-1.5 py-1.5
        `}
                style={appearance.pillStyle}
            >
                <span className="dictate-cleaning-orbit" aria-hidden="true" />
                <div className="draggable-area">
                    {/* LOGO BUTTON — toggles system-wide dictation (start when
                        idle, stop when recording). */}
                    <button
                        onClick={() => void window.electronAPI?.toggleSystemDictate?.().catch(() => {})}
                        disabled={dictateCleaning}
                        title={dictatePhase === 'recording' ? 'Stop dictation' : dictatePhase === 'cleaning' ? 'Cleaning' : 'Start dictation'}
                        aria-label={dictatePhase === 'recording' ? 'Stop dictation' : dictatePhase === 'cleaning' ? 'Cleaning dictation' : 'Start dictation'}
                        className={`top-pill-dictate-button
              w-7 h-7
              rounded-full
              overlay-icon-surface
              overlay-icon-surface-hover
              flex items-center justify-center
              relative overflow-hidden
              interaction-base interaction-press
            `}
                        style={appearance.iconStyle}
                    >
                        <VoiceBrandMarkIcon
                            size={18}
                            className={dictateCleaning ? "dictate-cleaning-logo overlay-text-primary" : "overlay-text-primary"}
                        />
                    </button>
                </div>

                {/* CENTER SEGMENT — Ask (overlay hidden) / Hide (overlay
                    visible). Clicking toggles the OVERLAY's visibility, not a
                    panel-body collapse: while a meeting runs, "Hide" hides the
                    overlay (meeting keeps recording) and "Ask" brings it back.
                    While showing "Ask", the chip is highlighted brand-blue
                    (#1592EA) with white glyphs; "Hide" restores the default
                    chip surface. */}
                <button
                    onClick={dictateActive ? undefined : onToggle}
                    aria-live="polite"
                    aria-label={
                        dictatePhase === 'recording'
                            ? 'Recording dictation'
                            : dictatePhase === 'cleaning'
                                ? 'Cleaning dictation'
                                : overlayVisible
                                    ? 'Hide Natively'
                                    : 'Show Natively'
                    }
                    className={`top-pill-center-segment
            flex items-center gap-2
            group
            ${dictateActive ? "px-2.5 py-1" : "px-3 py-1"}
            rounded-full
            backdrop-blur-md
            ${dictateActive
                ? "overlay-chip-ask text-white"
                : overlayVisible
                ? "overlay-chip-surface overlay-text-interactive"
                : "overlay-chip-ask text-white"}
            text-[12px]
            font-medium
            border
            interaction-base interaction-hover interaction-press
          `}
                    style={
                        dictateActive
                            ? { backgroundColor: "#1592EA", borderColor: "transparent", color: "#ffffff" }
                            : overlayVisible
                            ? appearance.chipStyle
                            : { backgroundColor: "#1592EA", borderColor: "transparent", color: "#ffffff" }
                    }
                >
                    {dictatePhase === 'recording' ? (
                        <DictateWaveform />
                    ) : dictatePhase === 'cleaning' ? (
                        <span className="sr-only">Cleaning</span>
                    ) : (
                        <span className="dictate-center-enter flex items-center gap-1">
                            <span
                                className={`transition-opacity duration-200 ${
                                    overlayVisible
                                        ? "opacity-70 group-hover:opacity-100"
                                        : "opacity-100"
                                }`}
                            >
                                {overlayVisible ? (
                                    <ChevronUp className="w-3.5 h-3.5" />
                                ) : (
                                    <ChevronDown className="w-3.5 h-3.5" />
                                )}
                            </span>
                            <span
                                className={`tracking-wide min-w-[30px] text-center ${
                                    overlayVisible
                                        ? "opacity-80 group-hover:opacity-100"
                                        : "opacity-100"
                                }`}
                            >
                                {overlayVisible ? "Hide" : "Ask"}
                            </span>
                        </span>
                    )}
                </button>

                {/* ACTION BUTTON — mic while idle (start a meeting/recording),
                    square/stop while a meeting is recording (end it). */}
                <button
                    onClick={dictateActive ? () => publishDictateUiPhase('idle') : onQuit}
                    title={dictateActive ? "Cancel dictation" : meetingActive ? "Stop" : "Start"}
                    aria-label={dictateActive ? "Cancel dictation" : meetingActive ? "Stop meeting" : "Start meeting"}
                    className={`top-pill-action-button
            w-7 h-7
            rounded-full
            overlay-icon-surface
            overlay-text-primary
            flex items-center justify-center
            interaction-base interaction-press
            hover:bg-red-500/10 hover:text-red-400
          `}
                    style={appearance.iconStyle}
                >
                    {dictateActive ? (
                        <X className="h-4 w-4" strokeWidth={2.25} />
                    ) : meetingActive ? (
                        <div className="w-3.5 h-3.5 rounded-[3px] bg-current opacity-80" />
                    ) : (
                        <Mic className="w-4 h-4" strokeWidth={2} />
                    )}
                </button>
            </div>
        </div>
    );
}
