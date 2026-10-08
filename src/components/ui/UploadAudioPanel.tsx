import React, { useEffect, useRef, useState } from 'react';
import { AlertCircle, ArrowRight, Check, FileAudio, Link as LinkIcon, LoaderCircle, Upload, Users, X } from 'lucide-react';
import { useT } from '../../i18n';
import { useResolvedTheme } from '../../hooks/useResolvedTheme';
import type { UploadAudioFileRef, UploadAudioProgress, UploadAudioResult, UploadAudioSource } from '../../types/uploadAudio';

type ViewState = 'idle' | 'selected' | 'processing' | 'complete' | 'error';

interface UploadAudioPanelProps {
    onOpenMeeting?: (meetingId: string) => void;
}

const formatFileSize = (bytes: number) => bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

const stageLabels: Record<UploadAudioProgress['stage'], string> = {
    preparing: 'Preparing file…',
    uploading: 'Sending audio securely…',
    transcribing: 'Transcribing with Deepgram Nova-3…',
    saving: 'Saving transcript…',
};

const PanelShell: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <div className="h-full w-full overflow-y-auto custom-scrollbar bg-bg-secondary">
        <div className="mx-auto flex min-h-full w-full max-w-5xl items-center px-6 py-10">
            <div className="w-full">{children}</div>
        </div>
    </div>
);

type LanguageChoice = { value: string; label: string };

function buildLanguageChoices(languages: Record<string, { iso639?: string; label?: string }> | undefined): LanguageChoice[] {
    if (!languages) return [];
    const seen = new Set<string>();
    const choices: LanguageChoice[] = [];
    for (const entry of Object.values(languages)) {
        const iso = entry?.iso639;
        if (!iso || iso === 'auto' || seen.has(iso)) continue;
        seen.add(iso);
        choices.push({ value: iso, label: iso === 'en' ? 'English' : (entry.label || iso) });
    }
    choices.sort((a, b) => a.label.localeCompare(b.label));
    return choices;
}

const LanguageSelect: React.FC<{
    value: string;
    onChange: (value: string) => void;
    choices: LanguageChoice[];
    isLight: boolean;
}> = ({ value, onChange, choices, isLight }) => {
    const t = useT();
    return (
        <div className={`mt-3 flex items-center justify-between rounded-xl border px-4 py-3.5 ${isLight ? 'border-black/10 bg-white/45' : 'border-white/10 bg-bg-item-surface/55'}`}>
            <div className="pr-4">
                <div className="text-[13px] font-medium text-text-primary">{t('Language')}</div>
                <div className="mt-0.5 text-[11px] leading-4 text-text-tertiary">{t('Transcribe in a specific language')}</div>
            </div>
            <select
                value={value}
                onChange={(event) => onChange(event.target.value)}
                aria-label={t('Language')}
                className={`ml-4 h-9 shrink-0 rounded-lg border bg-bg-input px-2 text-[12px] text-text-primary outline-none ${isLight ? 'border-black/10' : 'border-white/10'}`}
            >
                <option value="auto">{t('Auto Detect')}</option>
                {choices.map((choice) => (
                    <option key={choice.value} value={choice.value}>{choice.label}</option>
                ))}
            </select>
        </div>
    );
};

const ConfigToggle: React.FC<{
    label: string;
    description: string;
    checked: boolean;
    onChange: (checked: boolean) => void;
    isLight: boolean;
}> = ({ label, description, checked, onChange, isLight }) => (
    <div className={`mt-3 flex items-center justify-between rounded-xl border px-4 py-3.5 ${isLight ? 'border-black/10 bg-white/45' : 'border-white/10 bg-bg-item-surface/55'}`}>
        <div className="pr-4">
            <div className="text-[13px] font-medium text-text-primary">{label}</div>
            <div className="mt-0.5 text-[11px] leading-4 text-text-tertiary">{description}</div>
        </div>
        <button
            type="button"
            role="switch"
            aria-checked={checked}
            aria-label={label}
            data-on={String(checked)}
            onClick={() => onChange(!checked)}
            className="t-toggle t-toggle-sm ml-4 shrink-0"
        >
            <span className="t-toggle-thumb" aria-hidden="true" />
        </button>
    </div>
);

