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
} from 'lucide-react';
import { useT } from '../../i18n';
import type { CodexPluginApp } from '../../types/electron';

const bridgeMissing = 'Plugins IPC bridge not detected. Restart Natively after updating.';

export const PluginsSettings: React.FC = () => {
    const t = useT();
    const [plugins, setPlugins] = useState<CodexPluginApp[]>([]);
    const [query, setQuery] = useState('');
    const [page, setPage] = useState(0);
    const [loading, setLoading] = useState(false);
    const [signedIn, setSignedIn] = useState(true);
    const [catalogLimited, setCatalogLimited] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [updatingIds, setUpdatingIds] = useState<Set<string>>(new Set());

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
        const onFocus = () => void loadPlugins(true);
        const unsubscribeChanged = window.electronAPI?.onCodexPluginsChanged?.(() => {
            void loadPlugins(true);
        });
        window.addEventListener('focus', onFocus);
        return () => {
            window.removeEventListener('focus', onFocus);
            unsubscribeChanged?.();
        };
    }, [loadPlugins]);

    const visiblePlugins = useMemo(() => {
        const needle = query.trim().toLowerCase();
        return plugins
            .filter(plugin => !needle
                || plugin.name.toLowerCase().includes(needle)
                || plugin.id.toLowerCase().includes(needle)
                || (plugin.description || '').toLowerCase().includes(needle))
            .sort((a, b) => Number(b.callable) - Number(a.callable)
                || Number(b.isAccessible) - Number(a.isAccessible)
                || a.name.localeCompare(b.name));
    }, [plugins, query]);
    const connectedCount = useMemo(() => plugins.filter(plugin => plugin.callable).length, [plugins]);
    const pageSize = 100;
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
        <div className="space-y-5 animated fadeIn select-text pb-4">
            <div className="flex items-start justify-between gap-4">
                <div>
                    <h3 className="text-lg font-bold text-text-primary mb-1">{t('Plugins')}</h3>
                    <p className="text-xs text-text-secondary leading-relaxed max-w-xl">
                        {t('Connect Codex apps, control which ones can be used, then type @ in chat to choose a connected plugin.')}
                    </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                    {plugins.length > 0 && (
                        <span className="text-[11px] text-text-tertiary tabular-nums">
                            {plugins.length.toLocaleString()} {t('plugins')} · {connectedCount.toLocaleString()} {t('connected')}
                        </span>
                    )}
                    <button
                        onClick={() => void loadPlugins(true)}
                        disabled={loading}
                        className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-border-subtle bg-bg-input hover:bg-bg-elevated text-xs font-medium text-text-secondary hover:text-text-primary transition-colors disabled:opacity-50"
                    >
                        <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
                        {t('Refresh')}
                    </button>
                </div>
            </div>

            <div className="rounded-xl border border-amber-500/20 bg-amber-500/10 px-3.5 py-3 flex items-start gap-2.5">
                <Plug size={15} className="text-amber-400 mt-0.5 shrink-0" />
                <div className="text-xs text-text-secondary leading-relaxed">
                    <span className="font-semibold text-text-primary">{t('How to use:')}</span>{' '}
                    {t('type')} <span className="font-mono text-amber-400">@</span> {t('at the beginning of a chat message, select a connected plugin, then write your request.')}
                </div>
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

            <div className="relative">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary" />
                <input
                    value={query}
                    onChange={event => {
                        setQuery(event.target.value);
                        setPage(0);
                    }}
                    placeholder={t('Search plugins')}
                    className="w-full rounded-lg border border-border-subtle bg-bg-input py-2 pl-9 pr-3 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-border-muted"
                />
            </div>

            <div className="space-y-2">
                {loading && plugins.length === 0 && (
                    <div className="flex items-center justify-center gap-2 py-10 text-xs text-text-tertiary">
                        <Loader2 size={15} className="animate-spin" /> {t('Loading plugins…')}
                    </div>
                )}

                {!loading && !error && visiblePlugins.length === 0 && (
                    <div className="rounded-xl border border-dashed border-border-subtle py-10 text-center text-xs text-text-tertiary">
                        {query ? t('No plugins match your search.') : t('No plugins are available for this ChatGPT account.')}
                    </div>
                )}

                {displayedPlugins.map(plugin => {
                    const updating = updatingIds.has(plugin.id);
                    const status = plugin.callable
                        ? 'Connected'
                        : plugin.isAccessible
                            ? 'Available'
                            : 'Not connected';
                    return (
                        <div key={plugin.id} className="rounded-xl border border-border-subtle bg-bg-card px-3.5 py-3 hover:border-border-muted transition-colors">
                            <div className="flex items-start gap-3">
                                <div className="w-9 h-9 rounded-lg bg-bg-input border border-border-subtle flex items-center justify-center shrink-0 text-text-secondary">
                                    <Plug size={16} />
                                </div>
                                <div className="min-w-0 flex-1">
                                    <div className="flex items-center gap-2 flex-wrap">
                                        <span className="text-sm font-semibold text-text-primary truncate">{plugin.name}</span>
                                        <span className="text-[10px] font-mono text-text-tertiary">@{plugin.id}</span>
                                        <span className={`inline-flex items-center gap-1 text-[10px] font-medium ${plugin.callable ? 'text-emerald-400' : 'text-text-tertiary'}`}>
                                            {plugin.callable && <CheckCircle2 size={11} />}
                                            {t(status)}
                                        </span>
                                    </div>
                                    {plugin.description && (
                                        <p className="mt-1 text-xs text-text-secondary leading-relaxed line-clamp-2">{plugin.description}</p>
                                    )}
                                </div>
                                <div className="flex items-center gap-2 shrink-0">
                                    {!plugin.callable && plugin.isAccessible && (plugin.installUrl || plugin.marketplaceName) && (
                                        <button
                                            onClick={() => void connectPlugin(plugin)}
                                            disabled={updating}
                                            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-legacy-action-bg hover:bg-legacy-action-hover text-legacy-action-fg text-[11px] font-semibold transition-colors disabled:opacity-50"
                                        >
                                            <ExternalLink size={12} /> {t('Connect')}
                                        </button>
                                    )}
                                    {plugin.canToggle && (
                                        <button
                                            role="switch"
                                            aria-checked={plugin.isEnabled}
                                            aria-label={`${plugin.isEnabled ? 'Disable' : 'Enable'} ${plugin.name}`}
                                            onClick={() => void togglePlugin(plugin)}
                                            disabled={updating}
                                            className={`relative w-9 h-5 rounded-full transition-colors disabled:opacity-50 ${plugin.isEnabled ? 'bg-emerald-500' : 'bg-bg-input border border-border-muted'}`}
                                        >
                                            <span className={`absolute left-0.5 top-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform ${plugin.isEnabled ? 'translate-x-4' : 'translate-x-0'}`} />
                                        </button>
                                    )}
                                </div>
                            </div>
                        </div>
                    );
                })}

                {visiblePlugins.length > pageSize && (
                    <div className="flex items-center justify-between gap-3 py-2 text-[11px] text-text-tertiary">
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
