/**
 * AssemblyAIStreamingSTT - WebSocket-based streaming Speech-to-Text using
 * AssemblyAI Universal-3.5 Pro.
 *
 * Implements the same EventEmitter interface as GoogleSTT / SonioxStreamingSTT:
 *   Events: 'transcript' ({ text, isFinal, confidence }), 'error' (Error)
 *   Methods: start(), stop(), write(chunk), setSampleRate(), setAudioChannelCount()
 *
 * Connects to wss://streaming.assemblyai.com/v3/ws (the Universal-3.5 Pro
 * streaming endpoint) and authenticates with the API key in the `Authorization`
 * header (no "Bearer" prefix). Connection parameters are passed as query-string
 * parameters: `speech_model`, `sample_rate`, and `encoding` (raw 16-bit LE PCM),
 * plus `language_code` when a recognition language is pinned (ISO-639-1, e.g.
 * `en`); it is omitted for auto-detect so the model code-switches natively.
 *
 * Inbound messages:
 *   - Begin        → session opened (id, expires_at)
 *   - Turn         → `transcript` is the cumulative text for the current turn;
 *                    `end_of_turn: true` marks the finalized turn.
 *   - Error        → server error, forwarded as 'error'.
 *   - Termination  → session closed.
 *
 * Billing note: AssemblyAI streaming is billed per open-session duration, so
 * stop()/finalize() always send a `{"type":"Terminate"}` message to finalize the
 * open turn and close the session instead of leaving the socket idle.
 */

import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { RECOGNITION_LANGUAGES } from '../config/languages';
import { streamingStttWsOptions } from './dnsHelpers';

const ASSEMBLYAI_WS_ENDPOINT = 'wss://streaming.assemblyai.com/v3/ws';
// Universal-3.5 Pro is the requested (and currently default) streaming model.
const ASSEMBLYAI_SPEECH_MODEL = 'universal-3-5-pro';
// Raw mono 16-bit little-endian PCM, matching the app's native audio pipeline.
const ASSEMBLYAI_ENCODING = 'pcm_s16le';

const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 30000;
// Cap reconnect attempts so a flapping network can't drive an indefinite WS
// open-loop against AssemblyAI (per-session billing + rate-limit risk). After
// the cap, emit 'error' so the orchestrator can surface a UI prompt; a
// user-triggered restart via stop()/start() resets the counter to 0.
const RECONNECT_MAX_ATTEMPTS = 10;
const KEEPALIVE_INTERVAL_MS = 5000;

export class AssemblyAIStreamingSTT extends EventEmitter {
    private apiKey: string;
    private ws: WebSocket | null = null;
    private isActive = false;
    private shouldReconnect = false;

    private sampleRate = 16000;
    private numChannels = 1;
    // ISO-639-1 steering code for `language_code`, or undefined for auto-detect.
    private languageCode?: string;

    private reconnectAttempts = 0;
    private reconnectTimer: NodeJS.Timeout | null = null;
    private keepAliveTimer: NodeJS.Timeout | null = null;
    // Debounced restart driven by setSampleRate (device route changes can fire
    // a new sample rate and a new language in the same tick). Mirrors the
    // SonioxStreamingSTT / NativelyProSTT 250ms restart pattern.
    private pendingRestartTimer: NodeJS.Timeout | null = null;

    private buffer: Buffer[] = [];
    private isConnecting = false;

    constructor(apiKey: string) {
        super();
        this.apiKey = apiKey;
    }

    // =========================================================================
    // Configuration (match GoogleSTT / SonioxStreamingSTT interface)
    // =========================================================================

    public setSampleRate(rate: number): void {
        if (this.sampleRate === rate) return;
        this.sampleRate = rate;
        console.log(`[AssemblyAIStreaming] Sample rate set to ${rate}`);

        if (this.isActive) {
            console.log('[AssemblyAIStreaming] Sample rate changed while active. Scheduling debounced restart...');
            this.scheduleRestart();
        }
    }

    public setAudioChannelCount(count: number): void {
        this.numChannels = count;
        console.log(`[AssemblyAIStreaming] Channel count set to ${count}`);
    }

    /**
     * Set the recognition language hint. Maps the app's Recognition Language key
     * to an ISO-639-1 code and steers AssemblyAI via the `language_code` query
     * param. `auto` (or an unknown key) clears the hint so the model auto-detects
     * natively — the documented "full multilingual" mode.
     *
     * Because `language_code` is a connect-time param, a change while the socket
     * is active triggers the same debounced restart as a sample-rate change.
     */
    public setRecognitionLanguage(key: string): void {
        if (key === 'auto') {
            if (this.languageCode === undefined) return;
            this.languageCode = undefined;
            console.log('[AssemblyAIStreaming] Language set to auto-detect');
        } else {
            const config = RECOGNITION_LANGUAGES[key];
            if (!config) return;
            const iso = config.iso639;
            if (iso === this.languageCode) return;
            this.languageCode = iso;
            console.log(`[AssemblyAIStreaming] Language hint set to ${iso}`);
        }

        if (this.isActive) {
            console.log('[AssemblyAIStreaming] Language changed while active. Scheduling debounced restart...');
            this.scheduleRestart();
        }
    }

