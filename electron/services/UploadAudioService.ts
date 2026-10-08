import crypto from 'crypto';
import fs from 'fs';
import https from 'https';
import path from 'path';
import { dialog } from 'electron';
import { CredentialsManager } from './CredentialsManager';
import { DatabaseManager } from '../db/DatabaseManager';
import { parseDeepgramUpload } from './UploadAudioParser';
import type {
  UploadAudioFileRef,
  UploadAudioProgress,
  UploadAudioRequest,
  UploadAudioResult,
} from '../../src/types/uploadAudio';

const DEEPGRAM_LISTEN_URL = 'https://api.deepgram.com/v1/listen';
const REQUEST_TIMEOUT_MS = 20 * 60 * 1000;
const FILE_TOKEN_TTL_MS = 60 * 60 * 1000;
const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;
const SUPPORTED_EXTENSIONS = new Set([
  '.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.oga', '.opus',
  '.webm', '.mp4', '.mov', '.mkv',
]);

const CONTENT_TYPES: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.webm': 'audio/webm',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
};

interface RegisteredFile extends UploadAudioFileRef {
  path: string;
  registeredAt: number;
}

class UploadAudioError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

function ensureSupportedFile(filePath: string): { name: string; sizeBytes: number } {
  const resolved = path.resolve(filePath);
  const extension = path.extname(resolved).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(extension)) {
    throw new UploadAudioError('UNSUPPORTED_FILE', 'Choose a supported audio or video file.');
  }
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) throw new UploadAudioError('FILE_NOT_FOUND', 'The selected file is not available.');
  if (stat.size <= 0) throw new UploadAudioError('EMPTY_FILE', 'The selected file is empty.');
  if (stat.size > MAX_FILE_BYTES) {
    throw new UploadAudioError('FILE_TOO_LARGE', 'The selected file is larger than 2 GB.');
  }
  return { name: path.basename(resolved), sizeBytes: stat.size };
}

function normalizeRemoteUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new UploadAudioError('INVALID_URL', 'Enter a valid HTTPS audio or video URL.');
  }
  if (parsed.protocol !== 'https:') {
    throw new UploadAudioError('INVALID_URL', 'Only HTTPS audio or video URLs are supported.');
  }
  if (parsed.hostname === 'youtu.be' || parsed.hostname === 'youtube.com' || parsed.hostname.endsWith('.youtube.com')) {
    throw new UploadAudioError('YOUTUBE_NOT_SUPPORTED', 'YouTube links are not supported yet. Use a direct audio or video file URL.');
  }
  return parsed.toString();
}

function deepgramUrl(speakerDetection: boolean, language?: string): URL {
  const url = new URL(DEEPGRAM_LISTEN_URL);
  url.searchParams.set('model', 'nova-3');
  url.searchParams.set('smart_format', 'true');
  url.searchParams.set('paragraphs', 'true');
  url.searchParams.set('utterances', 'true');
  if (language && language !== 'auto') {
    url.searchParams.set('language', language);
  } else {
    url.searchParams.set('detect_language', 'true');
  }
  url.searchParams.set('mip_opt_out', 'true');
  if (speakerDetection) url.searchParams.set('diarize_model', 'latest');
  return url;
}

function postFileToDeepgram(filePath: string, apiKey: string, speakerDetection: boolean, language: string, signal: AbortSignal): Promise<any> {
  return new Promise((resolve, reject) => {
    const stat = fs.statSync(filePath);
    const extension = path.extname(filePath).toLowerCase();
    const request = https.request(deepgramUrl(speakerDetection, language), {
      method: 'POST',
      headers: {
        Authorization: `Token ${apiKey}`,
        'Content-Type': CONTENT_TYPES[extension] || 'application/octet-stream',
        'Content-Length': stat.size,
      },
    });
    const source = fs.createReadStream(filePath);
    let settled = false;

    const finishError = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const abort = () => {
      const error = new UploadAudioError('CANCELLED', 'Transcription was cancelled.');
      source.destroy(error);
      request.destroy(error);
      finishError(error);
    };
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener('abort', abort, { once: true });

    request.setTimeout(REQUEST_TIMEOUT_MS, () => {
      request.destroy(new UploadAudioError('TIMEOUT', 'Deepgram transcription timed out.'));
    });
    request.on('response', (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.on('end', () => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', abort);
        const body = Buffer.concat(chunks).toString('utf8');
        let parsed: any;
        try { parsed = JSON.parse(body); } catch { parsed = null; }
        if ((response.statusCode || 500) < 200 || (response.statusCode || 500) >= 300) {
          reject(new UploadAudioError(
            response.statusCode === 401 || response.statusCode === 403 ? 'DEEPGRAM_AUTH_FAILED' : 'DEEPGRAM_REQUEST_FAILED',
            parsed?.err_msg || parsed?.message || `Deepgram returned HTTP ${response.statusCode}.`,
          ));
          return;
        }
        resolve(parsed);
      });
    });
    request.on('error', finishError);
    source.on('error', finishError);
    source.pipe(request);
  });
}

