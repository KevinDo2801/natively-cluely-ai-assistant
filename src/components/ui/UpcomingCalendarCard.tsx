import React from 'react';
import { useT } from '../../i18n';
import { useResolvedTheme } from '../../hooks/useResolvedTheme';
import { ArrowRight, Video } from 'lucide-react';
import ConnectCalendarButton from './ConnectCalendarButton';

export interface CalendarAttendee {
    email: string;
    name?: string;
}

export interface CalendarMeeting {
    id: string;
    title: string;
    startTime: string;
    endTime?: string;
    description?: string;
    link?: string;
    attendees?: CalendarAttendee[];
}

interface UpcomingCalendarCardProps {
    /** Whether the user has already linked a calendar. */
    isConnected: boolean;
    /** Called once the connect flow succeeds (or to optimistically flip state). */
    onConnect?: () => void;
    /**
     * Upcoming meetings, soonest-first. The first meeting becomes the hero on
     * the left; the next up to 3 render as compact rows in the right column.
     */
    meetings?: CalendarMeeting[];
    /** Total upcoming meeting count (may exceed meetings.length) — drives the "+N more" hint. Defaults to meetings.length. */
    totalCount?: number;
    /** Called when the user clicks an event (hero or a side row) to open its detail page. */
    onSelectEvent?: (event: CalendarMeeting) => void;
    className?: string;
}

const formatTimeLabel = (startTime: string) => {
    const start = new Date(startTime);
    const now = new Date();
    const tomorrow = new Date(now.getTime() + 86400000);
    const isToday = start.toDateString() === now.toDateString();
    const isTomorrow = start.toDateString() === tomorrow.toDateString();
    const time = start.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return isToday ? `Today at ${time}`
        : isTomorrow ? `Tomorrow at ${time}`
        : `${start.toLocaleDateString([], { weekday: 'short' })} at ${time}`;
};
export { formatTimeLabel };

// Subtle fractal-noise grain (same recipe the rest of the launcher uses).
const GRAIN_BG = "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/></filter><rect width='100%' height='100%' filter='url(%23n)' opacity='0.55'/></svg>\")";

/**
 * Launcher "Upcoming events" panel — a meeting-focused layout inspired by the
 * classic Calendar "now + next" card: the soonest meeting becomes the hero on
 * the left (accent bar, time, big title, optional Join button + description),
 * and the following meetings stack as compact rows on the right. Theme-aware
 * (light/dark via semantic tokens), props-driven, no Launcher state/hooks.
 */
