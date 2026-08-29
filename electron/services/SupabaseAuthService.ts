/**
 * SupabaseAuthService — email + password authentication for the Natively
 * desktop app, backed by the project's Supabase instance.
 *
 * The app's identity layer ("Account" tab in Settings) is intentionally small:
 * sign up, sign in, sign out, reset password (via email link), and change
 * password. No business data is attached to the account yet — this service
 * only manages the auth session so the renderer can show who is signed in.
 *
 * Design notes:
 *   - The supabase-js client lives in the MAIN process (like CodexOAuthService),
 *     so the ANON key never touches the renderer and the session can be
 *     persisted with the OS keyring via CredentialsManager.
 *   - `persistSession: false` + `autoRefreshToken: false`: supabase-js never
 *     writes to localStorage (there is none in main). We restore the session
 *     from CredentialsManager on init() and re-persist on every auth-state
 *     change. For the identity-only v1 the access token is not used to fetch
 *     data, but a valid session is still required for `updateUser` (change
 *     password), so refreshSession() is called lazily before that write.
 *   - Email confirmation is REQUIRED on this project (mailer_autoconfirm=false),
 *     so signUp() normally returns { needsEmailConfirmation: true }. The
 *     confirmation + recovery emails both redirect to natively://auth/callback
 *     (a custom protocol registered in main.ts), so completing the link in the
 *     browser hands the session back to the app via handleDeepLink().
 *
 * EventEmitter signals (rebroadcast over IPC by ipcHandlers.ts):
 *   'changed'  — fires whenever signed-in status changes, with the status.
 *   'recovery' — fires after a recovery (password-reset) deep link is consumed
 *                so the renderer can surface the "set new password" form.
 *   'error'    — fires when a deep link cannot be consumed (expired/invalid).
 */

import { EventEmitter } from 'events';
import { createClient, type SupabaseClient, type Session } from '@supabase/supabase-js';

export interface SupabaseAuthStatus {
  signedIn: boolean;
  email?: string;
  userId?: string;
}

/** Persisted subset of a Supabase session (never the full JWT claims). */
export interface SupabaseSessionSnapshot {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms when the access token expires. */
  expiresAt: number;
  userId?: string;
  email?: string;
}

export type SupabaseAuthResult = {
  success: boolean;
  email?: string;
  needsEmailConfirmation?: boolean;
  error?: string;
};

/** Deep-link destination used by Supabase confirmation + recovery emails. */
export const SUPABASE_REDIRECT_URI = 'natively://auth/callback';

export class SupabaseAuthService extends EventEmitter {
  private static instance: SupabaseAuthService;

  private client: SupabaseClient | null = null;
  private cachedStatus: SupabaseAuthStatus = { signedIn: false };
  private initialized = false;

  private constructor() {
    super();
  }

  public static getInstance(): SupabaseAuthService {
    if (!SupabaseAuthService.instance) {
      SupabaseAuthService.instance = new SupabaseAuthService();
    }
    return SupabaseAuthService.instance;
  }

  /** For tests: reset in-memory state without touching persisted credentials. */
  public __resetForTest(): void {
    this.client = null;
    this.cachedStatus = { signedIn: false };
    this.initialized = false;
  }

  // ---------------------------------------------------------------------------
  // Client construction (lazy)
  // ---------------------------------------------------------------------------

  private getUrl(): string | undefined {
    return process.env.SUPABASE_URL || undefined;
  }

  private getAnonKey(): string | undefined {
    return process.env.SUPABASE_ANON_KEY || undefined;
  }

