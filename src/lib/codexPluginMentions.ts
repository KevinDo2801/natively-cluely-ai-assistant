export interface SelectedCodexPluginMention {
  id: string;
  name: string;
  logoUrl?: string;
}

interface MentionableCodexPlugin extends SelectedCodexPluginMention {
  pluginDisplayNames?: string[];
}

function normalizePluginWords(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Resolve a connected plugin when the user explicitly names it in natural
 * language. Exact names always match; longer names also match inside a
 * sentence ("use Gmail to...", "add this to Google Calendar"). Ambiguous
 * aliases deliberately return null so the user can choose with @ instead.
 */
export function findExplicitlyMentionedCodexPlugin<T extends MentionableCodexPlugin>(
  text: string,
  plugins: T[],
): T | null {
  const normalizedText = normalizePluginWords(text);
  if (!normalizedText) return null;
  const paddedText = ` ${normalizedText} `;
  let best: { plugin: T; score: number } | null = null;
  let ambiguous = false;

  for (const plugin of plugins) {
    const aliases = [plugin.name, ...(plugin.pluginDisplayNames || [])];
    for (const rawAlias of aliases) {
      const alias = normalizePluginWords(rawAlias);
      if (!alias) continue;
      const exact = normalizedText === alias;
      const inSentence = alias.length >= 5 && paddedText.includes(` ${alias} `);
      if (!exact && !inSentence) continue;
      const score = (exact ? 10_000 : 0) + alias.length;
      if (!best || score > best.score) {
        best = { plugin, score };
        ambiguous = false;
      } else if (score === best.score && best.plugin.id !== plugin.id) {
        ambiguous = true;
      }
    }
  }

  return best && !ambiguous ? best.plugin : null;
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
