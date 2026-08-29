import React, { useCallback, useEffect, useState } from 'react';
import { useT } from '../../i18n';
import {
    AlertCircle,
    Check,
    Cloud,
    Eye,
    EyeOff,
    KeyRound,
    Loader2,
    LogIn,
    LogOut,
    Mail,
    RefreshCw,
    UserRound,
} from 'lucide-react';

type View = 'loading' | 'signedOut' | 'signedIn' | 'recovery';
type SignedOutMode = 'signin' | 'signup' | 'forgot';

interface Status {
    signedIn: boolean;
    email?: string;
    userId?: string;
}

interface SyncState {
    state: 'idle' | 'syncing' | 'ok' | 'error';
    lastSyncedAt?: number;
    lastCounts?: { rows: number; upserted: number; failed: number };
    lastError?: string;
}

interface Notice {
    tone: 'ok' | 'error' | 'info';
    text: string;
}

const inputClass =
    'w-full rounded-lg border border-border-subtle bg-bg-input px-3 py-2 text-xs text-text-primary transition-colors focus:outline-none focus:border-accent-primary';
const labelClass =
    'text-[10px] font-medium uppercase tracking-wide text-text-secondary';
const primaryBtnClass =
    'w-full inline-flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-semibold transition-colors bg-accent-primary text-on-accent hover:brightness-110 disabled:opacity-50';
const secondaryBtnClass =
    'w-full inline-flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-medium transition-colors text-text-secondary hover:text-text-primary hover:bg-bg-item-active/60 disabled:opacity-50';

