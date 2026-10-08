import { useEffect, useState } from "react";
import { ChevronUp, ChevronDown, LoaderCircle, Mic, X } from "lucide-react";
import type { OverlayAppearance } from "../../lib/overlayAppearance";
import {
    publishDictateUiPhase,
    subscribeToDictateUiPhase,
    type DictateUiPhase,
} from "../../lib/dictateUi";
import { VoiceBrandMarkIcon } from "./VoiceBrandMarkIcon";

const WAVEFORM_BARS = [8, 14, 20, 11, 17, 23, 13, 19, 9];

function DictateWaveform() {
    return (
        <div
            className="flex h-7 w-[76px] items-center justify-center gap-[3px]"
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
    onLogoClick?: () => void;
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
    onLogoClick,
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
                const oscillator = context.createOscillator();
                const gain = context.createGain();
                oscillator.type = 'sine';
                oscillator.frequency.value = cue === 'start' ? 720 : 520;
                gain.gain.setValueAtTime(0.0001, context.currentTime);
                gain.gain.exponentialRampToValueAtTime(0.055, context.currentTime + 0.01);
                gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.11);
                oscillator.connect(gain).connect(context.destination);
                oscillator.start();
                oscillator.stop(context.currentTime + 0.12);
                oscillator.addEventListener('ended', () => void context.close(), { once: true });
            } catch {
                // Audio cues are optional; recording must never depend on them.
            }
        });
    }, []);

    const dictateActive = dictatePhase !== 'idle';

    return (
        <div className="flex justify-center select-none z-50">
            <div
                className="
          draggable-area
          flex items-center gap-2
          rounded-full
          border
          overlay-pill-surface
          backdrop-blur-md
          px-1.5 py-1.5
          transition-all duration-300 ease-sculpted
        "
                style={appearance.pillStyle}
            >
                <div className="draggable-area">
                    {/* LOGO BUTTON */}
                    <button
                        onClick={onLogoClick}
                        aria-label="Open Natively menu"
                        className={`
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
                            className="overlay-text-primary"
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
                    className={`
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
                        <span className="flex h-7 min-w-[76px] items-center justify-center gap-2 px-1 text-[11px] font-semibold tracking-wide">
                            <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                            Cleaning…
                        </span>
                    ) : (
                        <>
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
                                className={`tracking-wide ${
                                    overlayVisible
                                        ? "opacity-80 group-hover:opacity-100"
                                        : "opacity-100"
                                }`}
                            >
                                {overlayVisible ? "Hide" : "Ask"}
                            </span>
                        </>
                    )}
                </button>

                {/* ACTION BUTTON — mic while idle (start a meeting/recording),
                    square/stop while a meeting is recording (end it). */}
                <button
                    onClick={dictateActive ? () => publishDictateUiPhase('idle') : onQuit}
                    title={dictateActive ? "Cancel dictation" : meetingActive ? "Stop" : "Start"}
                    aria-label={dictateActive ? "Cancel dictation" : meetingActive ? "Stop meeting" : "Start meeting"}
                    className={`
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
