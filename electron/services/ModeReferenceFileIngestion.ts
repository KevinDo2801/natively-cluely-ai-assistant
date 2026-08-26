// Shared production reference-file ingestion for Modes Manager uploads.
//
// The dialog IPC and the gated E2E benchmark ingress both call this use case so
// benchmark parsing/persistence cannot silently drift from the user-facing path.
//
// Senior-review fix (2026-07-16, audit ab9dc2f0): this module previously
// duplicated the SAFE_DOCUMENT_EXTENSIONS format list, BOM/symlink safety,
// PDF worker pin, and PDF/DOCX/text parsing. Migrated to the shared
// SafeDocumentTextExtractor.extractSafeDocumentText so a format/safety
// fix in the shared utility automatically applies here AND to the
// Profile Intelligence upload path (which has used it since commit
// 41edd51). The
// MODE_REFERENCE_FILE_EXTENSIONS / MODE_REFERENCE_FILE_MAX_BYTES exports
// remain ON the file (re-exported from the shared utility) so callers
// that imported them from this module keep working.

import * as crypto from 'crypto';
import { ModesManager } from './ModesManager';
import {
  extractSafeDocumentText,
  SAFE_DOCUMENT_EXTENSIONS,
  SAFE_DOCUMENT_MAX_BYTES,
} from './SafeDocumentTextExtractor';

// Retain the Modes-facing exports while sharing one document-format contract.
export const MODE_REFERENCE_FILE_EXTENSIONS = SAFE_DOCUMENT_EXTENSIONS;
export const MODE_REFERENCE_FILE_MAX_BYTES = SAFE_DOCUMENT_MAX_BYTES;

// Cap for pasted reference text ("Add text" in Modes Manager). Roughly 25K
// tokens — plenty for notes/pasted material, well inside the retrieval caps
// (12K chars/file inline, 40K total) while still allowing a pasted doc to be
// chunked + embedded like an uploaded file.
export const MODE_REFERENCE_FILE_MAX_CHARS = 100_000;

export interface ModeReferenceFileIngestResult {
  id: string;
  fileName: string;
  /**
   * Extracted text content. Bug fix (2026-07-26): this was previously
   * omitted from the returned result, even though it was fully available
   * (`extracted.content`) — the renderer pushes this result straight into
   * its `referenceFiles` list (ModesSettings.tsx's `uploadFile`) and then
   * renders `file.content.length` unconditionally, so every successful
   * upload crashed the Modes settings panel until the next full reload
   * (which re-fetches via `modes:get-reference-files`, whose `rowToFile`
   * mapping always included `content`).
   */
  content: string;
  pageCount?: number;
  extractedPageCount?: number;
  binarySha256: string;
  contentSha256: string;
}

export interface ModeReferenceFileIngestOptions {
  modeId: string;
  filePath: string;
  onIndexStatus?: (status: 'indexing' | 'done', fileId: string) => void;
}

/**
 * Parse, persist, and begin indexing a user-selected regular file. Callers must
 * perform UI/authorization policy; this use case delegates file safety, format
 * checks, and PDF/DOCX/text parsing to the shared SafeDocumentTextExtractor.
 */
export const ingestModeReferenceFile = async (
  options: ModeReferenceFileIngestOptions,
): Promise<ModeReferenceFileIngestResult> => {
  const extracted = await extractSafeDocumentText(options.filePath);
  const contentSha256 = crypto.createHash('sha256').update(extracted.content).digest('hex');
  const manager = ModesManager.getInstance();
  const file = manager.addReferenceFile({
    modeId: options.modeId,
    fileName: extracted.fileName,
    content: extracted.content,
    pageCount: extracted.pageCount,
    extractedPageCount: extracted.extractedPageCount,
  });

  options.onIndexStatus?.('indexing', file.id);
  void (async () => {
    try {
      await manager.indexReferenceFile(file);
      const finalStatus = manager.getReferenceFileIndexStatus(file.id);
      if (finalStatus?.status === 'failed' || finalStatus?.status === 'lexical_only') {
        // The caller's application lifecycle owns retries; this preserves the
        // normal upload's non-blocking response behavior.
      }
    } catch (error: any) {
      console.warn('[ModeReferenceFileIngestion] index failed (lexical fallback remains):', error?.message);
    } finally {
      options.onIndexStatus?.('done', file.id);
    }
  })();

  return {
    id: file.id,
    fileName: extracted.fileName,
    content: extracted.content,
    pageCount: extracted.pageCount,
    extractedPageCount: extracted.extractedPageCount,
    binarySha256: extracted.binarySha256,
    contentSha256,
  };
};

export interface ModeReferenceFileContentIngestOptions {
  modeId: string;
  /** Optional user-chosen name. When empty, a default "Pasted text N" is generated. */
  fileName?: string;
  content: string;
  pageCount?: number;
  extractedPageCount?: number;
  onIndexStatus?: (status: 'indexing' | 'done', fileId: string) => void;
  /** When true, await indexing before returning (E2E/benchmark use); production paste is fire-and-forget like uploads. */
  awaitIndex?: boolean;
}

/**
 * Persist + index raw reference text (the Modes Manager "Add text" path and the
 * E2E content ingress). Same storage/indexing pipeline as ingestModeReferenceFile:
 * rows go through ModesManager.addReferenceFile (chunk + OKF pack handling), then
 * best-effort indexReferenceFile with the retriever degrading to lexical for any
 * file that isn't 'ready' yet. Callers perform UI/authorization policy.
 */
export const ingestModeReferenceFileContent = async (
  options: ModeReferenceFileContentIngestOptions,
): Promise<ModeReferenceFileIngestResult> => {
  const content = options.content?.trim() ?? '';
  if (!content) throw new Error('Reference text is empty.');
  if (content.length > MODE_REFERENCE_FILE_MAX_CHARS) {
    throw new Error(`Reference text exceeds the ${MODE_REFERENCE_FILE_MAX_CHARS.toLocaleString()} character limit.`);
  }
  const manager = ModesManager.getInstance();
  const fileName = (options.fileName ?? '').trim() || defaultPastedTextName(manager, options.modeId);
  const file = manager.addReferenceFile({
    modeId: options.modeId,
    fileName,
    content,
    ...(typeof options.pageCount === 'number' ? { pageCount: options.pageCount } : {}),
    ...(typeof options.extractedPageCount === 'number'
      ? { extractedPageCount: options.extractedPageCount }
      : typeof options.pageCount === 'number'
        ? { extractedPageCount: options.pageCount }
        : {}),
  });
  const contentSha256 = crypto.createHash('sha256').update(content).digest('hex');
  const index = async (): Promise<void> => {
    try {
      await manager.indexReferenceFile(file);
    } catch (error: any) {
      console.warn('[ModeReferenceFileIngestion] pasted-text index failed (lexical fallback remains):', error?.message);
    } finally {
      options.onIndexStatus?.('done', file.id);
    }
  };
  options.onIndexStatus?.('indexing', file.id);
  if (options.awaitIndex) await index();
  else void index();
  return {
    id: file.id,
    fileName: file.fileName,
    content: file.content,
    pageCount: file.pageCount,
    extractedPageCount: file.extractedPageCount,
    binarySha256: '',
    contentSha256,
  };
};

/** "Pasted text 1", "Pasted text 2", … — first unused number among the mode's files. */
function defaultPastedTextName(manager: ModesManager, modeId: string): string {
  const existing = new Set(manager.getReferenceFiles(modeId).map((f) => f.fileName));
  let n = 1;
  while (existing.has(`Pasted text ${n}`)) n += 1;
  return `Pasted text ${n}`;
}