export const AccountSettings: React.FC = () => {
    const t = useT();

    const [view, setView] = useState<View>('loading');
    const [mode, setMode] = useState<SignedOutMode>('signin');
    const [status, setStatus] = useState<Status>({ signedIn: false });

    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [confirm, setConfirm] = useState('');
    const [showPassword, setShowPassword] = useState(false);
    // "Change password" form stays collapsed until the user clicks the button.
    const [changePasswordOpen, setChangePasswordOpen] = useState(false);

    const [busy, setBusy] = useState(false);
    const [notice, setNotice] = useState<Notice | null>(null);

    // Cloud sync (local SQLite → Supabase) status, pushed by the main process.
    const [sync, setSync] = useState<SyncState>({ state: 'idle' });
    const [syncBusy, setSyncBusy] = useState(false);

    const applyStatus = useCallback((s: Status) => {
        setStatus(s);
        setView(s.signedIn ? 'signedIn' : 'signedOut');
    }, []);

    // Load status + subscribe to live auth events.
    useEffect(() => {
        let cancelled = false;
        const api = window.electronAPI;

        api?.authGetStatus?.()
            .then((res) => {
                if (cancelled) return;
                if (res?.success && res.signedIn) {
                    applyStatus({ signedIn: true, email: res.email, userId: res.userId });
                } else {
                    setView('signedOut');
                }
            })
            .catch(() => { if (!cancelled) setView('signedOut'); });

        const unsubChanged = api?.onAuthChanged?.((s) => {
            if (!cancelled) applyStatus(s || { signedIn: false });
        });
        const unsubRecovery = api?.onAuthRecovery?.((info) => {
            if (cancelled) return;
            // A password-reset link was completed: show the "set new password" form.
            setEmail(info?.email || '');
            setPassword('');
            setConfirm('');
            setNotice(null);
            setView('recovery');
        });
        const unsubError = api?.onAuthDeepLinkError?.((info) => {
            if (cancelled) return;
            setNotice({ tone: 'error', text: info?.message || t('The link was invalid or expired.') });
        });
        const unsubSync = api?.onSyncStatus?.((s) => {
            if (!cancelled && s) setSync(s);
        });
        api?.syncGetStatus?.()
            .then((s) => { if (!cancelled && s) setSync(s); })
            .catch(() => { /* status event will reconcile later */ });

        return () => {
            cancelled = true;
            unsubChanged?.();
            unsubRecovery?.();
            unsubError?.();
            unsubSync?.();
        };
    }, [applyStatus, t]);

    const clearNotice = () => setNotice(null);

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        clearNotice();
        const api = window.electronAPI;
        if (!api) return;

        if (!email.trim()) {
            setNotice({ tone: 'error', text: t('Enter your email address.') });
            return;
        }
        if (mode === 'forgot') {
            setBusy(true);
            const res = await api.authResetPassword?.(email.trim());
            setBusy(false);
            if (res?.success) {
                setNotice({ tone: 'info', text: t('If that address is registered, a reset link is on its way. Check your email.') });
                setMode('signin');
            } else {
                setNotice({ tone: 'error', text: res?.error || t('Could not send the reset link.') });
            }
            return;
        }

        if (password.length < 6) {
            setNotice({ tone: 'error', text: t('Password must be at least 6 characters.') });
            return;
        }
        if (mode === 'signup' && password !== confirm) {
            setNotice({ tone: 'error', text: t('Passwords do not match.') });
            return;
        }

        setBusy(true);
        const res = mode === 'signup'
            ? await api.authSignUp?.(email.trim(), password)
            : await api.authSignIn?.(email.trim(), password);
        setBusy(false);

        if (res?.success) {
            const needsEmailConfirmation =
                res && 'needsEmailConfirmation' in res ? res.needsEmailConfirmation : false;
            if (needsEmailConfirmation) {
                setNotice({ tone: 'info', text: t('Account created! We sent a confirmation email — click the link, then sign in.') });
                setPassword('');
                setConfirm('');
                setMode('signin');
            } else {
                applyStatus({ signedIn: true, email: res.email || email.trim() });
                setPassword('');
                setConfirm('');
                setChangePasswordOpen(false);
            }
        } else {
            setNotice({ tone: 'error', text: res?.error || t('Authentication failed.') });
        }
    };

    const changePassword = async (e: React.FormEvent) => {
        e.preventDefault();
        clearNotice();
        if (password.length < 6) {
            setNotice({ tone: 'error', text: t('Password must be at least 6 characters.') });
            return;
        }
        if (password !== confirm) {
            setNotice({ tone: 'error', text: t('Passwords do not match.') });
            return;
        }
        setBusy(true);
        const res = await window.electronAPI?.authChangePassword?.(password);
        setBusy(false);
        if (res?.success) {
            setNotice({ tone: 'ok', text: t('Password updated.') });
            setPassword('');
            setConfirm('');
            setChangePasswordOpen(false);
            if (view === 'recovery') {
                applyStatus({ signedIn: true, email: status.email || email });
            }
        } else {
            setNotice({ tone: 'error', text: res?.error || t('Could not update the password.') });
        }
    };

    const signOut = async () => {
        clearNotice();
        setBusy(true);
        const res = await window.electronAPI?.authSignOut?.();
        setBusy(false);
        setEmail('');
        setPassword('');
        setConfirm('');
        setMode('signin');
        setChangePasswordOpen(false);
        if (res?.success) {
            applyStatus({ signedIn: false });
        } else {
            setNotice({ tone: 'error', text: res?.error || t('Sign out failed.') });
        }
    };

    const switchMode = (next: SignedOutMode) => {
        setMode(next);
        setPassword('');
        setConfirm('');
        clearNotice();
    };

    const requestSync = async () => {
        if (syncBusy || sync.state === 'syncing') return;
        setSyncBusy(true);
        try {
            const s = await window.electronAPI?.syncNow?.();
            if (s) setSync(s);
        } catch {
            /* the sync:status event carries the error state */
        } finally {
            setSyncBusy(false);
        }
    };

    const syncStatusLine = (() => {
        if (sync.state === 'syncing') return t('Pushing your local data to the cloud…');
        if (sync.state === 'error') {
            return `${t('Sync failed')}: ${sync.lastError || t('unknown error')}`;
        }
        if (sync.state === 'ok' && sync.lastSyncedAt) {
            const time = new Date(sync.lastSyncedAt).toLocaleTimeString();
            const counts = sync.lastCounts ? ` — ${sync.lastCounts.rows} ${t('rows synced')}` : '';
            return `${t('Last synced')} ${time}${counts}`;
        }
        return t('Not synced yet — your local data is pushed to your account automatically.');
    })();

    const noticeTone = (tone: Notice['tone']) =>
        tone === 'ok'
            ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-300'
            : tone === 'error'
                ? 'border-red-500/30 bg-red-500/10 text-red-300'
                : 'border-accent-border bg-accent-subtle text-text-secondary';

    return (
        <div className="space-y-6 animated fadeIn">
            <div className="space-y-3.5">
                <div data-settings-stagger>
                    <h3 className="text-lg font-bold text-text-primary mb-1">{t('Account')}</h3>
                    <p className="text-xs text-text-secondary mb-2">{t('Sign in to sync your Natively account.')}</p>

                    {view === 'loading' && (
                        <div className="rounded-xl border border-border-subtle bg-bg-card p-10 flex items-center justify-center">
                            <Loader2 size={18} className="animate-spin text-text-tertiary" />
                        </div>
                    )}

                    {view === 'signedOut' && (
                        <div className="rounded-xl border border-border-subtle bg-bg-card">
                            <div className="p-5">
                                {/* Mode tabs */}
                                <div className="grid grid-cols-2 gap-1 p-1 rounded-lg bg-bg-item-surface border border-border-subtle mb-4">
                                    <button
                                        type="button"
                                        onClick={() => switchMode('signin')}
                                        className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${mode === 'signin' ? 'bg-accent-primary text-on-accent shadow-sm' : 'text-text-secondary hover:text-text-primary'}`}
                                    >
                                        {t('Sign in')}
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => switchMode('signup')}
                                        className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${mode === 'signup' ? 'bg-accent-primary text-on-accent shadow-sm' : 'text-text-secondary hover:text-text-primary'}`}
                                    >
                                        {t('Create account')}
                                    </button>
                                </div>

                                <form onSubmit={submit} className="space-y-3">
                                    {mode === 'forgot' ? (
                                        <div className="rounded-lg border border-border-subtle bg-bg-item-surface px-3 py-2 text-[11px] text-text-secondary">
                                            {t('Enter your email and we will send a reset link.')}
                                        </div>
                                    ) : (
                                        <label className="block space-y-1">
                                            <span className={labelClass}>{t('Email')}</span>
                                            <div className="relative">
                                                <Mail size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-tertiary" />
                                                <input
                                                    type="email"
                                                    value={email}
                                                    onChange={(e) => setEmail(e.target.value)}
                                                    autoComplete="email"
                                                    placeholder="you@example.com"
                                                    className={`${inputClass} pl-8`}
                                                />
                                            </div>
                                        </label>
                                    )}

                                    {mode !== 'forgot' && (
                                        <label className="block space-y-1">
                                            <span className={labelClass}>{t('Password')}</span>
                                            <div className="relative">
                                                <KeyRound size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-tertiary" />
                                                <input
                                                    type={showPassword ? 'text' : 'password'}
                                                    value={password}
                                                    onChange={(e) => setPassword(e.target.value)}
                                                    autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                                                    className={`${inputClass} pl-8 pr-9`}
                                                />
                                                <button
                                                    type="button"
                                                    onClick={() => setShowPassword((v) => !v)}
                                                    className="absolute right-2 top-1/2 -translate-y-1/2 text-text-tertiary hover:text-text-primary"
                                                    aria-label={showPassword ? t('Hide password') : t('Show password')}
                                                >
                                                    {showPassword ? <EyeOff size={13} /> : <Eye size={13} />}
                                                </button>
                                            </div>
                                        </label>
                                    )}

                                    {mode === 'signup' && (
                                        <label className="block space-y-1">
                                            <span className={labelClass}>{t('Confirm password')}</span>
                                            <input
                                                type={showPassword ? 'text' : 'password'}
                                                value={confirm}
                                                onChange={(e) => setConfirm(e.target.value)}
                                                autoComplete="new-password"
                                                className={inputClass}
                                            />
                                        </label>
                                    )}

                                    {notice && (
                                        <div className={`rounded-lg border px-3 py-2 text-[11px] flex items-start gap-2 ${noticeTone(notice.tone)}`}>
                                            {notice.tone === 'error' ? <AlertCircle size={13} className="shrink-0 mt-px" /> : notice.tone === 'ok' ? <Check size={13} className="shrink-0 mt-px" /> : <Mail size={13} className="shrink-0 mt-px" />}
                                            <span>{notice.text}</span>
                                        </div>
                                    )}

                                    <button type="submit" disabled={busy} className={primaryBtnClass}>
                                        {busy
                                            ? <Loader2 size={13} className="animate-spin" />
                                            : mode === 'forgot'
                                                ? <Mail size={13} />
                                                : <LogIn size={13} />}
                                        {busy
                                            ? t('Please wait…')
                                            : mode === 'forgot'
                                                ? t('Send reset link')
                                                : mode === 'signup'
                                                    ? t('Create account')
                                                    : t('Sign in')}
                                    </button>

                                    <button
                                        type="button"
                                        onClick={() => switchMode(mode === 'forgot' ? 'signin' : 'forgot')}
                                        className="w-full text-center text-[11px] text-accent-primary hover:underline"
                                    >
                                        {mode === 'forgot' ? t('Back to sign in') : t('Forgot password?')}
                                    </button>
                                </form>
                            </div>
                        </div>
                    )}

                    {view === 'recovery' && (
                        <div className="rounded-xl border border-border-subtle bg-bg-card">
                            <div className="p-5">
                                <div className="rounded-lg border border-emerald-500/25 bg-emerald-500/10 px-3 py-2 text-[11px] text-emerald-300 mb-4">
                                    {t('Email verified. Choose a new password to finish resetting.')}
                                </div>
                                <form onSubmit={changePassword} className="space-y-3">
                                    <label className="block space-y-1">
                                        <span className={labelClass}>{t('New password')}</span>
                                        <input
                                            type={showPassword ? 'text' : 'password'}
                                            value={password}
                                            onChange={(e) => setPassword(e.target.value)}
                                            autoComplete="new-password"
                                            className={inputClass}
                                        />
                                    </label>
                                    <label className="block space-y-1">
                                        <span className={labelClass}>{t('Confirm password')}</span>
                                        <input
                                            type={showPassword ? 'text' : 'password'}
                                            value={confirm}
                                            onChange={(e) => setConfirm(e.target.value)}
                                            autoComplete="new-password"
                                            className={inputClass}
                                        />
                                    </label>
                                    {notice && (
                                        <div className={`rounded-lg border px-3 py-2 text-[11px] flex items-start gap-2 ${noticeTone(notice.tone)}`}>
                                            {notice.tone === 'error' ? <AlertCircle size={13} className="shrink-0 mt-px" /> : <Check size={13} className="shrink-0 mt-px" />}
                                            <span>{notice.text}</span>
                                        </div>
                                    )}
                                    <button type="submit" disabled={busy} className={primaryBtnClass}>
                                        {busy ? <Loader2 size={13} className="animate-spin" /> : <KeyRound size={13} />}
                                        {busy ? t('Please wait…') : t('Save new password')}
                                    </button>
                                </form>
                            </div>
                        </div>
                    )}

                    {view === 'signedIn' && (
                        <div className="rounded-xl border border-border-subtle bg-bg-card divide-y divide-border-subtle">
                            {/* Signed-in identity */}
                            <div className="p-5 flex items-center gap-3">
                                <div className="w-10 h-10 rounded-lg bg-accent-primary/15 border border-accent-border text-accent-primary flex items-center justify-center shrink-0">
                                    <UserRound size={18} />
                                </div>
                                <div className="min-w-0">
                                    <p className="text-sm font-semibold text-text-primary truncate">{status.email || t('Signed in')}</p>
                                    <p className="text-[11px] text-text-tertiary flex items-center gap-1">
                                        <Check size={11} className="text-emerald-400" /> {t('Connected')}
                                    </p>
                                </div>
                                <button
                                    onClick={signOut}
                                    disabled={busy}
                                    className="ml-auto inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[11px] font-medium text-text-secondary hover:text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-50"
                                >
                                    <LogOut size={13} /> {t('Sign out')}
                                </button>
                            </div>

                            {/* Cloud sync — local SQLite is pushed to the signed-in account */}
                            <div className="p-5">
                                <h4 className="text-xs font-semibold text-text-primary mb-1.5 flex items-center gap-1.5">
                                    <Cloud size={13} className="text-text-tertiary" /> {t('Cloud sync')}
                                </h4>
                                <p className={`text-[11px] mb-2.5 ${sync.state === 'error' ? 'text-red-400' : 'text-text-secondary'}`}>
                                    {sync.state === 'syncing' && (
                                        <Loader2 size={11} className="inline-block animate-spin mr-1 -mt-px" />
                                    )}
                                    {syncStatusLine}
                                </p>
                                <button
                                    type="button"
                                    onClick={requestSync}
                                    disabled={syncBusy || sync.state === 'syncing'}
                                    className={secondaryBtnClass}
                                >
                                    <RefreshCw size={13} className={syncBusy || sync.state === 'syncing' ? 'animate-spin' : ''} />
                                    {syncBusy || sync.state === 'syncing' ? t('Syncing…') : t('Sync now')}
                                </button>
                            </div>

                            {/* Change password — hidden until the user clicks it */}
                            <div className="p-5">
                                {!changePasswordOpen ? (
                                    <button
                                        type="button"
                                        onClick={() => { setChangePasswordOpen(true); clearNotice(); }}
                                        className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-medium transition-colors text-text-secondary hover:text-text-primary hover:bg-bg-item-active/60"
                                    >
                                        <KeyRound size={13} /> {t('Change password')}
                                    </button>
                                ) : (
                                    <form onSubmit={changePassword} className="space-y-3">
                                        <h4 className="text-xs font-semibold text-text-primary">{t('Change password')}</h4>
                                        <label className="block space-y-1">
                                            <span className={labelClass}>{t('New password')}</span>
                                            <input
                                                type={showPassword ? 'text' : 'password'}
                                                value={password}
                                                onChange={(e) => setPassword(e.target.value)}
                                                autoComplete="new-password"
                                                className={inputClass}
                                            />
                                        </label>
                                        <label className="block space-y-1">
                                            <span className={labelClass}>{t('Confirm password')}</span>
                                            <input
                                                type={showPassword ? 'text' : 'password'}
                                                value={confirm}
                                                onChange={(e) => setConfirm(e.target.value)}
                                                autoComplete="new-password"
                                                className={inputClass}
                                            />
                                        </label>
                                        {notice && (
                                            <div className={`rounded-lg border px-3 py-2 text-[11px] flex items-start gap-2 ${noticeTone(notice.tone)}`}>
                                                {notice.tone === 'error' ? <AlertCircle size={13} className="shrink-0 mt-px" /> : <Check size={13} className="shrink-0 mt-px" />}
                                                <span>{notice.text}</span>
                                            </div>
                                        )}
                                        <button type="submit" disabled={busy} className={secondaryBtnClass}>
                                            {busy ? <Loader2 size={13} className="animate-spin" /> : <KeyRound size={13} />}
                                            {busy ? t('Please wait…') : t('Update password')}
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => { setChangePasswordOpen(false); clearNotice(); }}
                                            disabled={busy}
                                            className="w-full text-center text-[11px] text-text-secondary hover:text-text-primary transition-colors"
                                        >
                                            {t('Cancel')}
                                        </button>
                                    </form>
                                )}
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

export default AccountSettings;
