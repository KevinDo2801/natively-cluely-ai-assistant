/**
 * Live "Active Session" timer anchor.
 *
 * The pill timer (now rendered once, globally, by the Launcher) measures from
 * the moment the CURRENT recording session really began. That anchor lives in
 * two places:
 *
 *   1. localStorage['natively_last_meeting_start'] — written at Start/Continue
 *      clicks and cleared on renderer-side Stop (App.tsx handleStartMeeting /
 *      handleEndMeeting, MeetingDetails handleContinueSession). Meetings
 *      started or stopped through main-only paths (global hotkey
 *      Ctrl/Cmd+Shift+\, calendar auto-start) never touch it, so it can hold a
 *      STALE anchor from an earlier meeting.
 *
 *   2. The live meeting row's start (`meetings.start_time`, surfaced as
 *      Meeting.date) — created by the main process inside the start pipeline,
 *      so it is always the true start of THIS meeting.
 *
 * The stale localStorage anchor was the source of the phantom
 * "800–900 minutes at the very start of a meeting" timer: the pill computed
 * `Date.now() - staleAnchor` with an anchor left over from a previous day.
 *
 * Resolution rule: a legitimate anchor is NEVER older than the live row —
 *   • fresh start: the row is created inside the start pipeline AFTER the
 *     click that wrote the key (permission waits push the row later, never
 *     earlier), so the row start is the real session start;
 *   • resume ("Continue this session"): the row keeps its ORIGINAL start while
 *     the key holds the resume click, which is newer.
 * Therefore the later of the two is this session's start; a stale key from an
 * earlier meeting is always older than the row and gets discarded.
 */

export const LIVE_SESSION_START_KEY = 'natively_last_meeting_start';

export function resolveLiveSessionStartMs(
  rowStartIso?: string | null,
  storage?: Pick<Storage, 'getItem'> | null,
): number {
  const store = storage ?? (typeof localStorage === 'undefined' ? null : localStorage);
  let storedMs = Number.NaN;
  if (store) {
    const stored = store.getItem(LIVE_SESSION_START_KEY);
    if (stored) {
      const n = parseInt(stored, 10);
      if (Number.isFinite(n) && n > 0) storedMs = n;
    }
  }
  const rowMs = rowStartIso ? Date.parse(rowStartIso) : Number.NaN;
  const validRow = Number.isFinite(rowMs) && rowMs > 0;

  if (Number.isFinite(storedMs) && validRow) {
    return Math.max(storedMs, rowMs);
  }
  if (validRow) return rowMs;
  if (Number.isFinite(storedMs)) return storedMs;
  return Date.now();
}