async function postUrlToDeepgram(mediaUrl: string, apiKey: string, speakerDetection: boolean, language: string, signal: AbortSignal): Promise<any> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  if (signal.aborted) controller.abort();
  else signal.addEventListener('abort', onAbort, { once: true });

  try {
    const response = await fetch(deepgramUrl(speakerDetection, language), {
      method: 'POST',
      headers: {
        Authorization: `Token ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ url: mediaUrl }),
      signal: controller.signal,
    });
    const payload: any = await response.json().catch(() => null);
    if (!response.ok) {
      throw new UploadAudioError(
        response.status === 401 || response.status === 403 ? 'DEEPGRAM_AUTH_FAILED' : 'DEEPGRAM_REQUEST_FAILED',
        payload?.err_msg || payload?.message || `Deepgram returned HTTP ${response.status}.`,
      );
    }
    return payload;
  } catch (error) {
    if (signal.aborted) {
      throw new UploadAudioError('CANCELLED', 'Transcription was cancelled.');
    }
    if (controller.signal.aborted) {
      throw new UploadAudioError('TIMEOUT', 'Deepgram transcription timed out.');
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
    signal.removeEventListener('abort', onAbort);
  }
}

export class UploadAudioService {
  private readonly files = new Map<string, RegisteredFile>();
  private readonly active = new Map<string, AbortController>();

  async selectFile(): Promise<{ canceled: true } | ({ canceled: false } & UploadAudioFileRef)> {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Audio and video', extensions: [...SUPPORTED_EXTENSIONS].map((extension) => extension.slice(1)) }],
    });
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    return { canceled: false, ...this.registerFile(result.filePaths[0]) };
  }

  registerFile(filePath: string): UploadAudioFileRef {
    this.pruneFiles();
    const metadata = ensureSupportedFile(filePath);
    const token = crypto.randomUUID();
    this.files.set(token, { token, path: path.resolve(filePath), registeredAt: Date.now(), ...metadata });
    return { token, ...metadata };
  }

  cancel(requestId: string): boolean {
    const controller = this.active.get(requestId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  async transcribe(
    request: UploadAudioRequest,
    folderId: string | null,
    onProgress: (progress: UploadAudioProgress) => void,
  ): Promise<UploadAudioResult> {
    if (!request?.requestId || this.active.has(request.requestId)) {
      return { success: false, code: 'INVALID_REQUEST', error: 'The transcription request is invalid.' };
    }
    const apiKey = CredentialsManager.getInstance().getDeepgramApiKey()?.trim();
    if (!apiKey) {
      return { success: false, code: 'DEEPGRAM_KEY_MISSING', error: 'Add a Deepgram API key in Settings → Audio first.' };
    }
    const language = request.language || 'auto';

    const controller = new AbortController();
    this.active.set(request.requestId, controller);
    const emit = (stage: UploadAudioProgress['stage'], percent: number) => onProgress({ requestId: request.requestId, stage, percent });

    try {
      emit('preparing', 8);
      let payload: any;
      let sourceName: string;
      if (request.source.kind === 'file') {
        const registered = this.files.get(request.source.token);
        if (!registered || Date.now() - registered.registeredAt > FILE_TOKEN_TTL_MS) {
          throw new UploadAudioError('FILE_TOKEN_EXPIRED', 'Choose the file again before transcribing.');
        }
        ensureSupportedFile(registered.path);
        sourceName = registered.name;
        emit('uploading', 25);
        payload = await postFileToDeepgram(registered.path, apiKey, !!request.speakerDetection, language, controller.signal);
      } else {
        const mediaUrl = normalizeRemoteUrl(request.source.url);
        const parsed = new URL(mediaUrl);
        sourceName = decodeURIComponent(path.basename(parsed.pathname)) || parsed.hostname;
        emit('uploading', 20);
        payload = await postUrlToDeepgram(mediaUrl, apiKey, !!request.speakerDetection, language, controller.signal);
      }

      emit('transcribing', 82);
      const parsed = parseDeepgramUpload(payload, !!request.speakerDetection);
      const title = path.basename(sourceName, path.extname(sourceName)) || 'Uploaded audio';

      let meetingId: string | undefined;
      if (request.save !== false) {
        emit('saving', 94);
        meetingId = crypto.randomUUID();
        const startedAt = Date.now();
        const durationMs = Math.max(0, Math.round((parsed.durationSeconds || 0) * 1000));
        DatabaseManager.getInstance().saveMeeting({
          id: meetingId,
          title,
          date: new Date(startedAt).toISOString(),
          duration: '',
          summary: `Imported transcription · Deepgram Nova-3${parsed.detectedLanguage ? ` · ${parsed.detectedLanguage}` : ''}`,
          detailedSummary: {
            overview: 'Transcript imported from an audio or video file.',
            actionItems: [],
            keyPoints: [],
          },
          transcript: parsed.segments.map((segment) => ({
            speaker: segment.speaker,
            text: segment.text,
            // Stored transcripts use epoch milliseconds; retain Deepgram's
            // relative offset while making MeetingDetails render a real time.
            timestamp: startedAt + segment.startMs,
          })),
          usage: [],
          source: 'manual',
          isProcessed: true,
          summaryStatus: 'completed',
          folderId,
        }, startedAt, durationMs);
      }

      if (request.source.kind === 'file') this.files.delete(request.source.token);
      if (meetingId) {
        return { success: true, meetingId, title, ...parsed };
      }
      return { success: true, title, ...parsed };
    } catch (error) {
      const errorCode = error && typeof error === 'object' && 'code' in error
        ? String(error.code)
        : undefined;
      const code = errorCode
        || (controller.signal.aborted ? 'CANCELLED' : 'TRANSCRIPTION_FAILED');
      const message = error instanceof Error ? error.message : 'Audio transcription failed.';
      return { success: false, code, error: message };
    } finally {
      this.active.delete(request.requestId);
    }
  }

  private pruneFiles(): void {
    const cutoff = Date.now() - FILE_TOKEN_TTL_MS;
    for (const [token, file] of this.files) {
      if (file.registeredAt < cutoff) this.files.delete(token);
    }
  }
}
