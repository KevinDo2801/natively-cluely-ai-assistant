import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
    AlertCircle,
    CheckCircle2,
    ChevronLeft,
    ChevronRight,
    ExternalLink,
    Loader2,
    Plug,
    RefreshCw,
    Search,
    Sparkles,
} from 'lucide-react';
import { useT } from '../../i18n';
import type { CodexPluginApp } from '../../types/electron';

const bridgeMissing = 'Plugins IPC bridge not detected. Restart Natively after updating.';
const pageSize = 48;
type PluginFilter = 'all' | 'connected' | 'available';

const safeLogoUrl = (logoUrl?: string) => {
    if (!logoUrl) return undefined;
    try {
        const url = new URL(logoUrl);
        return url.protocol === 'https:' || url.protocol === 'data:' ? logoUrl : undefined;
    } catch {
        return undefined;
    }
};

const PluginLogo: React.FC<{ plugin: CodexPluginApp }> = ({ plugin }) => {
    const [failed, setFailed] = useState(false);
    const logoUrl = safeLogoUrl(plugin.logoUrl);

    if (logoUrl && !failed) {
        return (
            <img
                src={logoUrl}
                alt=""
                loading="lazy"
                className="h-full w-full object-contain"
                onError={() => setFailed(true)}
            />
        );
    }

    const initials = plugin.name
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map(part => part[0]?.toUpperCase())
        .join('');

    return <span className="text-sm font-bold tracking-tight text-text-secondary">{initials || <Plug size={18} />}</span>;
};

