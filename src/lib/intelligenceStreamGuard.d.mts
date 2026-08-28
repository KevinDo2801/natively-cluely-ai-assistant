export interface StreamGuardState {
  adoptedId: number | null;
  claimedSurface: 'desktop' | 'phone' | null;
}

export function createStreamGuardState(): StreamGuardState;

export function resolveStreamToken(
  active: StreamGuardState,
  event: { generationId?: number | null; surface?: 'desktop' | 'phone' },
): { accept: boolean; active: StreamGuardState };

export function resolveStreamDone(
  active: StreamGuardState,
  event: { generationId?: number | null; surface?: 'desktop' | 'phone' },
): { honor: boolean; active: StreamGuardState; release: boolean };

export function resolveStreamError(
  active: StreamGuardState,
  event: { generationId?: number | null; surface?: 'desktop' | 'phone' },
): { accept: boolean; active: StreamGuardState; release: boolean };

export function claimStream(active: StreamGuardState, surface: 'desktop' | 'phone'): StreamGuardState;

export class IntelligenceStreamGuard {
  claim(event: { surface?: 'desktop' | 'phone' }): void;
  release(surface: 'desktop' | 'phone', intent?: string): void;
  resolve(event: {
    type?: 'start' | 'token' | 'done' | 'error' | 'meta' | string;
    streamKey?: string;
    surface?: 'desktop' | 'phone';
    intent?: string;
    generationId?: number | null;
  }): { accept: boolean; honor: boolean; release: boolean; active: StreamGuardState };
}
