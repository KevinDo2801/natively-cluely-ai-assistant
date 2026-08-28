import { BrowserWindow, screen, app } from "electron"
import { WindowHelper } from "./WindowHelper"
import path from "node:path"
import { attachNoActivate } from "./utils/windowsFocusPolicy"
import { createWindowAdapter } from "./platform/windowAdapter"
import type { TimerSlot } from "./platform/windowAdapter"

const isDev = process.env.NODE_ENV === "development"

const startUrl = isDev
    ? "http://localhost:5180"
    : `file://${path.join(app.getAppPath(), "dist/index.html")}`

type WindowActivationOptions = {
    activate?: boolean
}

export class SettingsWindowHelper {
    private settingsWindow: BrowserWindow | null = null
    private windowHelper: WindowHelper | null = null;
    private readonly adapter = createWindowAdapter();
    private readonly opacityTimer: TimerSlot = { current: null };

    public getSettingsWindow(): BrowserWindow | null {
        return this.settingsWindow
    }

    public setWindowDimensions(win: BrowserWindow, width: number, height: number): void {
        if (!win || win.isDestroyed() || !win.isVisible()) return

        const currentBounds = win.getBounds()
        // Only update if dimensions actually change (avoid infinite loops)
        if (currentBounds.width === width && currentBounds.height === height) return

        win.setSize(width, height)
    }

    // Store offsets relative to main window
    private offsetX: number = 0
    private offsetY: number = 0

    // When opened from the MEETING OVERLAY, the anchor is stored relative to
    // the PANEL (offsetXFromPanel is measured from the panel's left edge =
    // overlay.x + live left margin), not the raw window — the panel animates
    // 600↔732 centered inside the fixed overlay window, so a window-relative
    // offset would leave the dropdown behind when the width spring runs.
    // WindowHelper.repositionOverlayPopovers() drives repositionForOverlay()
    // on every overlay move/resize and panel-width anchor update.
    private overlayAnchor: { offsetXFromPanel: number; offsetY: number } | null = null

    private lastBlurTime: number = 0
    private ignoreBlur: boolean = false;

    constructor() { }

    public setIgnoreBlur(ignore: boolean): void {
        this.ignoreBlur = ignore;
    }

    /**
     * Clear the blur-reopen guard (lastBlurTime). Called whenever the overlay
     * re-shows: a blur timestamp stamped by the PREVIOUS overlay-hide close is
     * stale the moment the overlay is back, but toggleWindow()'s 250ms guard
     * would still swallow a fast settings re-open made right after bringing
     * the chat overlay back ("settings popup works sometimes — hit-or-miss").
     */
    public clearBlurGuard(): void {
        this.lastBlurTime = 0;
    }

    /**
     * Pre-create the settings window in the background (hidden) for faster first open
     */
    public preloadWindow(): void {
        if (!this.settingsWindow || this.settingsWindow.isDestroyed()) {
            // Create window off-screen so it's ready but not visible
            this.createWindow(-10000, -10000, false);
        }
    }

    public setWindowHelper(wh: WindowHelper): void {
        this.windowHelper = wh;
    }

    public toggleWindow(x?: number, y?: number): void {
        // Anchor to the window that actually hosts the popup button. The button
        // lives in the chat OVERLAY, and the overlay can be the visible surface
        // while currentWindowMode is still 'launcher' (Ctrl+B / the pill's Ask
        // open the chat WITHOUT a mode swap), so getMainWindow() — which
        // returns the launcher in 'launcher' mode — is NOT a reliable anchor:
        // parenting to the launcher puts the popup BELOW the always-on-top
        // overlay on Windows (screen-saver > topmost) and hides it with the
        // launcher ("settings works only while the launcher is up").
        const overlayWin = this.windowHelper?.getOverlayWindow?.();
        const anchorWin =
            overlayWin && !overlayWin.isDestroyed() && overlayWin.isVisible()
                ? overlayWin
                : (this.windowHelper?.getMainWindow() ?? null);
        if (anchorWin && !anchorWin.isDestroyed() && x !== undefined && y !== undefined) {
            const bounds = anchorWin.getBounds();
            this.offsetX = x - bounds.x;
            this.offsetY = y - (bounds.y + bounds.height);
            if (anchorWin === overlayWin) {
                const margin = this.windowHelper?.getOverlayPanelLeftMargin?.() ?? 0;
                this.overlayAnchor = {
                    offsetXFromPanel: x - bounds.x - margin,
                    offsetY: y - (bounds.y + bounds.height),
                };
            } else {
                this.overlayAnchor = null;
            }
        }

        if (this.settingsWindow && !this.settingsWindow.isDestroyed()) {
            // Fix: If window was just closed by blur (e.g. clicking the toggle button), don't re-open immediately
            if (!this.settingsWindow.isVisible() && (Date.now() - this.lastBlurTime < 250)) {
                return;
            }

            if (this.settingsWindow.isVisible()) {
                this.closeWindow(); // Use closeWindow to handle focus restore
            } else {
                this.showWindow(x, y)
            }
        } else {
            this.createWindow(x, y)
        }
    }

