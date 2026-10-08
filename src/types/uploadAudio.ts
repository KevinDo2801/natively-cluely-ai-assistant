export type UploadAudioStage = 'preparing' | 'uploading' | 'transcribing' | 'saving';

export interface UploadAudioFileRef {
  token: string;
  name: string;
  sizeBytes: number;
}

export type UploadAudioSource =
  | { kind: 'file'; token: string }
  | { kind: 'url'; url: string };

export interface UploadAudioRequest {
  requestId: string;
  source: UploadAudioSource;
  speakerDetection: boolean;
  /** Deepgram language code (ISO 639-1, e.g. 'vi'). 'auto' → detect_language. */
  language?: string;
  /** When false, transcribe without persisting a meeting (view + copy only). Defaults to true when omitted. */
  save?: boolean;
}

export interface UploadAudioProgress {
  requestId: string;
  stage: UploadAudioStage;
  percent: number;
}

export interface UploadAudioSegment {
  speaker: string;
  text: string;
  startMs: number;
  endMs: number;
}

export type UploadAudioResult =
  | {
      success: true;
      /** Present only when the transcript was saved to My Natively. */
      meetingId?: string;
      title: string;
      transcript: string;
      detectedLanguage?: string;
      durationSeconds?: number;
      segments: UploadAudioSegment[];
    }
  | {
      success: false;
      code: string;
      error: string;
    };
