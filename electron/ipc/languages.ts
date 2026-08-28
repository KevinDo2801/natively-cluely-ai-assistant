// ============================================================================
// IPC: Language settings (Phase 2).
// ============================================================================

import { safeHandle } from './safeIpc';
import { AI_RESPONSE_LANGUAGES, RECOGNITION_LANGUAGES } from '../config/languages';

export interface LanguagesDeps {
  /** Optional LLM helper whose in-memory language should follow the persisted value. */
  processingHelper?: {
    getLLMHelper?(): { setAiResponseLanguage(language: string): void };
  };
}

export function registerLanguageHandlers(deps: LanguagesDeps): void {
  safeHandle('get-recognition-languages', async () => {
    return RECOGNITION_LANGUAGES;
  });

  safeHandle('get-ai-response-languages', async () => {
    return AI_RESPONSE_LANGUAGES;
  });

  safeHandle('set-ai-response-language', async (_event, language: string) => {
    // Validate: must be a non-empty string
    if (!language || typeof language !== 'string' || !language.trim()) {
      console.warn('[IPC] set-ai-response-language: invalid or empty language received, ignoring.');
      return { success: false, error: 'Invalid language value' };
    }
    const sanitizedLanguage = language.trim();
    const { CredentialsManager } = require('../services/CredentialsManager');
    // Persist to disk
    CredentialsManager.getInstance().setAiResponseLanguage(sanitizedLanguage);
    // Update live in-memory LLMHelper (same instance used by IntelligenceEngine)
    const llmHelper = deps.processingHelper?.getLLMHelper?.();
    if (llmHelper) {
      llmHelper.setAiResponseLanguage(sanitizedLanguage);
      console.log(`[IPC] AI response language updated to: ${sanitizedLanguage}`);
    } else {
      console.warn(
        '[IPC] set-ai-response-language: processingHelper or LLMHelper not ready, language saved to disk only.',
      );
    }
    return { success: true };
  });

  safeHandle('get-stt-language', async () => {
    const { CredentialsManager } = require('../services/CredentialsManager');
    return CredentialsManager.getInstance().getSttLanguage();
  });

  safeHandle('get-ai-response-language', async () => {
    const { CredentialsManager } = require('../services/CredentialsManager');
    return CredentialsManager.getInstance().getAiResponseLanguage();
  });
}