export const PluginsSettings: React.FC = () => {
    const t = useT();
    const [plugins, setPlugins] = useState<CodexPluginApp[]>([]);
    const [query, setQuery] = useState('');
    const [filter, setFilter] = useState<PluginFilter>('all');
    const [page, setPage] = useState(0);
    const [loading, setLoading] = useState(false);
    const [signedIn, setSignedIn] = useState(true);
    const [catalogLimited, setCatalogLimited] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [updatingIds, setUpdatingIds] = useState<Set<string>>(new Set());
    // Settings → Plugins → "Approve plugin actions automatically". ON unless the
    // user turned it off: a confirm-only connector action is answered by the main
    // process instead of waiting for a click, and the chat model may also reach a
    // connector the user did not name. Actions that need user data still show the
    // confirmation card in the overlay.
    const [autoApprove, setAutoApprove] = useState(true);
    const [savingAutoApprove, setSavingAutoApprove] = useState(false);

    const loadAutoApprove = useCallback(async () => {
        if (typeof window.electronAPI?.getCodexAutoApprovePlugins !== 'function') return;
        try {
            const result = await window.electronAPI.getCodexAutoApprovePlugins();
            setAutoApprove(result?.enabled !== false);
        } catch { /* keep the optimistic default */ }
    }, []);

    const toggleAutoApprove = async () => {
        if (typeof window.electronAPI?.setCodexAutoApprovePlugins !== 'function') {
            setError(bridgeMissing);
            return;
        }
        const next = !autoApprove;
        setSavingAutoApprove(true);
        setError(null);
        setNotice(null);
        try {
            const result = await window.electronAPI.setCodexAutoApprovePlugins(next);
            if (!result?.success) throw new Error(result?.error || 'Could not update plugin approval.');
            setAutoApprove(result.enabled !== false);
        } catch (updateError: any) {
            setError(updateError?.message || 'Could not update plugin approval.');
        } finally {
            setSavingAutoApprove(false);
        }
    };

    const loadPlugins = useCallback(async (force = false) => {
        if (typeof window.electronAPI?.codexPluginsList !== 'function') {
            setError(bridgeMissing);
            setPlugins([]);
            return;
        }
        setLoading(true);
        setError(null);
        try {
            const result = await window.electronAPI.codexPluginsList(force);
            setSignedIn(result.signedIn !== false);
            setCatalogLimited(result.limited === true);
            if (!result.success) {
                setPlugins([]);
                setError(result.error || 'Could not load plugins.');
                return;
            }
            setPlugins(Array.isArray(result.apps) ? result.apps : []);
        } catch (loadError: any) {
            setPlugins([]);
            setError(loadError?.message || 'Could not load plugins.');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void loadPlugins(false);
        void loadAutoApprove();
        const onFocus = () => void loadPlugins(true);
        const unsubscribeChanged = window.electronAPI?.onCodexPluginsChanged?.(() => {
            void loadPlugins(true);
        });
        window.addEventListener('focus', onFocus);
        return () => {
            window.removeEventListener('focus', onFocus);
            unsubscribeChanged?.();
        };
    }, [loadPlugins, loadAutoApprove]);

    const visiblePlugins = useMemo(() => {
        const needle = query.trim().toLowerCase();
        return plugins
            .filter(plugin => {
                const matchesFilter = filter === 'all'
                    || (filter === 'connected' && plugin.callable)
                    || (filter === 'available' && !plugin.callable && plugin.isAccessible);
                const matchesQuery = !needle
                    || plugin.name.toLowerCase().includes(needle)
                    || plugin.id.toLowerCase().includes(needle)
                    || (plugin.description || '').toLowerCase().includes(needle);
                return matchesFilter && matchesQuery;
            })
            .sort((a, b) => Number(b.callable) - Number(a.callable)
                || Number(b.isAccessible) - Number(a.isAccessible)
                || a.name.localeCompare(b.name));
    }, [filter, plugins, query]);
    const connectedCount = useMemo(() => plugins.filter(plugin => plugin.callable).length, [plugins]);
    const availableCount = useMemo(
        () => plugins.filter(plugin => !plugin.callable && plugin.isAccessible).length,
        [plugins],
    );
    const pageCount = Math.max(1, Math.ceil(visiblePlugins.length / pageSize));
    const currentPage = Math.min(page, pageCount - 1);
    const displayedPlugins = visiblePlugins.slice(currentPage * pageSize, (currentPage + 1) * pageSize);

    const markUpdating = (id: string, active: boolean) => {
        setUpdatingIds(previous => {
            const next = new Set(previous);
            if (active) next.add(id);
            else next.delete(id);
            return next;
        });
    };

    const togglePlugin = async (plugin: CodexPluginApp) => {
        if (typeof window.electronAPI?.codexPluginSetEnabled !== 'function') {
            setError(bridgeMissing);
            return;
        }
        markUpdating(plugin.id, true);
        setError(null);
        setNotice(null);
        try {
            const result = await window.electronAPI.codexPluginSetEnabled(plugin.id, !plugin.isEnabled);
            if (!result.success) throw new Error(result.error || 'Could not update plugin.');
            await loadPlugins(true);
        } catch (updateError: any) {
            setError(updateError?.message || 'Could not update plugin.');
        } finally {
            markUpdating(plugin.id, false);
        }
    };

    const connectPlugin = async (plugin: CodexPluginApp) => {
        if (typeof window.electronAPI?.codexPluginConnect !== 'function') {
            setError(bridgeMissing);
            return;
        }
        markUpdating(plugin.id, true);
        setError(null);
        setNotice(null);
        try {
            const result = await window.electronAPI.codexPluginConnect(plugin.id);
            if (!result.success) throw new Error(result.error || 'Could not open plugin connection.');
            setNotice(`Finish connecting ${plugin.name} in the browser, then return here and select Refresh.`);
        } catch (connectError: any) {
            setError(connectError?.message || 'Could not connect plugin.');
        } finally {
            markUpdating(plugin.id, false);
        }
    };

    return (
        <div className="space-y-4 animated fadeIn select-text pb-5">
            <section className="relative overflow-hidden rounded-2xl border border-border-subtle bg-bg-card px-5 py-5">
                <div className="pointer-events-none absolute -right-16 -top-20 h-52 w-52 rounded-full bg-legacy-action-bg/10 blur-3xl" />
                <div className="relative flex items-start justify-between gap-5">
                    <div className="flex min-w-0 items-start gap-3.5">
                        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-legacy-action-border bg-legacy-action-subtle text-legacy-action-bg shadow-sm">
                            <Sparkles size={18} />
                        </div>
                        <div>
                            <h3 className="text-lg font-bold text-text-primary">{t('Plugins')}</h3>
                            <p className="mt-1 max-w-xl text-xs leading-relaxed text-text-secondary">
                                {t('Connect Codex apps, control which ones can be used, then type @ in chat to choose a connected plugin.')}
                            </p>
                        </div>
                    </div>
                    <button
                        onClick={() => void loadPlugins(true)}
                        disabled={loading}
                        className="flex shrink-0 items-center gap-2 rounded-lg border border-border-subtle bg-bg-input px-3 py-2 text-xs font-semibold text-text-secondary transition hover:border-border-muted hover:bg-bg-elevated hover:text-text-primary disabled:opacity-50"
                    >
                        <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
                        {t('Refresh')}
                    </button>
                </div>
                {plugins.length > 0 && (
                    <div className="relative mt-5 grid grid-cols-3 gap-2">
                        {[
                            [plugins.length, 'All plugins'],
                            [connectedCount, 'Connected'],
                            [availableCount, 'Ready to connect'],
                        ].map(([value, label]) => (
                            <div key={String(label)} className="rounded-xl border border-border-subtle bg-bg-input/60 px-3 py-2.5">
                                <div className="text-base font-bold tabular-nums text-text-primary">{Number(value).toLocaleString()}</div>
                                <div className="mt-0.5 text-[10px] font-medium uppercase tracking-wide text-text-tertiary">{t(String(label))}</div>
                            </div>
                        ))}
                    </div>
                )}
            </section>

            <div className="flex items-start gap-2.5 rounded-xl border border-blue-500/20 bg-blue-500/10 px-3.5 py-3">
                <Plug size={15} className="mt-0.5 shrink-0 text-blue-400" />
                <div className="text-xs leading-relaxed text-text-secondary">
                    <span className="font-semibold text-text-primary">{t('How to use:')}</span>{' '}
                    {t('type')} <span className="rounded bg-blue-500/15 px-1.5 py-0.5 font-mono font-semibold text-blue-400">@</span> {t('at the beginning of a chat message, select a connected plugin, then write your request.')}
                </div>
            </div>

            {/* Auto-approval. The switch owns a persisted setting read by the main
                process (SettingsManager.codexAutoApprovePlugins); it does NOT gate
                the plugin list above, so flipping it never reloads the catalog. */}
            <div className="flex items-start justify-between gap-4 rounded-xl border border-border-subtle bg-bg-card px-3.5 py-3">
                <div className="min-w-0">
                    <div className="flex items-center gap-2 text-xs font-semibold text-text-primary">
                        <CheckCircle2 size={14} className="shrink-0 text-emerald-400" />
                        {t('Approve plugin actions automatically')}
                    </div>
                    <p className="mt-1 text-[11px] leading-relaxed text-text-secondary">
                        {t('Natively confirms connector actions for you instead of asking on every write, and the chat may use a connected plugin even when you do not name it. Requests that need information from you — like a title, a time, or a secret — still ask.')}
                    </p>
                </div>
                <button
                    role="switch"
                    aria-checked={autoApprove}
                    aria-label={t('Approve plugin actions automatically')}
                    onClick={() => void toggleAutoApprove()}
                    disabled={savingAutoApprove}
                    className={`relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-50 ${autoApprove ? 'bg-emerald-500' : 'border border-border-muted bg-bg-input'}`}
                >
                    <span className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${autoApprove ? 'translate-x-4' : 'translate-x-0'}`} />
                </button>
            </div>

            {!signedIn && (
                <div className="rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2.5 flex items-start gap-2 text-xs text-amber-300">
                    <AlertCircle size={14} className="mt-0.5 shrink-0" />
                    <span>{t('Sign in with ChatGPT under AI Providers before loading plugins.')}</span>
                </div>
            )}

            {notice && (
                <div className="rounded-lg border border-blue-500/20 bg-blue-500/10 px-3 py-2.5 text-xs text-blue-300">
                    {t(notice)}
                </div>
            )}

            {catalogLimited && (
                <div className="rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2.5 flex items-start gap-2 text-xs text-amber-300">
                    <AlertCircle size={14} className="mt-0.5 shrink-0" />
                    <span>{t('The full ChatGPT plugin directory is temporarily unavailable. Showing your connected Codex plugins while Natively retries the full catalog automatically.')}</span>
                </div>
            )}

            {error && (
                <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2.5 text-xs text-red-400">
                    {t(error)}
                </div>
            )}

            <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center">
                <div className="relative min-w-0 flex-1">
                    <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary" />
                    <input
                        value={query}
                        onChange={event => {
                            setQuery(event.target.value);
                            setPage(0);
                        }}
                        placeholder={t('Search by name or capability…')}
                        className="w-full rounded-xl border border-border-subtle bg-bg-input py-2.5 pl-9 pr-3 text-sm text-text-primary placeholder:text-text-tertiary transition focus:border-legacy-action-border focus:outline-none focus:ring-2 focus:ring-legacy-action-subtle"
                    />
                </div>
                <div className="flex shrink-0 items-center rounded-xl border border-border-subtle bg-bg-input p-1">
                    {([
                        ['all', 'All'],
                        ['connected', 'Connected'],
                        ['available', 'Available'],
                    ] as const).map(([value, label]) => (
                        <button
                            key={value}
                            onClick={() => {
                                setFilter(value);
                                setPage(0);
                            }}
                            className={`rounded-lg px-3 py-1.5 text-[11px] font-semibold transition ${filter === value
                                ? 'bg-bg-card text-text-primary shadow-sm'
                                : 'text-text-tertiary hover:text-text-secondary'}`}
                        >
                            {t(label)}
                        </button>
                    ))}
                </div>
            </div>

            <div>
                {loading && plugins.length === 0 && (
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        {Array.from({ length: 6 }).map((_, index) => (
                            <div key={index} className="h-36 animate-pulse rounded-2xl border border-border-subtle bg-bg-card" />
                        ))}
                    </div>
                )}

                {!loading && !error && visiblePlugins.length === 0 && (
                    <div className="rounded-xl border border-dashed border-border-subtle py-10 text-center text-xs text-text-tertiary">
                        {query ? t('No plugins match your search.') : t('No plugins are available for this ChatGPT account.')}
                    </div>
                )}

                {displayedPlugins.length > 0 && (
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        {displayedPlugins.map(plugin => {
                            const updating = updatingIds.has(plugin.id);
                            return (
                                <article
                                    key={plugin.id}
                                    className="group flex min-h-36 flex-col rounded-2xl border border-border-subtle bg-bg-card p-4 transition duration-200 hover:-translate-y-0.5 hover:border-border-muted hover:shadow-lg hover:shadow-black/5"
                                >
                                    <div className="flex min-w-0 items-start gap-3">
                                        <div className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-border-subtle bg-white p-1.5 shadow-sm">
                                            <PluginLogo plugin={plugin} />
                                        </div>
                                        <div className="min-w-0 flex-1 pt-0.5">
                                            <div className="flex items-center gap-2">
                                                <h4 className="truncate text-sm font-semibold text-text-primary" title={plugin.name}>{plugin.name}</h4>
                                                {plugin.callable && (
                                                    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-400">
                                                        <CheckCircle2 size={10} /> {t('Connected')}
                                                    </span>
                                                )}
                                            </div>
                                            <p className="mt-0.5 truncate text-[10px] font-medium text-text-tertiary" title={`@${plugin.id}`}>
                                                @{plugin.id}
                                            </p>
                                        </div>
                                    </div>

                                    <p className="mt-3 line-clamp-2 flex-1 text-xs leading-relaxed text-text-secondary">
                                        {plugin.description || t('Use this app with Codex inside Natively.')}
                                    </p>

                                    <div className="mt-3 flex min-h-8 items-center justify-between gap-3 border-t border-border-subtle pt-3">
                                        <span className={`text-[10px] font-semibold ${plugin.callable
                                            ? 'text-emerald-400'
                                            : plugin.isAccessible
                                                ? 'text-text-secondary'
                                                : 'text-text-tertiary'}`}
                                        >
                                            {t(plugin.callable ? 'Ready to use' : plugin.isAccessible ? 'Available to connect' : 'Unavailable')}
                                        </span>
                                        <div className="flex shrink-0 items-center gap-2">
                                            {!plugin.callable && plugin.isAccessible && (plugin.installUrl || plugin.marketplaceName) && (
                                                <button
                                                    onClick={() => void connectPlugin(plugin)}
                                                    disabled={updating}
                                                    className="flex items-center gap-1.5 rounded-lg bg-legacy-action-bg px-3 py-1.5 text-[11px] font-semibold text-legacy-action-fg transition hover:bg-legacy-action-hover disabled:opacity-50"
                                                >
                                                    {updating ? <Loader2 size={12} className="animate-spin" /> : <ExternalLink size={12} />}
                                                    {t('Connect')}
                                                </button>
                                            )}
                                            {plugin.canToggle && (
                                                <button
                                                    role="switch"
                                                    aria-checked={plugin.isEnabled}
                                                    aria-label={`${plugin.isEnabled ? 'Disable' : 'Enable'} ${plugin.name}`}
                                                    onClick={() => void togglePlugin(plugin)}
                                                    disabled={updating}
                                                    className={`relative h-5 w-9 rounded-full transition-colors disabled:opacity-50 ${plugin.isEnabled ? 'bg-emerald-500' : 'border border-border-muted bg-bg-input'}`}
                                                >
                                                    <span className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${plugin.isEnabled ? 'translate-x-4' : 'translate-x-0'}`} />
                                                </button>
                                            )}
                                        </div>
                                    </div>
                                </article>
                            );
                        })}
                    </div>
                )}

                {visiblePlugins.length > pageSize && (
                    <div className="mt-4 flex items-center justify-between gap-3 rounded-xl border border-border-subtle bg-bg-card px-3 py-2 text-[11px] text-text-tertiary">
                        <span>
                            {t('Showing')} {currentPage * pageSize + 1}–{Math.min((currentPage + 1) * pageSize, visiblePlugins.length)} {t('of')} {visiblePlugins.length}
                        </span>
                        <div className="flex items-center gap-1.5">
                            <button
                                onClick={() => setPage(value => Math.max(0, value - 1))}
                                disabled={currentPage === 0}
                                className="p-1.5 rounded-md border border-border-subtle hover:bg-bg-elevated disabled:opacity-40"
                                aria-label={t('Previous page')}
                            >
                                <ChevronLeft size={13} />
                            </button>
                            <span className="min-w-14 text-center">{currentPage + 1} / {pageCount}</span>
                            <button
                                onClick={() => setPage(value => Math.min(pageCount - 1, value + 1))}
                                disabled={currentPage >= pageCount - 1}
                                className="p-1.5 rounded-md border border-border-subtle hover:bg-bg-elevated disabled:opacity-40"
                                aria-label={t('Next page')}
                            >
                                <ChevronRight size={13} />
                            </button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};
