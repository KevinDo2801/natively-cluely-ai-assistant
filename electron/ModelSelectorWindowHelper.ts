import { BrowserWindow, screen, app } from "electron"
import path from "node:path"
import { attachNoActivate } from "./utils/windowsFocusPolicy"
import { createWindowAdapter } from "./platform/windowAdapter"
import type { TimerSlot } from "./platform/windowAdapter"

const isDev = process.env.NODE_ENV === "development"

const startUrl = isDev
    ? "http://localhost:5180"
    : `file://${path.join(app.getAppPath(), "dist/index.html")}`

import type { WindowHelper } from "./WindowHelper"

type WindowActivationOptions = {
    activate?: boolean
}

export class ModelSelectorWindowHelper {
    private window: BrowserWindow | null = null
    private contentProtection: boolean = false
    private readonly adapter = createWindowAdapter();
    private readonly opacityTimer: TimerSlot = { current: null };

    constructor() { }

    private windowHelper: WindowHelper | null = null;

    // When opened from the MEETING OVERLAY: anchor stored relative to the
    // PANEL's left edge (the panel animates 600↔732 centered inside the
    // fixed overlay window) and the overlay's bottom edge, so the dropdown
    // follows drags, content-height growth, and the width spring. Driven by
    // WindowHelper.repositionOverlayPopovers().
    private overlayAnchor: { offsetXFromPanel: number; offsetY: number } | null = null;

    public setWindowHelper(wh: WindowHelper): void {
        this.windowHelper = wh;
    }

    public getWindow(): BrowserWindow | null {
        return this.window
    }

    public preloadWindow(): void {
        if (!this.window || this.window.isDestroyed()) {
            this.createWindow(-10000, -10000, false);
        }
    }

    public showWindow(x: number, y: number, options: WindowActivationOptions = {}): void {
        if (!this.window || this.window.isDestroyed()) {
            this.createWindow(x, y, true, options)
            return
        }

        const activate = options.activate ?? true;

        // Anchor to the window that actually hosts the toggle button. The
        // button lives in the chat OVERLAY, and the overlay can be the visible
        // surface while currentWindowMode is still 'launcher' (Ctrl+B / the
        // pill's Ask open the chat WITHOUT a mode swap), so getMainWindow()
        // returns the launcher in that state. Parenting to the launcher puts
        // the dropdown BELOW the always-on-top overlay on Windows
        // (screen-saver > topmost) and hides it with the launcher — the same
        // hit-or-miss the settings popup had. Use the overlay whenever it is
        // visible; fall back to getMainWindow() only when it is not.
        const overlayWin = this.windowHelper?.getOverlayWindow?.();
        const isOverlay = !!overlayWin && !overlayWin.isDestroyed() && overlayWin.isVisible();
        const mainWin = isOverlay ? overlayWin : (this.windowHelper?.getMainWindow() ?? null);

        if (mainWin && !mainWin.isDestroyed()) {
            this.window.setParentWindow(mainWin);
        }

        // macOS: re-sync the dropdown's workspace/alwaysOnTop per show (guarded
        // against NSApp-activation churn inside the adapter), MC always on.
        // (Phase 1 — delegated to the WindowAdapter; win32 no-op.)
        this.adapter.applyPopupReveal(this.window, isOverlay);

        // Standard dropdown positioning
        this.window.setPosition(Math.round(x), Math.round(y))
        this.ensureVisibleOnScreen();

        // Overlay-anchored open: remember the panel-relative offset (see field
        // comment) and arm the click-outside catcher.
        if (isOverlay && mainWin && !mainWin.isDestroyed()) {
            const bounds = mainWin.getBounds();
            const margin = this.windowHelper?.getOverlayPanelLeftMargin?.() ?? 0;
            this.overlayAnchor = {
                offsetXFromPanel: x - bounds.x - margin,
                offsetY: y - (bounds.y + bounds.height),
            };
        } else {
            this.overlayAnchor = null;
        }
        this.windowHelper?.notifyOverlayPopover?.('model', this.overlayAnchor !== null);

        // Platform reveal (Phase 1): win32 DWM opacity shield vs direct path —
        // identical behavior to the inline branches it replaces.
        this.adapter.showWithOpacityShield([this.window], {
            activate,
            contentProtection: this.contentProtection,
            timer: this.opacityTimer,
        });
    }