const UpcomingCalendarCard: React.FC<UpcomingCalendarCardProps> = ({
    isConnected,
    onConnect,
    meetings = [],
    totalCount,
    onSelectEvent,
    className = '',
}) => {
    const t = useT();
    const isLight = useResolvedTheme() === 'light';

    const mainMeeting = meetings[0] ?? null;

    // Side column: up to 3 following events. When more exist beyond what was
    // passed in, keep room for the "+N more" hint row instead of a 3rd event.
    const sideAll = meetings.slice(1);
    const extraCount = Math.max(0, (totalCount ?? meetings.length) - meetings.length);
    const sideRows = extraCount > 0 ? sideAll.slice(0, 2) : sideAll.slice(0, 3);
    const hiddenCount = extraCount + Math.max(0, sideAll.length - sideRows.length);
    const hasSide = sideRows.length > 0 || hiddenCount > 0;

    const openLink = (url?: string) => {
        if (url) window.electronAPI?.openExternal?.(url);
    };

    return (
        <div className={`relative flex flex-col overflow-hidden rounded-xl h-full ${className}`}>
            {/* ── Ambient backdrop (no photo — flat canvas like the reference card) ── */}
            <div className="absolute inset-0 pointer-events-none" aria-hidden="true">
                {/* Base wash — semantic token bg-bg-secondary both themes
                    (light #F5F5F5 / dark #050505), no hardcoded hex */}
                <div className="absolute inset-0 bg-bg-secondary" />
                {/* Top hairline highlight (dark only) */}
                {!isLight && (
                    <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/10 to-transparent" />
                )}
                {/* Soft brand glows (dark only — light stays a clean flat canvas) */}
                {!isLight && (
                    <>
                        <div className="absolute -top-16 -left-16 w-56 h-56 rounded-full bg-[#9a5fa8]/[0.13] blur-[90px]" />
                        <div className="absolute -bottom-20 -right-10 w-64 h-56 rounded-full bg-sky-500/[0.07] blur-[90px]" />
                    </>
                )}
                {/* Grain (dark only) */}
                {!isLight && (
                    <div className="absolute inset-0 opacity-[0.035] mix-blend-overlay" style={{ backgroundImage: GRAIN_BG }} />
                )}
            </div>

            {isConnected ? (
                mainMeeting ? (
                    <div className="relative z-10 flex-1 flex min-h-0 px-4 py-3">
                        {/* ── LEFT: hero meeting ── */}
                        <div
                            className="relative flex-1 min-w-0 flex flex-col justify-center pl-[14px] cursor-pointer"
                            onClick={() => onSelectEvent?.(mainMeeting)}
                            role="button"
                            tabIndex={0}
                            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelectEvent?.(mainMeeting); } }}
                        >
                            {/* Accent timeline bar */}
                            <div
                                className={`absolute left-0 top-[6px] bottom-[6px] w-[3px] rounded-full bg-gradient-to-b ${
                                    isLight ? 'from-sky-400 to-sky-600' : 'from-sky-300/90 to-sky-500/25'
                                }`}
                            />

                            <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                    <span className={`block text-[11px] font-medium leading-4 tabular-nums ${isLight ? 'text-text-secondary' : 'text-sky-200/75'}`}>
                                        {formatTimeLabel(mainMeeting.startTime)}
                                    </span>
                                    <h3
                                        className={`mt-[3px] text-[18px] font-semibold leading-[22px] tracking-[-0.01em] truncate ${isLight ? 'text-text-primary' : 'text-white'}`}
                                        title={mainMeeting.title}
                                    >
                                        {mainMeeting.title}
                                    </h3>
                                </div>

                                {mainMeeting.link && (
                                    <button
                                        type="button"
                                        onClick={(e) => { e.stopPropagation(); openLink(mainMeeting.link); }}
                                        className={`inline-flex items-center gap-1.5 shrink-0 h-[26px] px-3 rounded-full text-[11.5px] font-semibold transition-colors duration-200 mt-0.5 cursor-pointer ${
                                            isLight
                                                ? 'bg-[#caecfc] text-[#0785cb] hover:bg-[#b6e2fa]'
                                                : 'bg-sky-400/15 text-sky-200 ring-1 ring-sky-300/20 hover:bg-sky-400/25'
                                        }`}
                                    >
                                        <Video size={12} strokeWidth={2.5} />
                                        <span>{t('Join meeting')}</span>
                                        <ArrowRight size={12} strokeWidth={2.5} />
                                    </button>
                                )}
                            </div>

                            {mainMeeting.description && (
                                <p className={`mt-2 text-[12.5px] leading-[17px] line-clamp-3 max-w-[560px] ${isLight ? 'text-text-secondary' : 'text-white/55'}`}>
                                    {mainMeeting.description}
                                </p>
                            )}
                        </div>

                        {/* ── RIGHT: following meetings ── */}
                        {hasSide && (
                            <aside
                                className={`w-[238px] shrink-0 border-l pl-4 flex flex-col justify-center min-h-0 gap-[7px] ${
                                    isLight ? 'border-black/[0.07]' : 'border-white/[0.08]'
                                }`}
                            >
                                {sideRows.map((m) => (
                                    <button
                                        key={m.id}
                                        type="button"
                                        onClick={() => (onSelectEvent ? onSelectEvent(m) : openLink(m.link))}
                                        title={m.title}
                                        className={`w-full text-left rounded-[11px] px-3 py-[7px] ring-1 transition-all duration-200 flex flex-col justify-center min-h-[46px] ${
                                            isLight
                                                ? 'bg-[linear-gradient(110deg,#ffffff_0%,#fbfdff_53%,#dff5ff_100%)] ring-black/[0.06] shadow-[0_1px_2px_rgba(0,0,0,0.04)] hover:ring-black/[0.13] hover:shadow-[0_4px_12px_-3px_rgba(0,0,0,0.10)]'
                                                : 'bg-white/[0.05] ring-white/[0.08] hover:bg-white/[0.1] hover:ring-white/[0.17]'
                                        } ${(onSelectEvent || m.link) ? 'cursor-pointer' : 'cursor-default'}`}
                                    >
                                        <span className={`text-[12.5px] font-semibold leading-[15px] truncate ${isLight ? 'text-text-primary' : 'text-white/90'}`}>
                                            {m.title}
                                        </span>
                                        <span className={`mt-[2px] text-[10.5px] leading-[13px] tabular-nums truncate ${isLight ? 'text-text-secondary' : 'text-white/40'}`}>
                                            {formatTimeLabel(m.startTime)}
                                        </span>
                                    </button>
                                ))}

                                {hiddenCount > 0 && (
                                    <div className={`text-[10.5px] font-semibold text-center leading-4 px-2 ${isLight ? 'text-text-tertiary' : 'text-white/35'}`}>
                                        +{hiddenCount} {t('more')}
                                    </div>
                                )}
                            </aside>
                        )}
                    </div>
                ) : (
                    <div className="relative z-10 flex-1 flex items-center justify-center">
                        <span className={`text-[13px] font-medium ${isLight ? 'text-text-secondary' : 'text-white/45'}`}>
                            {t('No upcoming events')}
                        </span>
                    </div>
                )
            ) : (
                <div className="relative z-10 flex-1 flex flex-col items-center justify-center gap-3 text-center px-6">
                    <h3 className="text-[17px] leading-tight tracking-[-0.01em]">
                        <span className="block font-semibold text-text-primary">{t('Link your calendar to')}</span>
                        <span className="mt-1 block font-medium text-text-secondary text-[0.95em]">{t('see upcoming events')}</span>
                    </h3>
                    <ConnectCalendarButton className="mt-1" onConnect={onConnect} />
                </div>
            )}
        </div>
    );
};

export default UpcomingCalendarCard;
