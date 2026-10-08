//! Small, passive OS-input helpers used by hold-to-dictate.
//!
//! Unlike `StealthKeyboardTap`, these helpers never install a hook and never
//! swallow input. Main polls the modifier state and reacts only to edges.

#[napi(object)]
pub struct GlobalModifierState {
    pub ctrl: bool,
    pub alt: bool,
    pub shift: bool,
    pub meta: bool,
}

#[cfg(target_os = "windows")]
fn key_down(vk: windows::Win32::UI::Input::KeyboardAndMouse::VIRTUAL_KEY) -> bool {
    use windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;
    unsafe { (GetAsyncKeyState(vk.0 as i32) as u16 & 0x8000) != 0 }
}

#[napi]
pub fn get_global_modifier_state() -> GlobalModifierState {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::UI::Input::KeyboardAndMouse::{VK_CONTROL, VK_LWIN, VK_MENU, VK_RWIN, VK_SHIFT};
        return GlobalModifierState {
            ctrl: key_down(VK_CONTROL),
            alt: key_down(VK_MENU),
            shift: key_down(VK_SHIFT),
            meta: key_down(VK_LWIN) || key_down(VK_RWIN),
        };
    }
    #[cfg(not(target_os = "windows"))]
    GlobalModifierState { ctrl: false, alt: false, shift: false, meta: false }
}

/// Poll one non-modifier key used by a custom hold shortcut.
#[napi]
pub fn is_global_key_down(key: String) -> bool {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::UI::Input::KeyboardAndMouse::VIRTUAL_KEY;
        let upper = key.trim().to_ascii_uppercase();
        let code = if upper.len() == 1 {
            upper.as_bytes()[0] as u16
        } else {
            match upper.as_str() {
                "SPACE" => 0x20, "ENTER" => 0x0D, "TAB" => 0x09,
                "ARROWLEFT" | "LEFT" => 0x25, "ARROWUP" | "UP" => 0x26,
                "ARROWRIGHT" | "RIGHT" => 0x27, "ARROWDOWN" | "DOWN" => 0x28,
                _ => return false,
            }
        };
        return key_down(VIRTUAL_KEY(code));
    }
    #[cfg(not(target_os = "windows"))]
    false
}

/// Snapshot the current foreground HWND as a decimal string. A string avoids
/// truncating a 64-bit pointer at the JS number boundary.
#[napi]
pub fn get_foreground_window_id() -> String {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
        let hwnd = unsafe { GetForegroundWindow() };
        return (hwnd.0 as isize).to_string();
    }
    #[cfg(not(target_os = "windows"))]
    String::new()
}

#[cfg(target_os = "windows")]
fn send_virtual_key(vk: windows::Win32::UI::Input::KeyboardAndMouse::VIRTUAL_KEY, with_ctrl: bool) -> bool {
    use std::mem::size_of;
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, VK_CONTROL,
    };

    fn input(vk: windows::Win32::UI::Input::KeyboardAndMouse::VIRTUAL_KEY, up: bool) -> INPUT {
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: vk,
                    wScan: 0,
                    dwFlags: if up { KEYEVENTF_KEYUP } else { Default::default() },
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        }
    }

    let inputs = if with_ctrl {
        vec![input(VK_CONTROL, false), input(vk, false), input(vk, true), input(VK_CONTROL, true)]
    } else {
        vec![input(vk, false), input(vk, true)]
    };
    unsafe { SendInput(&inputs, size_of::<INPUT>() as i32) == inputs.len() as u32 }
}

/// Restore the dictation-start foreground window and synthesize Ctrl+V. The
/// clipboard itself is populated by Electron immediately before this call.
#[napi]
pub fn paste_to_window(window_id: Option<String>) -> bool {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::Input::KeyboardAndMouse::VIRTUAL_KEY;
        use windows::Win32::UI::WindowsAndMessaging::SetForegroundWindow;

        if let Some(raw) = window_id {
            if let Ok(id) = raw.parse::<isize>() {
                if id != 0 { unsafe { let _ = SetForegroundWindow(HWND(id)); } }
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(45));
        return send_virtual_key(VIRTUAL_KEY(0x56), true); // V
    }
    #[cfg(not(target_os = "windows"))]
    false
}

/// Best-effort media play/pause key. The controller calls it once on start and
/// once on finish only when the preference is enabled.
#[napi]
pub fn send_media_play_pause() -> bool {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::UI::Input::KeyboardAndMouse::VK_MEDIA_PLAY_PAUSE;
        return send_virtual_key(VK_MEDIA_PLAY_PAUSE, false);
    }
    #[cfg(not(target_os = "windows"))]
    false
}
