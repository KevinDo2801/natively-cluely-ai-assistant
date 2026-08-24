import { ChevronUp, ChevronDown, Mic } from "lucide-react";
import icon from "../icon.png";
import type { OverlayAppearance } from "../../lib/overlayAppearance";

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
                        <img
                            src={icon}
                            alt="Natively"
                            className="w-[24px] h-[24px] object-contain opacity-95 scale-105 force-black-icon"
                            draggable="false"
                            onDragStart={(e) => e.preventDefault()}
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
                    onClick={onToggle}
                    className={`
            flex items-center gap-2
            group
            px-3 py-1
            rounded-full
            backdrop-blur-md
            ${overlayVisible
                ? "overlay-chip-surface overlay-text-interactive"
                : "overlay-chip-ask text-white"}
            text-[12px]
            font-medium
            border
            interaction-base interaction-hover interaction-press
          `}
                    style={
                        overlayVisible
                            ? appearance.chipStyle
                            : { backgroundColor: "#1592EA", borderColor: "transparent", color: "#ffffff" }
                    }
                >
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
                </button>

                {/* ACTION BUTTON — mic while idle (start a meeting/recording),
                    square/stop while a meeting is recording (end it). */}
                <button
                    onClick={onQuit}
                    title={meetingActive ? "Stop" : "Start"}
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
                    {meetingActive ? (
                        <div className="w-3.5 h-3.5 rounded-[3px] bg-current opacity-80" />
                    ) : (
                        <Mic className="w-4 h-4" strokeWidth={2} />
                    )}
                </button>
            </div>
        </div>
    );
}
