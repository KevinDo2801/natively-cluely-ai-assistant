import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useStreamBuffer } from '../hooks/useStreamBuffer';
import { IntelligenceStreamGuard } from '../lib/intelligenceStreamGuard.mjs';
import { X, Copy, Check, Globe, ArrowUp } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { genMessageId } from '../utils/messageId';
import nativelyIcon from './icon.png';
import { useResolvedTheme } from '../hooks/useResolvedTheme';

// ============================================
// Types
// ============================================

interface Message {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    isStreaming?: boolean;
}

interface GlobalChatOverlayProps {
    isOpen: boolean;
    onClose: () => void;
    initialQuery?: string;
}

// ============================================
// Typing Indicator Component
// ============================================

const TypingIndicator: React.FC = () => (
    <div className="flex items-center gap-1 py-4">
        <div className="flex items-center gap-1">
            {[0, 1, 2].map((i) => (
                <motion.div
                    key={i}
                    className="w-2 h-2 rounded-full bg-text-tertiary"
                    animate={{ opacity: [0.4, 1, 0.4] }}
                    transition={{
                        duration: 0.6,
                        repeat: Infinity,
                        delay: i * 0.15,
                        ease: "easeInOut"
                    }}
                />
            ))}
        </div>
    </div>
);

// ============================================
// Message Components
// ============================================

const UserMessage: React.FC<{ content: string }> = ({ content }) => (
    <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.15 }}
        className="flex justify-end mb-6"
    >
        <div className="bg-[#2C2C2E] text-white px-5 py-3 rounded-2xl rounded-tr-md max-w-[70%] text-[15px] leading-relaxed">
            {content}
        </div>
    </motion.div>
);

const AssistantMessage: React.FC<{ content: string; isStreaming?: boolean }> = ({ content, isStreaming }) => {
    const [copied, setCopied] = useState(false);

    const handleCopy = async () => {
        try {
            await navigator.clipboard.writeText(content);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch (err) {
            console.error('Failed to copy:', err);
        }
    };

    return (
        <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.15 }}
            className="flex flex-col items-start mb-6"
        >
            <div className="text-text-primary text-[15px] leading-relaxed max-w-[85%]">
                {content}
            </div>
            {!isStreaming && content && (
                <button
                    onClick={handleCopy}
                    className="flex items-center gap-2 mt-3 text-[13px] text-text-tertiary hover:text-text-secondary transition-colors"
                >
                    {copied ? <Check size={14} className="text-emerald-500" /> : <Copy size={14} />}
                    {copied ? 'Copied' : 'Copy message'}
                </button>
            )}
        </motion.div>
    );
};

// ============================================
// Main Component
// ============================================

type ChatState = 'idle' | 'waiting_for_llm' | 'streaming_response' | 'error';

// Hard client-side ceiling on the ragQueryGlobal IPC round-trip. The main
// process has its own internal timeouts (worker deadman switch, stream
// stall guard), but every one of those protects a DIFFERENT stage of the
// pipeline — if the hang happens somewhere NONE of them cover (e.g. the
// main thread itself blocked inside a synchronous native call before any
// of those timers can even be scheduled), the `await` on this invoke() has
// no ceiling of its own and can wait forever with the UI showing nothing.
// This is the backstop: no matter what breaks on the other side of the IPC
// boundary, the user gets an answer (even if it's "something went wrong")
// within a bounded time instead of a silently frozen chat bubble.
const RAG_QUERY_CLIENT_TIMEOUT_MS = 20000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error(`${label} timed out after ${ms}ms — the main process never responded`));
        }, ms);
        promise.then(
            (v) => { clearTimeout(timer); resolve(v); },
            (e) => { clearTimeout(timer); reject(e); },
        );
    });
}