    /** No-op — AssemblyAI authenticates via header, not a service-account file. */
    public setCredentials(_path: string): void { }

    /** No-op — AssemblyAI Universal-3.5 Pro uses keyterms prompting instead. */
    public setKeywords(_keywords: string[]): void { }

    // =========================================================================
    // Lifecycle
    // =========================================================================

    public start(): void {
        if (this.isActive) return;
        if (this.pendingRestartTimer) {
            clearTimeout(this.pendingRestartTimer);
            this.pendingRestartTimer = null;
        }
        this.isActive = true;        // Set immediately so write() buffers audio during WS handshake
        this.shouldReconnect = true;
        this.reconnectAttempts = 0;
        this.connect();
    }

    public stop(): void {
        this.shouldReconnect = false;
        this.clearTimers();

        if (this.ws) {
            try {
                // Terminate finalizes the open turn and closes the session —
                // required so the session isn't billed for the full 3h auto-close.
                if (this.ws.readyState === WebSocket.OPEN) {
                    this.ws.send(JSON.stringify({ type: 'Terminate' }));
                }
            } catch {
                // Ignore send errors during shutdown
            }
            this.ws.close();
            this.ws = null;
        }

        this.isActive = false;
        this.isConnecting = false;
        this.buffer = [];
        console.log('[AssemblyAIStreaming] Stopped');
    }

    // =========================================================================
    // Audio Data
    // =========================================================================

    public write(chunk: Buffer): void {
        if (!this.isActive) return;

        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            this.buffer.push(chunk);
            if (this.buffer.length > 500) this.buffer.shift(); // Cap buffer size

            if (!this.isConnecting && this.shouldReconnect && !this.reconnectTimer) {
                console.log('[AssemblyAIStreaming] WS not ready. Lazy connecting on new audio...');
                this.connect();
            }
            return;
        }

