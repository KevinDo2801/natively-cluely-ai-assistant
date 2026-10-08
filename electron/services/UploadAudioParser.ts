import type { UploadAudioSegment } from '../../src/types/uploadAudio';

export class DeepgramUploadParseError extends Error {
  readonly code = 'NO_SPEECH';
}

function textFromWords(words: any[]): string {
  return words
    .map((word) => String(word?.punctuated_word || word?.word || '').trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+([,.;!?])/g, '$1')
    .trim();
}

export function parseDeepgramUpload(payload: any, speakerDetection: boolean): {
  transcript: string;
  detectedLanguage?: string;
  durationSeconds?: number;
  segments: UploadAudioSegment[];
} {
  const results = payload?.results;
  const alternative = results?.channels?.[0]?.alternatives?.[0];
  const plainTranscript = String(alternative?.transcript || '').trim();
  if (!plainTranscript) {
    throw new DeepgramUploadParseError('Deepgram did not detect speech in this file.');
  }

  const segments: UploadAudioSegment[] = [];
  const utterances = Array.isArray(results?.utterances) ? results.utterances : [];
  for (const utterance of utterances) {
    const text = String(utterance?.transcript || '').trim();
    if (!text) continue;
    const speakerNumber = Number.isFinite(utterance?.speaker) ? Number(utterance.speaker) + 1 : 1;
    segments.push({
      speaker: speakerDetection ? `Speaker ${speakerNumber}` : 'Audio',
      text,
      startMs: Math.max(0, Math.round(Number(utterance?.start || 0) * 1000)),
      endMs: Math.max(0, Math.round(Number(utterance?.end || 0) * 1000)),
    });
  }

  if (segments.length === 0 && speakerDetection && Array.isArray(alternative?.words)) {
    let current: any[] = [];
    let currentSpeaker: number | null = null;
    const flush = () => {
      if (current.length === 0) return;
      segments.push({
        speaker: `Speaker ${(currentSpeaker ?? 0) + 1}`,
        text: textFromWords(current),
        startMs: Math.round(Number(current[0]?.start || 0) * 1000),
        endMs: Math.round(Number(current[current.length - 1]?.end || 0) * 1000),
      });
      current = [];
    };
    for (const word of alternative.words) {
      const speaker = Number.isFinite(word?.speaker) ? Number(word.speaker) : 0;
      if (currentSpeaker !== null && speaker !== currentSpeaker) flush();
      currentSpeaker = speaker;
      current.push(word);
    }
    flush();
  }

  if (segments.length === 0) {
    segments.push({
      speaker: 'Audio',
      text: plainTranscript,
      startMs: 0,
      endMs: Math.max(0, Math.round(Number(payload?.metadata?.duration || 0) * 1000)),
    });
  }

  const transcript = speakerDetection
    ? segments.map((segment) => `${segment.speaker}: ${segment.text}`).join('\n\n')
    : plainTranscript;
  const channelDetected = results?.channels?.[0]?.detected_language;
  const alternativeLanguage = alternative?.languages?.[0]?.language;
  const detectedLanguage =
    (typeof channelDetected === 'string' ? channelDetected : undefined)
    || (typeof alternativeLanguage === 'string' ? alternativeLanguage : undefined)
    || payload?.metadata?.detected_language
    || undefined;

  return {
    transcript,
    detectedLanguage,
    durationSeconds: Number(payload?.metadata?.duration || 0) || undefined,
    segments,
  };
}