const GlobalChatOverlay: React.FC<GlobalChatOverlayProps> = ({
    isOpen,
    onClose,
    initialQuery = ''
}) => {
    const [messages, setMessages] = useState<Message[]>([]);
    const [chatState, setChatState] = useState<ChatState>('idle');
    const [errorMessage, setErrorMessage] = useState<string | null>(null);
    const [query, setQuery] = useState('');
    const streamBuffer = useStreamBuffer();
    // Match the meeting chat overlay / modes manager --mm-bg exactly so
    // the expanded card looks like the same dark grey surface.
    const isLightTheme = useResolvedTheme() === 'light';
    const chatWindowBg = isLightTheme ? '#f9f9f9' : '#111111';

    const messagesEndRef = useRef<HTMLDivElement>(null);
    const chatWindowRef = useRef<HTMLDivElement>(null);
    // Synchronous busy guard for submitQuestion. `chatState` alone isn't
    // enough: it's React state, so two calls fired in quick succession (e.g.
    // repeated Enter presses on the footer input) can both read it before a
    // re-render lands, both pass the guard, and both register their own
    // onRAGStreamChunk/onRAGStreamComplete listeners against the ONE shared
    // streamBuffer — each call's `streamBuffer.reset()` then clobbers
    // whatever the other call had already buffered, so the eventual
    // completion can render empty. A ref updates immediately, no batching.
    const submitInFlightRef = useRef(false);

    // Submit initial query when overlay opens
    useEffect(() => {
        if (isOpen && initialQuery && messages.length === 0) {
            setTimeout(() => {
                submitQuestion(initialQuery);
            }, 100);
        }
    }, [isOpen, initialQuery]);

    // Listen for new queries from parent
    useEffect(() => {
        if (isOpen && initialQuery && messages.length > 0) {
            // This is a follow-up query
            submitQuestion(initialQuery);
        }
    }, [initialQuery]);

    // ESC key handler
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && isOpen) {
                onClose();
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [isOpen, onClose]);

    // Click outside handler
    const handleBackdropClick = useCallback((e: React.MouseEvent) => {
        if (e.target === e.currentTarget) {
            onClose();
        }
    }, [onClose]);

    const handleInputKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && query.trim()) {
            e.preventDefault();
            submitQuestion(query);
            setQuery('');
        }
    };

    // UNIFIED PIPELINE (C5): one mount-level subscription routes search + chat
    // fallback events into the current bubble. Per-streamKey generation guards
    // replace the old per-call adoptedStreamId + F-122 tag filters.
    const activeAssistantIdRef = useRef<string | null>(null);
    const globalGuardRef = useRef(new IntelligenceStreamGuard());
    const fallbackGuardRef = useRef(new IntelligenceStreamGuard());

    useEffect(() => {
        return window.electronAPI.onIntelligenceStream((ev: any) => {
            if (ev.type !== 'token' && ev.type !== 'done' && ev.type !== 'error') return;
            const isGlobal = ev.intent === 'global_search';
            const isChatFallback = ev.intent === 'chat';
            if (!isGlobal && !isChatFallback) return;

            const guard = isGlobal ? globalGuardRef.current : fallbackGuardRef.current;
            const decision = guard.resolve(ev);
            const assistantId = activeAssistantIdRef.current;
            if (!assistantId) return;

            if (ev.type === 'token') {
                if (!decision.accept) return;
                setChatState('streaming_response');
                streamBuffer.appendToken(ev.text ?? '', (content) => {
                    setMessages(prev => prev.map(msg =>
                        msg.id === assistantId ? { ...msg, content } : msg
                    ));
                });
                return;
            }

            if (ev.type === 'done') {
                if (!decision.honor) return;
                // Deferred completion: finalize only once the paced reveal has
                // drained the full answer.
                streamBuffer.complete((finalContent) => {
                    const text = finalContent.trim()
                        || (isGlobal
                            ? "I'm not sure how to answer that from your meetings — try asking a more specific question."
                            : "I'm not sure how to answer that — try rephrasing your question.");
                    setMessages(prev => prev.map(msg =>
                        msg.id === assistantId ? { ...msg, content: text, isStreaming: false } : msg
                    ));
                    setChatState('idle');
                    streamBuffer.reset();
                });
                return;
            }

            // error
            if (ev.surface === 'phone') return; // phone failure never defaces this bubble
            if (!decision.accept) return;
            console.error('[GlobalChat] stream error:', ev.error);
            setMessages(prev => prev.filter(msg => msg.id !== assistantId));
            setErrorMessage("Couldn't get a response. Please try again.");
            setChatState('error');
            streamBuffer.reset();
        });
    }, [streamBuffer]);

    // Submit question using global RAG through the UNIFIED entry point
    const submitQuestion = useCallback(async (question: string) => {
        // isDraining() closes the collision a deferred completion would otherwise
        // allow: the finally block clears submitInFlightRef once the IPC invoke
        // resolves, but the paced reveal may still be draining the OLD answer into
        // its bubble. A new submit then would push a fresh placeholder and stream
        // into the SAME buffer mid-drain. Block until the reveal catches up.
        if (!question.trim() || submitInFlightRef.current || streamBuffer.isDraining()) return;
        submitInFlightRef.current = true;

        const userMessage: Message = {
            id: genMessageId(),
            role: 'user',
            content: question
        };
        setMessages(prev => [...prev, userMessage]);
        setChatState('waiting_for_llm');
        setErrorMessage(null);

        // Scroll to bottom when user sends message
        setTimeout(() => {
            messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
        }, 50);

        const assistantMessageId = genMessageId();

        try {
            // Add typing indicator delay (200ms) - makes the AI feel "thoughtful"
            await new Promise(resolve => setTimeout(resolve, 200));

            // Create assistant message placeholder
            setMessages(prev => [...prev, {
                id: assistantMessageId,
                role: 'assistant',
                content: '',
                isStreaming: true
            }]);

            streamBuffer.reset();
            activeAssistantIdRef.current = assistantMessageId;

            // Global RAG search through the unified entry. Wrapped in a hard
            // client-side ceiling — see RAG_QUERY_CLIENT_TIMEOUT_MS above.
            let result: { started: boolean; error?: string } | undefined;
            try {
                const call = window.electronAPI?.runIntelligence({ source: 'global_search', text: question });
                result = call
                    ? await withTimeout(call, RAG_QUERY_CLIENT_TIMEOUT_MS, 'runIntelligence')
                    : undefined;
            } catch (timeoutErr) {
                console.error('[GlobalChat] runIntelligence client-side timeout:', timeoutErr);
                activeAssistantIdRef.current = null;
                setMessages(prev => prev.map(msg =>
                    msg.id === assistantMessageId
                        ? { ...msg, content: "This is taking longer than expected. Please try again.", isStreaming: false }
                        : msg
                ));
                setChatState('error');
                setErrorMessage("The search took too long to respond. Please try again.");
                return;
            }

            // If RAG is unavailable / not started, fall back to standard chat —
            // same behavior as the old { fallback: true } branch.
            if (!result || !result.started) {
                console.log("[GlobalChat] RAG unavailable, falling back to standard chat");
                const fallbackCall = window.electronAPI?.runIntelligence({ source: 'manual_chat', text: question });
                if (fallbackCall) {
                    try {
                        await withTimeout(fallbackCall, RAG_QUERY_CLIENT_TIMEOUT_MS, 'runIntelligence');
                    } catch (timeoutErr) {
                        console.error('[GlobalChat] runIntelligence fallback client-side timeout:', timeoutErr);
                        try { (window.electronAPI as any)?.cancelChatStream?.(); } catch { /* best-effort */ }
                        activeAssistantIdRef.current = null;
                        setMessages(prev => prev.map(msg =>
                            msg.id === assistantMessageId
                                ? { ...msg, content: "This is taking longer than expected. Please try again.", isStreaming: false }
                                : msg
                        ));
                        setChatState('error');
                        setErrorMessage("The request took too long to respond. Please try again.");
                    }
                }
            }

        } catch (error) {
            console.error('[GlobalChat] Error:', error);
            setMessages(prev => prev.filter(msg => msg.id !== assistantMessageId));
            setErrorMessage("Something went wrong. Please try again.");
            setChatState('error');
        } finally {
            // Reset the target row pointer once the invoke has settled; a
            // deferred completion still draining keeps streaming state via the
            // subscription above (it reads the ref captured at submit time).
            activeAssistantIdRef.current = null;
            // Preserve an explicit 'error' state; keep 'streaming' while a deferred
            // completion is still draining the reveal (complete()'s callback sets
            // it to 'idle' once the reveal has caught up).
            setChatState(prev => (prev === 'error' || streamBuffer.isDraining() ? prev : 'idle'));
            submitInFlightRef.current = false;
        }
    }, [streamBuffer]);

    return (
        <AnimatePresence
            onExitComplete={() => {
                setChatState('idle');
                setMessages([]);
                setErrorMessage(null);
            }}
        >
            {isOpen && (
                <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.16 }}
                    className="absolute inset-0 z-40 flex flex-col justify-end"
                    onClick={handleBackdropClick}
                >
                    {/* Backdrop with blur */}
                    <motion.div
                        initial={{ backdropFilter: 'blur(0px)' }}
                        animate={{ backdropFilter: 'blur(8px)' }}
                        exit={{ backdropFilter: 'blur(0px)' }}
                        transition={{ duration: 0.16 }}
                        className="absolute inset-0 bg-black/40"
                    />

                    {/* Chat Window */}
                    <motion.div
                        ref={chatWindowRef}
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: "85vh", opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{
                            height: { type: "spring", stiffness: 300, damping: 30, mass: 0.8 },
                            opacity: { duration: 0.2 }
                        }}
                        className="relative mx-auto w-full max-w-[680px] mb-0 rounded-t-[24px] border-t border-x border-border-subtle shadow-2xl overflow-hidden flex flex-col"
                        style={{ backgroundColor: chatWindowBg }}
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle shrink-0">
                            <div className="flex items-center gap-2 text-text-tertiary">
                                <img src={nativelyIcon} className="w-3.5 h-3.5 force-black-icon opacity-50" alt="logo" />
                                <span className="text-[13px] font-medium">Search all meetings</span>
                            </div>
                            <button
                                onClick={onClose}
                                className="p-2 transition-colors group"
                            >
                                <X size={16} className="text-text-tertiary group-hover:text-red-500 group-hover:drop-shadow-[0_0_8px_rgba(239,68,68,0.5)] transition-all duration-300" />
                            </button>
                        </div>

                        {/* Messages area - scrollable */}
                        <div className="flex-1 overflow-y-auto px-6 py-4 pb-32 custom-scrollbar">
                            {messages.map((msg) => (
                                msg.role === 'user'
                                    ? <UserMessage key={msg.id} content={msg.content} />
                                    : <AssistantMessage key={msg.id} content={msg.content} isStreaming={msg.isStreaming} />
                            ))}

                            {chatState === 'waiting_for_llm' && <TypingIndicator />}

                            {errorMessage && (
                                <motion.div
                                    initial={{ opacity: 0, y: 4 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    className="text-[#FF6B6B] text-[13px] py-2"
                                >
                                    {errorMessage}
                                </motion.div>
                            )}

                            <div ref={messagesEndRef} />
                        </div>

                        {/* Floating Footer (Ask Bar) */}
                        <div className="absolute bottom-0 left-0 right-0 p-6 flex justify-center z-50 pointer-events-none">
                            <div className="w-full max-w-[440px] relative group pointer-events-auto">
                                {/* Dark Glass Effect Input */}
                                <input
                                    type="text"
                                    value={query}
                                    onChange={(e) => setQuery(e.target.value)}
                                    onKeyDown={handleInputKeyDown}
                                    placeholder="Ask me anything..."
                                    className="w-full pl-5 pr-12 py-3 bg-bg-elevated shadow-[0_8px_30px_rgb(0,0,0,0.12)] border border-border-muted rounded-full text-sm text-text-primary placeholder-text-tertiary/70 focus:outline-none transition-all"
                                />
                                <button
                                    onClick={() => {
                                        if (query.trim()) {
                                            submitQuestion(query);
                                            setQuery('');
                                        }
                                    }}
                                    className={`absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded-full transition-all duration-200 border border-white/5 ${query.trim() ? 'bg-text-primary text-bg-primary hover:scale-105' : 'bg-bg-item-active text-text-primary hover:bg-bg-item-hover'
                                        }`}
                                >
                                    <ArrowUp size={16} className="transform rotate-45" />
                                </button>
                            </div>
                        </div>
                    </motion.div>
                </motion.div>
            )}
        </AnimatePresence>
    );
};

export default GlobalChatOverlay;