    public hideWindow(): void {
        if (this.window && !this.window.isDestroyed()) {
            this.window.setParentWindow(null);
            this.window.hide();
            // Do NOT call mainWin.focus() here — the model selector is a floating dropdown.
            // Explicitly focusing the main window steals OS focus from whatever the user
            // had active (Zoom, browser, etc.) before opening the selector.
        }
        this.windowHelper?.notifyOverlayPopover?.('model', false);
    }

    // Overlay-anchored variant of positioning: x tracks the PANEL's left edge
    // (overlay.x + live margin), y tracks the overlay's bottom edge.
    public repositionForOverlay(overlayBounds: Electron.Rectangle, panelLeftMargin: number): void {
        if (!this.overlayAnchor) return;
        if (!this.window || this.window.isDestroyed() || !this.window.isVisible()) return;
        this.window.setPosition(
            Math.round(overlayBounds.x + panelLeftMargin + this.overlayAnchor.offsetXFromPanel),
            Math.round(overlayBounds.y + overlayBounds.height + this.overlayAnchor.offsetY),
        );
    }

    public toggleWindow(x: number, y: number, options: WindowActivationOptions = {}): void {
        if (this.window && !this.window.isDestroyed()) {
            if (this.window.isVisible()) {
                this.hideWindow()
            } else {
                this.showWindow(x, y, options)
            }
        } else {
            this.createWindow(x, y, true, options)
        }
    }

    public closeWindow(): void {
        this.hideWindow();
    }

    private createWindow(
        x?: number,
        y?: number,
        showWhenReady: boolean = true,
        showOptions: WindowActivationOptions = {},
    ): void {
        const windowSettings: Electron.BrowserWindowConstructorOptions = {
            width: 140,
            height: 200,
            frame: false,
            transparent: true,
            resizable: false,
            fullscreenable: false,
            hasShadow: false,
            alwaysOnTop: true,
            backgroundColor: "#00000000",
            show: false,
            skipTaskbar: true,
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                preload: path.join(__dirname, "preload.js"),
                backgroundThrottling: false
            },
            // ROUND 3 FIX: type:'panel' makes this an NSPanel rather than a
            // regular NSWindow. Required for becomesKeyOnlyIfNeeded and
            // _setPreventsActivation: SPI calls in applyStealthToWindow to
            // actually take effect (those are NSPanel-only properties).
            // Without this, the previous applyStealthToWindow call was a
            // no-op and clicking the model selector still stole focus from
            // the user's foreground app.
            //
            // Close-on-outside is handled by the renderer's mousedown
            // capture handler (NativelyInterface.tsx) dispatching the
            // `model-selector:close-if-open` IPC, guarded against the
            // toggle button via `data-model-selector-toggle`.
            ...this.adapter.panelWindowOptions(),
        }

        if (x !== undefined && y !== undefined) {
            windowSettings.x = Math.round(x)
            windowSettings.y = Math.round(y)
        }

        this.window = new BrowserWindow(windowSettings)
        // macOS NSPanel stealth attributes, applied BEFORE the helper's own
        // ready-to-show so stealth precedes any show (Phase 1 — adapter).
        this.adapter.applyNativeStealth(this.window)
        // Windows counterpart of the NSPanel stealth attributes applied below
        // on macOS: WS_EX_NOACTIVATE so clicking the model selector mid-meeting
        // never steals foreground focus from the meeting app. Dismissal is the
        // overlay popover click-catcher (blur-close is intentionally not wired
        // here). No-op on macOS/Linux.
        attachNoActivate(this.window)

        // macOS: hide from Mission Control (initial; updated per-show in the
        // adapter's applyPopupReveal).
        this.adapter.applyStealth(this.window, { hiddenInMissionControl: true });