const UploadAudioPanel: React.FC<UploadAudioPanelProps> = ({ onOpenMeeting }) => {
    const t = useT();
    const isLight = useResolvedTheme() === 'light';
    const activeRequestIdRef = useRef<string | null>(null);
    const [viewState, setViewState] = useState<ViewState>('idle');
    const [selectedFile, setSelectedFile] = useState<UploadAudioFileRef | null>(null);
    const [lastSource, setLastSource] = useState<UploadAudioSource | null>(null);
    const [isDragging, setIsDragging] = useState(false);
    const [mediaUrl, setMediaUrl] = useState('');
    const [speakerDetection, setSpeakerDetection] = useState(false);
    const [language, setLanguage] = useState('auto');
    const [languageChoices, setLanguageChoices] = useState<LanguageChoice[]>([]);
    const [saveTranscript, setSaveTranscript] = useState(false);
    const [progress, setProgress] = useState<UploadAudioProgress>({ requestId: '', stage: 'preparing', percent: 0 });
    const [result, setResult] = useState<Extract<UploadAudioResult, { success: true }> | null>(null);
    const [error, setError] = useState('');
    const [copied, setCopied] = useState(false);

    useEffect(() => {
        const unsubscribe = window.electronAPI.onUploadAudioProgress?.((next) => {
            if (next.requestId === activeRequestIdRef.current) setProgress(next);
        });
        return () => unsubscribe?.();
    }, []);

    useEffect(() => {
        let cancelled = false;
        void (async () => {
            try {
                const langs = await window.electronAPI.getRecognitionLanguages?.();
                if (!cancelled) setLanguageChoices(buildLanguageChoices(langs));
            } catch {
                // Non-fatal: the dropdown simply stays Auto-only.
            }
        })();
        return () => { cancelled = true; };
    }, []);

    useEffect(() => () => {
        if (activeRequestIdRef.current) {
            void window.electronAPI.uploadAudioCancel?.(activeRequestIdRef.current);
        }
    }, []);

    const reset = () => {
        activeRequestIdRef.current = null;
        setViewState('idle');
        setSelectedFile(null);
        setLastSource(null);
        setMediaUrl('');
        setProgress({ requestId: '', stage: 'preparing', percent: 0 });
        setResult(null);
        setError('');
    };

    const startTranscription = async (source: UploadAudioSource) => {
        const requestId = crypto.randomUUID();
        activeRequestIdRef.current = requestId;
        setLastSource(source);
        setViewState('processing');
        setResult(null);
        setError('');
        setProgress({ requestId, stage: 'preparing', percent: 3 });
        try {
            const response = await window.electronAPI.uploadAudioTranscribe({ requestId, source, speakerDetection, language, save: saveTranscript });
            if (activeRequestIdRef.current !== requestId) return;
            activeRequestIdRef.current = null;
            if (response.success) {
                setProgress({ requestId, stage: 'saving', percent: 100 });
                setResult(response);
                setViewState('complete');
            } else if (response.code === 'CANCELLED') {
                reset();
            } else {
                setError(response.error);
                setViewState('error');
            }
        } catch (requestError) {
            if (activeRequestIdRef.current !== requestId) return;
            activeRequestIdRef.current = null;
            setError(requestError instanceof Error ? requestError.message : t('Audio transcription failed.'));
            setViewState('error');
        }
    };

    const chooseFile = async () => {
        const response = await window.electronAPI.uploadAudioSelectFile();
        if (response.canceled) return;
        setSelectedFile(response);
        setLastSource({ kind: 'file', token: response.token });
        setError('');
        setViewState('selected');
    };

    const registerDroppedFile = async (file: File) => {
        const filePath = window.electronAPI.uploadAudioGetPathForFile(file);
        const response = await window.electronAPI.uploadAudioRegisterDroppedFile(filePath);
        if (!response.success) {
            setError(response.error);
            setViewState('error');
            return;
        }
        setSelectedFile(response.file);
        setLastSource({ kind: 'file', token: response.file.token });
        setError('');
        setViewState('selected');
    };

    const cancel = async () => {
        const requestId = activeRequestIdRef.current;
        activeRequestIdRef.current = null;
        if (requestId) await window.electronAPI.uploadAudioCancel(requestId);
        reset();
    };

    const copyTranscript = async () => {
        if (!result) return;
        try {
            await navigator.clipboard.writeText(result.transcript);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1600);
        } catch {
            // Clipboard unavailable — the transcript is selectable anyway.
        }
    };

    if (viewState === 'processing') {
        return (
            <PanelShell>
                <div className="flex flex-col items-center text-center" data-testid="upload-audio-processing">
                    <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent-primary/10 text-accent-primary"><LoaderCircle size={25} className="animate-spin" /></div>
                    <h1 className="mt-5 text-[21px] font-semibold tracking-[-0.02em] text-text-primary">{t('Transcribing audio')}</h1>
                    <p className="mt-1 text-[12px] text-text-tertiary">{t(stageLabels[progress.stage])}</p>
                    <div className="mt-6 h-1.5 w-full max-w-md overflow-hidden rounded-full bg-bg-tertiary"><div className="h-full rounded-full bg-accent-primary transition-[width] duration-500" style={{ width: `${progress.percent}%` }} /></div>
                    <span className="mt-2 text-[11px] tabular-nums text-text-tertiary">{Math.round(progress.percent)}%</span>
                    <button type="button" onClick={() => void cancel()} className="mt-6 rounded-full px-4 py-2 text-[12px] font-medium text-text-secondary transition-colors hover:bg-bg-item-hover hover:text-text-primary">{t('Cancel transcription')}</button>
                </div>
            </PanelShell>
        );
    }

    if (viewState === 'complete' && result) {
        const savedMeetingId = result.meetingId;
        return (
            <PanelShell>
                <div className="flex flex-col items-center text-center" data-testid="upload-audio-complete">
                    <span className="flex h-14 w-14 items-center justify-center rounded-full bg-emerald-500/12 text-emerald-500"><Check size={26} strokeWidth={2.5} /></span>
                    <h1 className="mt-5 text-[21px] font-semibold tracking-[-0.02em] text-text-primary">{t('Transcription complete')}</h1>
                    <p className="mt-1 text-[12px] text-text-tertiary">{result.detectedLanguage ? `${t('Detected language')}: ${result.detectedLanguage}` : (savedMeetingId ? t('Saved to My Natively') : t('Not saved'))}</p>
                    <div className={`mt-6 max-h-[220px] w-full overflow-y-auto rounded-2xl border p-5 text-left custom-scrollbar ${isLight ? 'border-black/10 bg-white/55' : 'border-white/10 bg-bg-item-surface/70'}`}><p className="whitespace-pre-wrap text-[13px] leading-6 text-text-secondary">{result.transcript}</p></div>
                    <div className="mt-6 flex items-center gap-2">
                        {savedMeetingId ? (
                            <button type="button" onClick={() => onOpenMeeting?.(savedMeetingId)} className="rounded-full bg-accent-primary px-5 py-2.5 text-[12px] font-semibold text-white shadow-sm transition-transform hover:scale-[1.02] active:scale-[0.98]">{t('Open transcript')}</button>
                        ) : (
                            <button type="button" onClick={() => void copyTranscript()} className="rounded-full bg-accent-primary px-5 py-2.5 text-[12px] font-semibold text-white shadow-sm transition-transform hover:scale-[1.02] active:scale-[0.98]">{copied ? t('Copied') : t('Copy transcript')}</button>
                        )}
                        <button type="button" onClick={reset} className="rounded-full px-4 py-2.5 text-[12px] font-medium text-text-secondary transition-colors hover:bg-bg-item-hover hover:text-text-primary">{t('Upload another')}</button>
                    </div>
                </div>
            </PanelShell>
        );
    }

    if (viewState === 'error') {
        return (
            <PanelShell>
                <div className="mx-auto w-full max-w-xl" data-testid="upload-audio-error">
                    <div className="flex items-start gap-3 rounded-2xl border border-red-500/20 bg-red-500/[0.07] p-4">
                        <AlertCircle size={18} className="mt-0.5 shrink-0 text-red-500" />
                        <div className="min-w-0 flex-1"><h1 className="text-[14px] font-semibold text-text-primary">{t('Audio transcription failed')}</h1><p className="mt-1 text-[12px] leading-5 text-text-secondary">{error}</p></div>
                        <button type="button" onClick={reset} aria-label={t('Close')} className="rounded-full p-1 text-text-tertiary hover:bg-bg-item-hover hover:text-text-primary"><X size={15} /></button>
                    </div>
                    <div className="mt-4 flex justify-center gap-2">
                        {lastSource && <button type="button" onClick={() => void startTranscription(lastSource)} className="rounded-full bg-accent-primary px-5 py-2.5 text-[12px] font-semibold text-white">{t('Retry')}</button>}
                        <button type="button" onClick={reset} className="rounded-full px-4 py-2.5 text-[12px] font-medium text-text-secondary hover:bg-bg-item-hover">{t('Start over')}</button>
                    </div>
                </div>
            </PanelShell>
        );
    }

    if (viewState === 'selected' && selectedFile) {
        return (
            <PanelShell>
                <div className="w-full" data-testid="upload-audio-selected">
                    <div className={`flex min-h-[78px] items-center gap-4 rounded-2xl border px-4 py-3.5 ${isLight ? 'border-black/10 bg-white/55' : 'border-white/10 bg-bg-item-surface/70'}`}>
                        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent-primary/10 text-accent-primary"><FileAudio size={20} /></span>
                        <div className="min-w-0 flex-1">
                            <p className="truncate text-[14px] font-medium text-text-primary">{selectedFile.name}</p>
                            <p className="mt-1 flex items-center gap-1.5 text-[11px] text-text-tertiary">
                                <span>{formatFileSize(selectedFile.sizeBytes)}</span>
                                <span aria-hidden="true">·</span>
                                <span className="underline decoration-text-tertiary/35 underline-offset-2">{t('Deepgram Nova-3')}</span>
                            </p>
                        </div>
                        <button type="button" onClick={reset} aria-label={t('Remove file')} className="rounded-full p-2 text-text-tertiary transition-colors hover:bg-bg-item-hover hover:text-text-primary"><X size={15} /></button>
                    </div>
                    <div className="mt-4 flex justify-center gap-2">
                        <button type="button" onClick={() => void startTranscription({ kind: 'file', token: selectedFile.token })} className="rounded-full bg-accent-primary px-5 py-2.5 text-[12px] font-semibold text-white shadow-sm transition-transform hover:scale-[1.02] active:scale-[0.98]">{t('Transcribe')}</button>
                        <button type="button" onClick={reset} className="rounded-full px-4 py-2.5 text-[12px] font-medium text-text-primary transition-colors hover:bg-bg-item-hover">{t('Cancel')}</button>
                    </div>
                    <div className={`mt-5 flex min-h-[78px] items-center justify-between rounded-2xl border px-5 py-3.5 ${isLight ? 'border-black/10 bg-white/45' : 'border-white/10 bg-bg-item-surface/55'}`}>
                        <div className="flex min-w-0 items-start gap-3">
                            <Users size={16} className="mt-0.5 shrink-0 text-text-tertiary" />
                            <div className="min-w-0">
                                <div className="text-[13px] font-medium text-text-primary">{t('Speaker detection')}</div>
                                <div className="mt-0.5 text-[11px] leading-4 text-text-tertiary">{t('Identify different speakers in the audio')}</div>
                            </div>
                        </div>
                        <button type="button" role="switch" aria-checked={speakerDetection} aria-label={t('Speaker detection')} data-on={String(speakerDetection)} onClick={() => setSpeakerDetection((enabled) => !enabled)} className="t-toggle t-toggle-sm ml-4 shrink-0"><span className="t-toggle-thumb" aria-hidden="true" /></button>
                    </div>
                    <LanguageSelect value={language} onChange={setLanguage} choices={languageChoices} isLight={isLight} />
                    <ConfigToggle label={t('Save transcript')} description={t('Save to My Natively after transcribing')} checked={saveTranscript} onChange={setSaveTranscript} isLight={isLight} />
                </div>
            </PanelShell>
        );
    }

    return (
        <PanelShell>
            <div data-testid="upload-audio-panel">
                <div className="flex flex-col items-center gap-1.5 text-center"><h1 className="text-[24px] font-semibold tracking-[-0.02em] text-text-primary">{t('Upload Audio')}</h1><span title={t('Deepgram Nova-3 with automatic language detection')} className="text-[12px] text-text-tertiary underline decoration-text-tertiary/30 underline-offset-2">{t('Using Deepgram Nova-3')}</span></div>
                <div role="button" tabIndex={0} aria-label={t('Drop an audio or video file, or click to browse')} data-testid="upload-audio-dropzone" onClick={() => void chooseFile()} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); void chooseFile(); } }} onDragEnter={(event) => { event.preventDefault(); setIsDragging(true); }} onDragOver={(event) => event.preventDefault()} onDragLeave={() => setIsDragging(false)} onDrop={(event) => { event.preventDefault(); setIsDragging(false); const file = event.dataTransfer.files?.[0]; if (file) void registerDroppedFile(file); }} className={`group mt-6 flex min-h-[190px] cursor-pointer flex-col items-center justify-center rounded-2xl border border-dashed px-6 py-10 text-center transition-[background-color,border-color,transform] duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary/35 ${isDragging ? 'scale-[1.01] border-accent-primary bg-accent-primary/10' : isLight ? 'border-black/20 bg-white/55 hover:border-accent-primary/45 hover:bg-white/80' : 'border-white/15 bg-bg-item-surface/70 hover:border-accent-primary/45 hover:bg-accent-primary/[0.07]'}`}>
                    <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-bg-tertiary text-text-secondary transition-colors group-hover:text-accent-primary"><Upload size={21} /></span><span className="mt-4 text-[14px] font-medium text-text-primary">{t('Drop an audio or video file here')}</span><span className="mt-1 text-[12px] text-text-tertiary">{t('or click to browse your files')}</span><span className="mt-4 text-[10px] uppercase tracking-[0.08em] text-text-tertiary/80">{t('MP3, WAV, M4A, AAC, FLAC, OGG, MP4, MOV, WEBM or MKV')}</span>
                </div>
                <div className="my-6 flex items-center gap-3" aria-hidden="true"><span className="h-px flex-1 bg-border-subtle" /><span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-text-tertiary">{t('or')}</span><span className="h-px flex-1 bg-border-subtle" /></div>
                <div className="relative"><LinkIcon className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-text-tertiary" size={16} /><input type="url" value={mediaUrl} onChange={(event) => setMediaUrl(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && mediaUrl.trim()) void startTranscription({ kind: 'url', url: mediaUrl.trim() }); }} aria-label={t('Audio or video URL')} placeholder={t('Paste a direct audio or video URL')} className={`h-12 w-full rounded-xl border bg-bg-input pl-11 pr-14 text-[13px] text-text-primary outline-none transition-colors placeholder:text-text-tertiary/70 focus:border-accent-primary/50 focus:ring-2 focus:ring-accent-primary/15 ${isLight ? 'border-black/10' : 'border-white/10'}`} /><button type="button" aria-label={t('Transcribe this URL')} disabled={!mediaUrl.trim()} onClick={() => void startTranscription({ kind: 'url', url: mediaUrl.trim() })} className="absolute right-2 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-lg bg-text-primary text-bg-primary transition-all hover:scale-105 disabled:cursor-default disabled:opacity-30 disabled:hover:scale-100"><ArrowRight size={15} /></button></div>
                <p className="mt-2 text-center text-[10px] text-text-tertiary">{t('Direct media URLs only. YouTube support is not enabled yet.')}</p>
                <div className={`mt-6 flex items-center justify-between rounded-xl border px-4 py-3.5 ${isLight ? 'border-black/10 bg-white/45' : 'border-white/10 bg-bg-item-surface/55'}`}><div className="pr-4"><div className="text-[13px] font-medium text-text-primary">{t('Speaker detection')}</div><div className="mt-0.5 text-[11px] leading-4 text-text-tertiary">{t('Separate different speakers in the transcript')}</div></div><button type="button" role="switch" aria-checked={speakerDetection} aria-label={t('Speaker detection')} data-on={String(speakerDetection)} onClick={() => setSpeakerDetection((enabled) => !enabled)} className="t-toggle t-toggle-sm shrink-0"><span className="t-toggle-thumb" aria-hidden="true" /></button></div>
                <LanguageSelect value={language} onChange={setLanguage} choices={languageChoices} isLight={isLight} />
                <ConfigToggle label={t('Save transcript')} description={t('Save to My Natively after transcribing')} checked={saveTranscript} onChange={setSaveTranscript} isLight={isLight} />
            </div>
        </PanelShell>
    );
};

export default UploadAudioPanel;
