import React from 'react';
import { useT } from '../../i18n';
import { useResolvedTheme } from '../../hooks/useResolvedTheme';
import { ArrowRight, Video } from 'lucide-react';
import { formatTimeLabel, type CalendarMeeting } from './UpcomingCalendarCard';

interface CalendarEventDetailProps {
    event: CalendarMeeting;
    onBack?: () => void;
}

/**
 * Full-page view for a single calendar event — opened when the user clicks an
 * event on the Upcoming card. Mirrors the meeting-detail pattern: time + big
 * title, the event description (full, not clamped), a "People in this call"
 * section listing attendees (or an empty message), and an optional Join
 * button when the event carries a meeting link. Theme-aware.
 */
const CalendarEventDetail: React.FC<CalendarEventDetailProps> = ({ event }) => {
    const t = useT();
    const isLight = useResolvedTheme() === 'light';

    const attendees = event.attendees || [];
    const openLink = (url?: string) => {
        if (url) window.electronAPI?.openExternal?.(url);
    };

    return (
        <div className="h-full w-full overflow-y-auto custom-scrollbar bg-bg-secondary">
            <div className="max-w-2xl mx-auto px-8 py-10">
                <div className="flex items-start justify-between gap-4">
                    <span className={`text-[13px] leading-4 tabular-nums ${isLight ? 'text-[#5f6368]' : 'text-sky-200/75'}`}>
                        {formatTimeLabel(event.startTime)}
                    </span>
                    {event.link && (
                        <button
                            type="button"
                            onClick={() => openLink(event.link)}
                            className={`inline-flex items-center gap-1.5 shrink-0 h-[26px] px-3 rounded-full text-[11.5px] font-semibold transition-colors duration-200 cursor-pointer ${
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

                <h1 className={`mt-2 text-[28px] leading-[1.15] font-semibold tracking-[-0.01em] ${isLight ? 'text-[#050505]' : 'text-white'}`}>
                    {event.title}
                </h1>

                {event.description && (
                    <p className={`mt-4 text-[14px] leading-[1.6] max-w-[600px] whitespace-pre-line ${isLight ? 'text-[#121212]' : 'text-white/60'}`}>
                        {event.description}
                    </p>
                )}

                {/* People in this call */}
                <h2 className={`mt-9 text-[15px] font-semibold ${isLight ? 'text-[#050505]' : 'text-white/90'}`}>
                    {t('People in this call')}
                </h2>

                {attendees.length > 0 ? (
                    <ul className="mt-3 flex flex-col gap-2">
                        {attendees.map((a, i) => {
                            const identity = (a.name || a.email || '').trim();
                            const src = identity;
                            const parts = src.split(/[\s._-]+/).filter(Boolean);
                            const initials = parts.length >= 2
                                ? (parts[0][0] + parts[1][0]).toUpperCase()
                                : src.slice(0, 2).toUpperCase();
                            const key = a.email ? `email:${a.email}` : `${identity || 'attendee'}:${i}`;
                            return (
                                <li key={key} className="flex items-center gap-3">
                                    <span className={`inline-flex items-center justify-center w-[26px] h-[26px] rounded-full text-[10px] font-bold ring-1 ${isLight ? 'bg-[#f0f1f3] text-[#5f6368] ring-black/[0.06]' : 'bg-white/[0.1] text-white/80 ring-white/[0.12]'}`}>
                                        {initials || '?'}
                                    </span>
                                    <div className="min-w-0">
                                        {a.name && (
                                            <div className={`text-[13px] font-medium truncate ${isLight ? 'text-[#050505]' : 'text-white/90'}`}>{a.name}</div>
                                        )}
                                        {a.email && (
                                            <div className={`text-[12px] truncate ${isLight ? 'text-[#6f6777]' : 'text-white/45'}`}>{a.email}</div>
                                        )}
                                    </div>
                                </li>
                            );
                        })}
                    </ul>
                ) : (
                    <p className={`mt-2 text-[13px] ${isLight ? 'text-[#6f6777]' : 'text-white/45'}`}>
                        {t('No attendees found.')}
                    </p>
                )}
            </div>
        </div>
    );
};

export default CalendarEventDetail;
