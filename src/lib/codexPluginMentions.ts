export interface SelectedCodexPluginMention {
  id: string;
  name: string;
}

/**
 * Keep Codex's connector id out of the composer while preserving the exact
 * machine-readable mention that App Server expects at submit time.
 */
export function toCodexPluginPrompt(
  visibleText: string,
  selectedPlugin: SelectedCodexPluginMention | null,
): string {
  if (!selectedPlugin) return visibleText;

  const visibleMention = `@${selectedPlugin.name}`;
  if (visibleText === visibleMention) return `@${selectedPlugin.id}`;
  if (!visibleText.startsWith(`${visibleMention} `)) return visibleText;

  return `@${selectedPlugin.id}${visibleText.slice(visibleMention.length)}`;
}

export function isSelectedPluginMentionIntact(
  visibleText: string,
  selectedPlugin: SelectedCodexPluginMention | null,
): boolean {
  if (!selectedPlugin) return false;
  const visibleMention = `@${selectedPlugin.name}`;
  return visibleText === visibleMention || visibleText.startsWith(`${visibleMention} `);
}
