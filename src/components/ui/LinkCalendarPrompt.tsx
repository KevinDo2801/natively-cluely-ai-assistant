import React, { useState, useEffect } from 'react';
import { useT } from '../../i18n';
import { Loader } from 'lucide-react';
import { useResolvedTheme } from '../../hooks/useResolvedTheme';
// Static import keeps Vite from warning about a "mixed" dynamic+static import
// graph for analytics.service (see the note in Launcher.tsx / App.tsx).
import { analytics } from '../../lib/analytics/analytics.service';

/**
 * Single-line "Link your calendar to get notifications for upcoming meetings."
 * prompt shown under the Launcher header. Replaces the old hero banner grid
 * (FeatureSpotlight + UpcomingCalendarCard).
 *
 * - Hidden by default until the persisted calendar status resolves on mount,
 *   so connected users never see it flash.
 * - Clicking the link starts the Google connect flow directly (same
 *   `calendarConnect()` IPC the old hero card's Connect button used).
 * - Status is checked on mount only: if the user connects via Settings while
 *   the Launcher is already open, the line stays until the next launch
 *   (same mount-only behavior as the old ConnectCalendarButton).
 */
interface LinkCalendarPromptProps {
    /** Invoked once the Google connect flow succeeds (parent swaps in the Upcoming Calendar card). */
    onConnected?: () => void;
}

const LinkCalendarPrompt: React.FC<LinkCalendarPromptProps> = ({ onConnected }) => {
    const t = useT();
    const isLight = useResolvedTheme() === 'light';
    const [visible, setVisible] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let mounted = true;
        if (window.electronAPI?.getCalendarStatus) {
            window.electronAPI.getCalendarStatus()
                .then(status => { if (mounted && !status.connected) setVisible(true); })
                .catch(err => console.error('[LinkCalendarPrompt] Failed to check calendar status:', err));
        }
        return () => { mounted = false; };
    }, []);

    const handleConnect = async () => {
        if (loading || !window.electronAPI?.calendarConnect) return;
        setLoading(true);
        setError(null);
        try {
            const res = await window.electronAPI.calendarConnect();
            if (res.success) {
                analytics.trackCalendarConnected();
                setVisible(false);
                onConnected?.();
            } else if (res.error) {
                // Show the reason inline — calendarConnect can reject even after the
                // browser page said "Authentication successful" (the exchange runs
                // after that page is rendered).
                console.error('[LinkCalendarPrompt] Calendar connect failed:', res.error);
                setError(res.error);
            }
        } catch (err) {
            console.error('[LinkCalendarPrompt] Calendar connect failed:', err);
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setLoading(false);
        }
    };

    if (!visible) return null;

    return (
        <div className="flex flex-col gap-1">
            <p className="text-[14px] leading-snug">
                {loading ? (
                    <span className="inline-flex items-center gap-2 text-text-secondary">
                        <Loader size={13} className="animate-spin shrink-0" />
                        {t('Connecting...')}
                    </span>
                ) : (
                    <>
                        <button
                            type="button"
                            onClick={handleConnect}
                            className="font-medium hover:underline underline-offset-2 transition-colors cursor-pointer"
                            style={{ color: isLight ? '#0E8C9C' : '#5BC0CE' }}
                        >
                            {t('Link your calendar')}
                        </button>
                        <span className="text-text-secondary">
                            {' '}{t('to get notifications for upcoming meetings.')}
                        </span>
                    </>
                )}
            </p>
            {error && !loading && (
                <p className="text-[12px] text-red-400/90 leading-snug break-words max-w-[520px]">
                    {error}
                </p>
            )}
        </div>
    );
};

export default LinkCalendarPrompt;
