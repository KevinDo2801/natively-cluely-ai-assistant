import React, { useEffect, useRef } from 'react';

/**
 * LauncherAnimShell — win32 taskbar show/hide animation for the launcher window.
 *
 * WHY TRANSFORMS, NOT setBounds: the launcher BrowserWindow stays at its final
 * size and position the whole time. Resizing a layered (transparent) native
 * window every animation frame is exactly what flickers on Windows, so the
 * main process never touches the window bounds for this. Instead this shell
 * transforms the entire launcher surface with CSS:
 *
 *   open:   translate(dx, dy) scale(0.25), opacity 0  →  identity, opacity 1
 *   close:  identity, opacity 1                        →  translate(dx, dy) scale(0.25), opacity 0
 *
 * `transform-origin` sits on the taskbar side (bottom-center by default), so
 * the surface visually grows out of the taskbar. The main process:
 *   1. shields the native window (setOpacity(0)) before the OS restore paints,
 *   2. sends `launcher-anim-open` and waits for this shell to paint the parked
 *      (closed) state — double rAF, then `launcherAnimOpenReady()`,
 *   3. reveals the window (setOpacity(1)) so the CSS transition is the first
 *      thing the user ever sees (no flash, no jump),
 *   4. on close, only minimizes/hides after `launcherAnimCloseDone()`.
 *
 * Timing/easing are the contract values the main process promises: 280ms with
 * cubic-bezier(0.16, 1, 0.3, 1) — a native-feeling ease-out with a fast start
 * and a smooth settle. `prefers-reduced-motion` snaps instead of animating.
 */
function LauncherAnimShell({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const animatingRef = useRef(false);

  useEffect(() => {
    // The launcher-animation IPC channels were removed from the main process;
    // keep this shell defensive so it compiles and degrades to a plain window
    // when the channels are absent (no animation events, no calls fire).
    const api = window.electronAPI as unknown as {
      launcherAnimOpenReady?: () => void;
      launcherAnimCloseDone?: () => void;
      onLauncherAnimOpen?: (cb: (p: any) => void) => (() => void) | undefined;
      onLauncherAnimClose?: (cb: (p: any) => void) => (() => void) | undefined;
    };
    const el = ref.current;
    if (!api || !el) return;

    const DURATION_MS = 280;
    const EASE = 'cubic-bezier(0.16, 1, 0.3, 1)';
    const reduceMotion =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    type Payload = { dx: number; dy: number; originX: string; originY: string; scale: number };

    const applyClosed = (p: Payload) => {
      el.style.transition = 'none';
      el.style.transformOrigin = `${p.originX} ${p.originY}`;
      el.style.transform = `translate(${p.dx}px, ${p.dy}px) scale(${p.scale})`;
      el.style.opacity = '0';
    };

    const onOpen = (p: Payload) => {
      if (animatingRef.current) return;
      animatingRef.current = true;
      applyClosed(p);
      // Paint the parked state while the window is still shielded (double rAF
      // guarantees a committed frame), then transition to identity.
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          api.launcherAnimOpenReady?.();
          if (reduceMotion) {
            el.style.transition = 'none';
            el.style.transform = 'translate(0, 0) scale(1)';
            el.style.opacity = '1';
          } else {
            el.style.transition = `transform ${DURATION_MS}ms ${EASE}, opacity ${DURATION_MS}ms ${EASE}`;
            el.style.transform = 'translate(0, 0) scale(1)';
            el.style.opacity = '1';
          }
          window.setTimeout(() => {
            animatingRef.current = false;
          }, DURATION_MS + 80);
        }),
      );
    };

    const onClose = (p: Payload) => {
      if (animatingRef.current) return;
      animatingRef.current = true;
      // Commit the identity state (no transition), then shrink to the taskbar.
      el.style.transition = 'none';
      el.style.transformOrigin = `${p.originX} ${p.originY}`;
      el.style.transform = 'translate(0, 0) scale(1)';
      el.style.opacity = '1';
      requestAnimationFrame(() => {
        if (reduceMotion) {
          applyClosed(p);
          animatingRef.current = false;
          api.launcherAnimCloseDone?.();
          return;
        }
        el.style.transition = `transform ${DURATION_MS}ms ${EASE}, opacity ${DURATION_MS}ms ${EASE}`;
        el.style.transform = `translate(${p.dx}px, ${p.dy}px) scale(${p.scale})`;
        el.style.opacity = '0';
        window.setTimeout(() => {
          animatingRef.current = false;
          api.launcherAnimCloseDone?.();
        }, DURATION_MS + 80);
      });
    };

    const offOpen = api.onLauncherAnimOpen?.(onOpen);
    const offClose = api.onLauncherAnimClose?.(onClose);
    return () => {
      offOpen?.();
      offClose?.();
    };
  }, []);

  return (
    <div ref={ref} className="h-full min-h-0 w-full relative bg-transparent">
      {children}
    </div>
  );
}

export default LauncherAnimShell;
