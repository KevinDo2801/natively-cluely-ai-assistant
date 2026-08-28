// Shared helpers for the WindowAdapter platform implementations.

export const DISGUISE_ICON_NAMES: Record<string, string> = {
  terminal: 'terminal.png',
  settings: 'settings.png',
  activity: 'activity.png',
};

export function disguiseIconName(mode: string): string | null {
  return DISGUISE_ICON_NAMES[mode] ?? null;
}