        // Apply content protection for Undetectable Mode
        console.log(`[ModelSelectorWindowHelper] Creating window with Content Protection: ${this.contentProtection}`);
        this.window.setContentProtection(this.contentProtection)

        // Load with query param for routing
        const url = isDev
            ? `${startUrl}?window=model-selector`
            : `${startUrl}?window=model-selector`

        this.window.loadURL(url).catch(e => {
            console.error('[ModelSelectorWindowHelper] Failed to load URL:', e);
        });

        this.window.once('ready-to-show', () => {
            // NSPanel stealth attributes are now applied by
            // this.adapter.applyNativeStealth() registered right after
            // `new BrowserWindow(...)` (above), which fires this listener
            // first — stealth before any show. The blur/close notes below
            // are preserved for context.
            if (showWhenReady) {
                this.showWindow(
                    this.window?.getBounds().x || 0,
                    this.window?.getBounds().y || 0,
                    showOptions,
                )
            }
        })

        // Close-on-blur is intentionally NOT wired up here. A per-window
        // blur listener fires on intra-app focus transfers (overlay ↔ panel),
        // which races with the toggle button's open path and produced the
        // historical "first click does nothing, second click opens" bug.
        // Three orthogonal close paths cover the legitimate cases instead:
        //   • renderer mousedown capture handler in NativelyInterface.tsx
        //     dispatches `model-selector:close-if-open` for overlay-internal
        //     outside clicks (guarded by data-model-selector-toggle).
        //   • main.ts subscribes to app.on('did-resign-active') (macOS) /
        //     'browser-window-blur' + getFocusedWindow()===null (win/linux)
        //     to auto-close when the user clicks any other application.
        //   • clicking a model in the list explicitly hides the panel via
        //     the set-active-model IPC.

        // ROUND 3 FIX (#1): stop the stealth tap when Model Selector shows,
        // mirroring the Settings handler. While brief (model selector is a
        // dropdown), interaction with the dropdown still requires keystrokes
        // to reach this window's React tree, which the tap would otherwise
        // intercept at OS level. (darwin stop now owned by the adapter.)
        this.adapter.stopStealthTapOnShow(this.window);
    }

    private ensureVisibleOnScreen() {
        if (!this.window) return;
        const { x, y, width, height } = this.window.getBounds();
        const display = screen.getDisplayNearestPoint({ x, y });
        const bounds = display.workArea;

        let newX = x;
        let newY = y;

        // Keep within horizontal bounds
        if (x + width > bounds.x + bounds.width) {
            newX = bounds.x + bounds.width - width;
        }
        if (x < bounds.x) {
            newX = bounds.x;
        }

        // Keep within vertical bounds
        if (y + height > bounds.y + bounds.height) {
            newY = bounds.y + bounds.height - height;
        }
        if (y < bounds.y) {
            newY = bounds.y;
        }

        this.window.setPosition(newX, newY);
    }

    public setContentProtection(enable: boolean): void {
        // Dedupe: see WindowHelper.setContentProtection rationale — repeated
        // identical calls are common (toggle IPC fans out across helpers) and
        // produce DWM affinity churn on Windows.
        if (this.contentProtection === enable && this.window && !this.window.isDestroyed()) return;
        console.log(`[ModelSelectorWindowHelper] Setting content protection to: ${enable}`);
        this.contentProtection = enable;
        if (this.window && !this.window.isDestroyed()) {
            this.window.setContentProtection(enable);
        }
    }

    // Force-reapply the current content-protection state, bypassing the dedupe
    // guard above. Called after app.dock.hide()/show() flips the macOS
    // activation policy, which can reset the window's sharingType even though
    // our in-memory flag is unchanged.
    public reassertContentProtection(): void {
        if (this.window && !this.window.isDestroyed()) {
            this.window.setContentProtection(this.contentProtection);
        }
    }

    public syncActivationPolicy(): void {
        if (!this.window || this.window.isDestroyed()) return;
        this.adapter.syncActivationPolicy(this.window, this.contentProtection);
    }
}
