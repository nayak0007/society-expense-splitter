import { mmkvStorage } from '@/lib/storage/mmkv';

/**
 * Non-sensitive session snapshot (SAD §5.2: "Session restore is
 * synchronous-first: MMKV holds a cached session snapshot read synchronously,
 * so the app renders the correct group on the first frame… This removes the
 * white flash that plagues token-restore flows on cold start").
 *
 * WHAT IS DELIBERATELY ABSENT: tokens, refresh tokens, and anything derived
 * from them. The snapshot says only *who* the session belonged to and whether
 * their email is verified — enough to paint the right screen — and every
 * privileged read still goes through Supabase with the real Session from
 * SecureStore (SAD §13.5: tokens never touch MMKV).
 *
 * A snapshot is a cache, never an authority: it is written when Supabase
 * reports a session, cleared on sign-out, and validated in the background
 * (`useSessionRestore`), which signs the user out if the token turns out to be
 * revoked or expired.
 */
export interface SessionSnapshot {
  readonly userId: string;
  readonly email: string | null;
  readonly emailVerified: boolean;
  readonly savedAt: string;
}

const SNAPSHOT_KEY = 'ses/session-snapshot';

export function readSessionSnapshot(): SessionSnapshot | null {
  const raw = mmkvStorage.getString(SNAPSHOT_KEY);
  if (raw === undefined || raw.length === 0) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<SessionSnapshot>;
    if (typeof parsed.userId !== 'string' || parsed.userId.length === 0) return null;
    return {
      userId: parsed.userId,
      email: typeof parsed.email === 'string' ? parsed.email : null,
      emailVerified: parsed.emailVerified === true,
      savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : new Date().toISOString(),
    };
  } catch {
    // Corrupt snapshot: treat as absent rather than crash on the first frame.
    return null;
  }
}

export function writeSessionSnapshot(snapshot: Omit<SessionSnapshot, 'savedAt'>): void {
  const payload: SessionSnapshot = { ...snapshot, savedAt: new Date().toISOString() };
  mmkvStorage.set(SNAPSHOT_KEY, JSON.stringify(payload));
}

export function clearSessionSnapshot(): void {
  mmkvStorage.remove(SNAPSHOT_KEY);
}