    public showWindow(x?: number, y?: number, options: WindowActivationOptions = {}): void {
        if (!this.settingsWindow || this.settingsWindow.isDestroyed()) {
            this.createWindow(x, y)
            return
        }

        const activate = options.activate ?? true;

        // Parent to the OVERLAY when it is the visible host (see toggleWindow:
        // the popup button lives in the overlay, and the overlay can be up while
        // currentWindowMode is still 'launcher'). Parenting to the launcher in
        // that state puts the popup below the always-on-top overlay on Windows
        // and hides it with the launcher.
        const overlayWin = this.windowHelper?.getOverlayWindow?.();
        const anchorWin =
            overlayWin && !overlayWin.isDestroyed() && overlayWin.isVisible()
                ? overlayWin
                : (this.windowHelper?.getMainWindow() ?? null);
        if (anchorWin && !anchorWin.isDestroyed()) {
            this.settingsWindow.setParentWindow(anchorWin);
        }

        if (x !== undefined && y !== undefined) {
            this.settingsWindow.setPosition(Math.round(x), Math.round(y))
        }

        // Ensure fully visible on screen
        this.ensureVisibleOnScreen();

        // Platform reveal (Phase 1): the WindowAdapter owns the win32 DWM
        // opacity shield vs the direct darwin/win32-no-CP path. Behavior is
        // identical to the inline branches it replaces.
        this.adapter.showWithOpacityShield([this.settingsWindow], {
            activate,
            contentProtection: this.contentProtection,
            timer: this.opacityTimer,
        });

        this.emitVisibilityChange(true);

        // Settings staleness fix (2026-08-21): this window is created once at
        // app start and only hidden/shown afterwards, so its React tree's
        // mount-time fetches (credentials, profile, toggle initial
        // states) go stale across shows. The renderer's focus-refresh never
        // fires on the overlay-anchored popover path (showInactive). Tell the
        // renderer it was just shown so it can re-pull main-process state.
        try {
            this.settingsWindow.webContents.send('settings-window-shown');
        } catch { /* renderer not ready — mount fetch covers first open */ }
    }

    public reposition(mainBounds: Electron.Rectangle): void {
        if (!this.settingsWindow || !this.settingsWindow.isVisible() || this.settingsWindow.isDestroyed()) return;

        const newX = mainBounds.x + this.offsetX;
        const newY = mainBounds.y + mainBounds.height + this.offsetY;

        this.settingsWindow.setPosition(Math.round(newX), Math.round(newY));
    }

    // Overlay-anchored variant: x tracks the PANEL's left edge (overlay.x +
    // live margin), y tracks the overlay's bottom edge. Only applies when the
    // dropdown was opened from the overlay.
    public repositionForOverlay(overlayBounds: Electron.Rectangle, panelLeftMargin: number): void {
        if (!this.overlayAnchor) return;
        if (!this.settingsWindow || !this.settingsWindow.isVisible() || this.settingsWindow.isDestroyed()) return;
        this.settingsWindow.setPosition(
            Math.round(overlayBounds.x + panelLeftMargin + this.overlayAnchor.offsetXFromPanel),
            Math.round(overlayBounds.y + overlayBounds.height + this.overlayAnchor.offsetY),
        );
    }