  private ensureClient(): SupabaseClient {
    if (this.client) return this.client;
    const url = this.getUrl();
    const key = this.getAnonKey();
    if (!url || !key) {
      throw new Error(
        'Supabase is not configured. Set SUPABASE_URL and SUPABASE_ANON_KEY in .env.',
      );
    }
    this.client = createClient(url, key, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    });
    return this.client;
  }

  // ---------------------------------------------------------------------------
  // Persistence — CredentialsManager (lazy)
  // ---------------------------------------------------------------------------

  private getCredentialsManager(): any | null {
    try {
      // Lazy require so test harnesses that stub this module don't pull the full
      // Electron app in at import time (same pattern as CodexOAuthService).
      const { CredentialsManager } = require('./CredentialsManager');
      return CredentialsManager.getInstance();
    } catch {
      return null;
    }
  }

  private loadFromStorage(): SupabaseSessionSnapshot | null {
    const cm = this.getCredentialsManager();
    if (!cm) return null;
    try {
      const raw = cm.getSupabaseSession?.() ?? null;
      if (!raw) return null;
      if (typeof raw.accessToken !== 'string' || typeof raw.refreshToken !== 'string') return null;
      return raw as SupabaseSessionSnapshot;
    } catch {
      return null;
    }
  }

  private saveToStorage(session: Session): void {
    const cm = this.getCredentialsManager();
    if (!cm) return;
    try {
      cm.setSupabaseSession?.({
        accessToken: session.access_token,
        refreshToken: session.refresh_token,
        expiresAt: (session.expires_at ?? 0) * 1000,
        userId: session.user?.id,
        email: session.user?.email,
      });
    } catch (e) {
      console.error('[SupabaseAuthService] Failed to persist session:', e);
    }
  }

  private clearStorage(): void {
    const cm = this.getCredentialsManager();
    if (!cm) return;
    try {
      cm.clearSupabaseSession?.();
    } catch {
      /* swallow */
    }
  }

  // ---------------------------------------------------------------------------
  // Init + status
  // ---------------------------------------------------------------------------

  private toStatus(session: Session | null): SupabaseAuthStatus {
    if (!session?.user) return { signedIn: false };
    return { signedIn: true, email: session.user.email, userId: session.user.id };
  }

  /**
   * Idempotent init. Restores a persisted session and wires auth-state changes
   * so the renderer always has a live view of who is signed in.
   */
  public init(): void {
    if (this.initialized) return;
    this.initialized = true;
    try {
      const client = this.ensureClient();

      const stored = this.loadFromStorage();
      if (stored?.accessToken && stored?.refreshToken) {
        client.auth
          .setSession({ access_token: stored.accessToken, refresh_token: stored.refreshToken })
          .catch((e) => console.warn('[SupabaseAuthService] Stored session restore failed:', e?.message));
      }

      client.auth.onAuthStateChange((event, session) => {
        if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
          if (session) this.saveToStorage(session);
          this.cachedStatus = this.toStatus(session);
          this.emit('changed', this.cachedStatus);
        } else if (event === 'SIGNED_OUT') {
          this.clearStorage();
          this.cachedStatus = { signedIn: false };
          this.emit('changed', this.cachedStatus);
        }
      });

      // Resolve the initial status (validates a restored session via getUser).
      this.refreshStatus().catch(() => {
        this.cachedStatus = this.toStatus(null);
      });
    } catch (e) {
      console.error('[SupabaseAuthService] init failed:', (e as Error)?.message);
    }
  }

  /** Synchronous status read. Safe to call from IPC without a network round-trip. */
  public getStatus(): SupabaseAuthStatus {
    return this.cachedStatus;
  }

  /**
   * Refresh the cached status from the server. Used on the Account tab mount so
   * a restored-but-expired session is reconciled instead of shown as signed-in.
   */
  public async refreshStatus(): Promise<SupabaseAuthStatus> {
    const client = this.ensureClient();
    let { data } = await client.auth.getSession();

    // A session restored by init()'s setSession() may still be settling; if the
    // in-memory session is empty but a persisted one exists, restore it again so
    // the Account tab never flashes "signed out" on a cold launch.
    if (!data.session) {
      const stored = this.loadFromStorage();
      if (stored?.accessToken && stored?.refreshToken) {
        const restored = await client.auth
          .setSession({ access_token: stored.accessToken, refresh_token: stored.refreshToken })
          .catch(() => null);
        if (restored?.data?.session) data = restored.data;
      }
    }

    if (!data.session) {
      this.cachedStatus = { signedIn: false };
      return this.cachedStatus;
    }
    this.saveToStorage(data.session);
    this.cachedStatus = this.toStatus(data.session);
    return this.cachedStatus;
  }

  // ---------------------------------------------------------------------------
  // Auth actions
  // ---------------------------------------------------------------------------

  public async signUp(email: string, password: string): Promise<SupabaseAuthResult> {
    const client = this.ensureClient();
    const { data, error } = await client.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: SUPABASE_REDIRECT_URI },
    });
    if (error) return { success: false, error: error.message };

    if (data.session) {
      this.saveToStorage(data.session);
      this.cachedStatus = this.toStatus(data.session);
      this.emit('changed', this.cachedStatus);
      return { success: true, email: data.user?.email };
    }
    // Email confirmation required (this project's default) — no session yet.
    return { success: true, needsEmailConfirmation: true, email: data.user?.email };
  }

  public async signIn(email: string, password: string): Promise<SupabaseAuthResult> {
    const client = this.ensureClient();
    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (error) return { success: false, error: error.message };
    this.saveToStorage(data.session);
    this.cachedStatus = this.toStatus(data.session);
    this.emit('changed', this.cachedStatus);
    return { success: true, email: data.user?.email };
  }

  public async signOut(): Promise<{ success: boolean; error?: string }> {
    try {
      const client = this.ensureClient();
      await client.auth.signOut();
      this.clearStorage();
      this.cachedStatus = { signedIn: false };
      this.emit('changed', this.cachedStatus);
      return { success: true };
    } catch (e) {
      return { success: false, error: (e as Error)?.message || String(e) };
    }
  }

  /** Sends a password-recovery email. The link lands back on the deep link. */
  public async resetPasswordForEmail(email: string): Promise<SupabaseAuthResult> {
    const client = this.ensureClient();
    const { error } = await client.auth.resetPasswordForEmail(email, {
      redirectTo: SUPABASE_REDIRECT_URI,
    });
    if (error) return { success: false, error: error.message };
    return { success: true, email };
  }

  /** Change the password of the currently signed-in user. */
  public async changePassword(newPassword: string): Promise<SupabaseAuthResult> {
    const client = this.ensureClient();

    // updateUser needs a valid session; refresh it first if it has lapsed so
    // the write doesn't 401 on an expired access token.
    const { data: sessionData } = await client.auth.getSession();
    if (!sessionData.session) {
      return { success: false, error: 'Not signed in. Please sign in again.' };
    }
    if (sessionData.session.expires_at && sessionData.session.expires_at * 1000 < Date.now() + 60_000) {
      const { error: refreshError } = await client.auth.refreshSession();
      if (refreshError) {
        return { success: false, error: 'Session expired. Please sign in again.' };
      }
    }

    const { error } = await client.auth.updateUser({ password: newPassword });
    if (error) return { success: false, error: error.message };
    return { success: true, email: this.cachedStatus.email };
  }

  // ---------------------------------------------------------------------------
  // Deep-link handling (confirmation + recovery redirects)
  // ---------------------------------------------------------------------------

  /**
   * Consume a natively://auth/callback deep link. The hash carries the session
   * tokens handed back by Supabase's hosted verify page:
   *   natively://auth/callback#access_token=...&refresh_token=...&type=recovery
   *
   * Resolves true when a session was established. Emits 'recovery' for
   * type=recovery so the renderer can open the "set new password" form.
   */
  public async handleDeepLink(url: string): Promise<boolean> {
    let hash = '';
    try {
      hash = new URL(url).hash.replace(/^#/, '');
    } catch {
      return false;
    }

    const params = new URLSearchParams(hash);
    const accessToken = params.get('access_token');
    const refreshToken = params.get('refresh_token');
    const type = params.get('type');

    if (params.get('error') || params.get('error_code')) {
      const reason = params.get('error_description') || params.get('error') || 'The link was invalid or expired.';
      this.emit('error', { message: reason });
      return false;
    }

    if (!accessToken || !refreshToken) {
      this.emit('error', { message: 'The link did not contain a valid session.' });
      return false;
    }

    const client = this.ensureClient();
    const { data, error } = await client.auth.setSession({
      access_token: accessToken,
      refresh_token: refreshToken,
    });
    if (error || !data.session) {
      this.emit('error', { message: error?.message || 'The link did not contain a valid session.' });
      return false;
    }

    this.saveToStorage(data.session);
    this.cachedStatus = this.toStatus(data.session);
    this.emit('changed', this.cachedStatus);
    if (type === 'recovery') {
      this.emit('recovery', { email: data.session.user?.email });
    }
    return true;
  }
}