        this.ws.send(chunk);
    }

    /** Finalize the open turn (flush server buffer) without tearing the socket down. */
    public finalize(): void {
        if (!this.isActive || !this.ws) return;

        if (this.ws.readyState === WebSocket.OPEN) {
            try {
                this.ws.send(JSON.stringify({ type: 'Terminate' }));
                console.log('[AssemblyAIStreaming] Sent Terminate to flush the open turn');
            } catch (err) {
                console.error('[AssemblyAIStreaming] Failed to send Terminate:', err);
            }
        }
    }

    // =========================================================================
    // WebSocket Connection
    // =========================================================================

    private buildUrl(): string {
        const params = new URLSearchParams({
            speech_model: ASSEMBLYAI_SPEECH_MODEL,
            sample_rate: String(this.sampleRate),
            encoding: ASSEMBLYAI_ENCODING,
        });
        // `language_code` (singular) is a connect-time query param carrying a
        // single ISO-639-1 code (e.g. `en`). Omitted entirely for auto-detect so
        // the model keeps native multilingual code-switching. (The official SDKs
        // deprecate the singular form in favor of `language_codes` with a
        // single-element array — identical wire behavior — kept here per request.)
        if (this.languageCode) {
            params.set('language_code', this.languageCode);
        }
        // Ask the server to report the detected language per turn (language_code
        // + language_confidence fields on Turn messages). Verified supported on
        // Universal-3.5 Pro Streaming in the official v3 streaming spec.
        params.set('language_detection', 'true');
        return `${ASSEMBLYAI_WS_ENDPOINT}?${params.toString()}`;
    }

    private connect(): void {
        if (this.isConnecting) return;
        this.isConnecting = true;

        console.log(`[AssemblyAIStreaming] Connecting (rate=${this.sampleRate}, ch=${this.numChannels})...`);

        // streamingStttWsOptions: forces IPv4-only DNS lookup (sidesteps Node's
        // macOS dual-stack ENOTFOUND) and caps the TLS+upgrade handshake at 15s.
        // AssemblyAI authenticates via the Authorization header (no Bearer prefix).
        this.ws = new WebSocket(
            this.buildUrl(),
            streamingStttWsOptions({ headers: { Authorization: this.apiKey } }) as any,
        );

        // F-203 identity guard (mirrors SonioxStreamingSTT / NativelyProSTT):
        // stop() does not detach listeners and setSampleRate() schedules a
        // synchronous stop()+start(), so the OLD socket's async events would
        // otherwise run against the NEW session. Capture the socket and bail on
        // every event when it is no longer the live `this.ws`.
        const ws = this.ws;

        this.ws.on('open', () => {
            if (ws !== this.ws) return; // F-203 stale-socket guard
            if (!this.shouldReconnect || !this.isActive) {
                this.ws?.close();
                this.ws = null;
                this.isConnecting = false;
                return;
            }

            this.reconnectAttempts = 0;
            this.isConnecting = false;
            console.log('[AssemblyAIStreaming] Connected');

            // Flush buffered audio once the socket is open.
            while (this.buffer.length > 0) {
                const chunk = this.buffer.shift();
                if (chunk && this.ws?.readyState === WebSocket.OPEN) {
                    this.ws.send(chunk);
                }
            }

            this.startKeepAlive();
        });

        this.ws.on('message', (data: WebSocket.Data) => {
            if (ws !== this.ws) return; // F-203 stale-socket guard
            try {
                const msg = JSON.parse(data.toString());

                switch (msg.type) {
                    case 'Begin':
                        console.log(`[AssemblyAIStreaming] Session started: ${msg.id}`);
                        break;

                    case 'Turn': {
                        const transcript = msg.transcript;
                        if (typeof transcript !== 'string' || transcript.length === 0) return;
                        const isFinal = msg.end_of_turn === true;
                        this.emit('transcript', {
                            text: transcript,
                            isFinal,
                            confidence: 1.0,
                            // Populated only when language_detection=true (requested
                            // in buildUrl). The detected ISO-639-1 code + confidence
                            // let the UI show what language the model actually heard
                            // — e.g. selecting English but detecting Vietnamese.
                            ...(typeof msg.language_code === 'string'
                                ? { languageCode: msg.language_code, languageConfidence: typeof msg.language_confidence === 'number' ? msg.language_confidence : undefined }
                                : {}),
                        });
                        break;
                    }

                    case 'Error': {
                        const detail = msg.message || msg.error || 'Unknown AssemblyAI error';
                        console.error(`[AssemblyAIStreaming] Server error: ${detail}`);
                        this.emit('error', new Error(`AssemblyAI: ${detail}`));
                        break;
                    }

                    case 'Termination':
                        console.log('[AssemblyAIStreaming] Session terminated');
                        break;
                }
            } catch (err) {
                console.error('[AssemblyAIStreaming] Parse error:', err);
            }
        });

        this.ws.on('error', (err: Error) => {
            if (ws !== this.ws) return; // F-203 stale-socket guard
            console.error('[AssemblyAIStreaming] WebSocket error:', err.message);
            this.emit('error', err);
        });

        this.ws.on('close', (code: number, reason: Buffer) => {
            if (ws !== this.ws) return; // F-203 stale-socket guard
            this.ws = null;
            this.isConnecting = false;
            this.clearKeepAlive();
            console.log(`[AssemblyAIStreaming] Closed (code=${code}, reason=${reason.toString()})`);

            if (this.shouldReconnect && code !== 1000) {
                this.scheduleReconnect();
            } else {
                this.isActive = false;
            }
        });
    }

    // =========================================================================
    // Reconnection
    // =========================================================================

    private scheduleReconnect(): void {
        if (!this.shouldReconnect) return;

        if (this.reconnectAttempts >= RECONNECT_MAX_ATTEMPTS) {
            console.error(`[AssemblyAIStreaming] Max reconnect attempts (${RECONNECT_MAX_ATTEMPTS}) reached — giving up`);
            this.shouldReconnect = false;
            this.emit('error', new Error('AssemblyAIStreamingSTT: max reconnect attempts exceeded'));
            return;
        }

        const delay = Math.min(
            RECONNECT_BASE_DELAY_MS * Math.pow(2, this.reconnectAttempts),
            RECONNECT_MAX_DELAY_MS
        );
        this.reconnectAttempts++;

        console.log(`[AssemblyAIStreaming] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${RECONNECT_MAX_ATTEMPTS})...`);

        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (this.shouldReconnect) {
                this.connect();
            }
        }, delay);
    }

    /**
     * Debounced restart: collapses rapid setSampleRate calls into a single
     * stop()+start() sequence ~250ms later, preserving the live buffer across
     * the restart (mirrors SonioxStreamingSTT.scheduleRestart).
     */
    private scheduleRestart(): void {
        if (this.pendingRestartTimer) {
            clearTimeout(this.pendingRestartTimer);
        }
        this.pendingRestartTimer = setTimeout(() => {
            this.pendingRestartTimer = null;
            if (!this.isActive) return;  // a real stop() ran in the window — abort the restart
            const savedBuffer = [...this.buffer];
            this.stop();
            this.start();
            if (savedBuffer.length > 0) {
                this.buffer = [...savedBuffer, ...this.buffer];
            }
        }, 250);
    }

    // =========================================================================
    // Keep-alive
    // =========================================================================

    private startKeepAlive(): void {
        this.clearKeepAlive();
        this.keepAliveTimer = setInterval(() => {
            if (this.ws?.readyState === WebSocket.OPEN) {
                try {
                    this.ws.ping();
                } catch {
                    // Ignore errors
                }
            }
        }, KEEPALIVE_INTERVAL_MS);
    }

    private clearKeepAlive(): void {
        if (this.keepAliveTimer) {
            clearInterval(this.keepAliveTimer);
            this.keepAliveTimer = null;
        }
    }

    private clearTimers(): void {
        this.clearKeepAlive();
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.pendingRestartTimer) {
            clearTimeout(this.pendingRestartTimer);
            this.pendingRestartTimer = null;
        }
    }
}