    public closeWindow(): void {
        if (this.settingsWindow && !this.settingsWindow.isDestroyed()) {
            // Break the parent link BEFORE hiding — the exact pattern
            // ModelSelectorWindowHelper.hideWindow() already uses. On Windows
            // the settings window is an OWNED window of the overlay
            // (setParentWindow in showWindow): hiding the owner auto-hides the
            // owned window, and re-showing an owned window that was taken down
            // by its owner can leave it in a state where it stops receiving
            // clicks ("settings popup opens but clicks do nothing" after the
            // chat overlay is hidden and re-shown). Un-parenting first lets the
            // next showWindow() re-establish the relationship from a clean
            // slate. Harmless on macOS (NSPanel parenting is re-applied on
            // every show) and while the owner stays visible (hide works the
            // same with or without a parent).
            this.settingsWindow.setParentWindow(null);
            this.settingsWindow.hide()
            this.emitVisibilityChange(false);
        }
    }

    private emitVisibilityChange(isVisible: boolean): void {
        // Drive the overlay click-catcher: an overlay-anchored settings
        // dropdown must be dismissible by clicking anywhere outside Natively.
        this.windowHelper?.notifyOverlayPopover?.('settings', isVisible && this.overlayAnchor !== null);
        const mainWindow = this.windowHelper?.getMainWindow() ?? null;
        if (!mainWindow) {
            console.warn('[SettingsWindowHelper] settings-visibility-changed dropped — no main window bound yet.');
            return;
        }
        if (mainWindow.isDestroyed()) return;
        try {
            mainWindow.webContents.send('settings-visibility-changed', isVisible);
        } catch {
            // Renderer is tearing down; ignore.
        }
    }

    private createWindow(x?: number, y?: number, showWhenReady: boolean = true): void {
        const windowSettings: Electron.BrowserWindowConstructorOptions = {
            width: 180, // Match React component width (SettingsPopup.tsx)
            height: 200, // Trimmed; ResizeObserver in renderer pins exact height
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
                backgroundThrottling: false // Keep window ready even when hidden
            },
            // ROUND 3 FIX: type: 'panel' is what makes this an NSPanel rather
            // than a regular NSWindow. WITHOUT it, the becomesKeyOnlyIfNeeded
            // and _setPreventsActivation: SPI calls in applyStealthToWindow
            // are no-ops (those are NSPanel-only properties — respondsToSelector
            // returns false on a plain NSWindow). The previous fix only added
            // applyStealthToWindow without the underlying panel type, which is
            // why focus theft persisted. NSPanel + type:'panel' = the same
            // Spotlight/Alfred mechanism the overlay uses.
            ...this.adapter.panelWindowOptions(),
        }

        if (x !== undefined && y !== undefined) {
            windowSettings.x = Math.round(x)
            windowSettings.y = Math.round(y)
        }

        this.settingsWindow = new BrowserWindow(windowSettings)
        // macOS NSPanel stealth attributes (becomesKeyOnlyIfNeeded +
        // _setPreventsActivation), applied BEFORE the helper's own
        // ready-to-show so stealth precedes any show.
        this.adapter.applyNativeStealth(this.settingsWindow)
        // Windows counterpart of the NSPanel stealth attributes applied above
        // on macOS: WS_EX_NOACTIVATE so opening/clicking the settings popover
        // mid-meeting never steals foreground focus from the meeting app.
        // Typing in its fields is granted transiently by the preload focusin
        // bridge (see windowsFocusPolicy). Dismissal does not rely on 'blur'
        // for the never-focused case — the overlay popover click-catcher
        // handles outside clicks on all platforms. No-op on macOS/Linux.
        attachNoActivate(this.settingsWindow)

        // macOS: join all Spaces + Mission Control + keep on top (Phase 1 —
        // delegated to the WindowAdapter; darwin-only by construction).
        this.adapter.applyStealth(this.settingsWindow, {
            visibleOnAllWorkspaces: true,
            hiddenInMissionControl: true,
            alwaysOnTop: true,
            alwaysOnTopLevel: 'floating',
        });

        console.log(`[SettingsWindowHelper] Creating Settings Window with Content Protection: ${this.contentProtection}`);
        this.settingsWindow.setContentProtection(this.contentProtection);

        // Load with query param
        const settingsUrl = isDev
            ? `${startUrl}?window=settings`
            : `${startUrl}?window=settings` // file url also works with search params in modern Electron

        this.settingsWindow.loadURL(settingsUrl).catch(e => {
            console.error('[SettingsWindowHelper] Failed to load URL:', e);
        });

        this.settingsWindow.once('ready-to-show', () => {
            // NSPanel stealth attributes are now applied by
            // this.adapter.applyNativeStealth() registered right after
            // `new BrowserWindow(...)` (above), which fires this listener
            // first — stealth before any show. Nothing left to do here.
            if (showWhenReady) {
                this.showWindow(this.settingsWindow?.getBounds().x || 0, this.settingsWindow?.getBounds().y || 0)
            }
        })

        // Hide on blur instead of close, to keep state?
        // Or just let user close it.
        // User asked for "independent window", maybe sticky?
        // Let's keep it simple: clicks outside close it if we want "popover" behavior.
        // For now, let it stay open until toggled or ESC.
        this.settingsWindow.on('blur', () => {
            if (this.ignoreBlur) return;
            this.lastBlurTime = Date.now();
            this.closeWindow();
        })

        // ROUND 3 FIX (#1): when Settings becomes visible, stop the
        // CGEventTap. Otherwise the tap intercepts every plain keystroke at
        // OS level and routes them into Natively's chat input — the user
        // can't type API keys (or anything) into Settings fields. Settings
        // input is a long-form interaction; stealth-typing-into-overlay is
        // not what the user wants here. They can re-engage with the hotkey
        // after Settings closes. (darwin stop delegated to the adapter's
        // stopStealthTapOnShow, registered below.)
        this.settingsWindow.on('show', () => {
            // ROUND 4 FIX (#7): reset blur timestamp on every successful
            // show. Without this, a stale lastBlurTime from a prior session
            // (or from a brief NSPanel-nonactivating blur that did fire)
            // can keep the 250ms toggle-protection guard hot indefinitely,
            // suppressing legitimate user re-toggles. Resetting at show
            // time bounds the guard to "the LAST blur" rather than "any
            // blur ever observed."
            this.lastBlurTime = 0;
        });
        this.adapter.stopStealthTapOnShow(this.settingsWindow);


    }



    private ensureVisibleOnScreen() {
        if (!this.settingsWindow) return;
        const { x, y, width, height } = this.settingsWindow.getBounds();
        const display = screen.getDisplayNearestPoint({ x, y });
        const bounds = display.workArea;

        let newX = x;
        let newY = y;

        if (x + width > bounds.x + bounds.width) {
            newX = bounds.x + bounds.width - width;
        }
        if (y + height > bounds.y + bounds.height) {
            newY = bounds.y + bounds.height - height;
        }

        this.settingsWindow.setPosition(newX, newY);
    }
    private contentProtection: boolean = false; // Track state

    public setContentProtection(enable: boolean): void {
        // Dedupe: avoid redundant DWM affinity churn on Windows when the same
        // value is reapplied (settings IPC + show events + global toggles all
        // converge here). The first call still hits both the in-memory state
        // and the native window; later identical calls no-op.
        if (this.contentProtection === enable && this.settingsWindow && !this.settingsWindow.isDestroyed()) return;
        console.log(`[SettingsWindowHelper] Setting content protection to: ${enable}`);
        this.contentProtection = enable;

        if (this.settingsWindow && !this.settingsWindow.isDestroyed()) {
            this.settingsWindow.setContentProtection(enable);
        }
    }

    // Force-reapply the current content-protection state, bypassing the dedupe
    // guard above. Called after app.dock.hide()/show() flips the macOS
    // activation policy, which can reset the window's sharingType even though
    // our in-memory flag is unchanged.
    public reassertContentProtection(): void {
        if (this.settingsWindow && !this.settingsWindow.isDestroyed()) {
            this.settingsWindow.setContentProtection(this.contentProtection);
        }
    }

    public syncActivationPolicy(): void {
        if (!this.settingsWindow || this.settingsWindow.isDestroyed()) return;
        this.adapter.syncActivationPolicy(this.settingsWindow, this.contentProtection);
    }
}
