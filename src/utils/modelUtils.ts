export const STANDARD_CLOUD_MODELS: Record<string, {
    hasKeyCheck: (creds: any) => boolean;
    ids: string[];
    names: string[];
    descs: string[];
    pmKey: 'geminiPreferredModel' | 'openaiPreferredModel' | 'claudePreferredModel' | 'groqPreferredModel' | 'deepseekPreferredModel' | 'nvidia_nimPreferredModel';
}> = {
    gemini: {
        hasKeyCheck: (creds) => !!creds?.hasGeminiKey,
        ids: ['gemini-3.7-flash', 'gemini-3.1-flash-lite', 'gemini-3.1-pro-preview'],
        names: ['Gemini 3.7 Flash', 'Gemini 3.1 Flash Lite', 'Gemini 3.1 Pro'],
        descs: ['Fastest • Multimodal', 'Reasoning • High Quality'],
        pmKey: 'geminiPreferredModel'
    },
    openai: {
        hasKeyCheck: (creds) => !!creds?.hasOpenaiKey,
        ids: ['gpt-5.4'],
        names: ['GPT 5.4'],
        descs: ['OpenAI'],
        pmKey: 'openaiPreferredModel'
    },
    claude: {
        hasKeyCheck: (creds) => !!creds?.hasClaudeKey,
        ids: ['claude-sonnet-4-6'],
        names: ['Sonnet 4.6'],
        descs: ['Anthropic'],
        pmKey: 'claudePreferredModel'
    },
    groq: {
        hasKeyCheck: (creds) => !!creds?.hasGroqKey,
        // Groq retired every Llama id it hosted (llama-3.3-70b-versatile on
        // 2026-08-16, llama-4-scout on 2026-07-17). qwen3.6-27b leads because it
        // is the only Groq model that still accepts images, so it covers both the
        // text and the screenshot paths; the GPT-OSS pair is here so a user who
        // wants a text-only production-tier model can switch the default.
        ids: ['qwen/qwen3.6-27b', 'openai/gpt-oss-120b', 'openai/gpt-oss-20b'],
        names: ['Groq Qwen 3.6', 'Groq GPT-OSS 120B', 'Groq GPT-OSS 20B'],
        descs: ['Ultra Fast • Multimodal', 'Highest Quality • Text-only', 'Fastest • Text-only'],
        pmKey: 'groqPreferredModel'
    },
    deepseek: {
        hasKeyCheck: (creds) => !!creds?.hasDeepseekKey,
        ids: ['deepseek-v4-flash', 'deepseek-v4-pro'],
        names: ['DeepSeek V4 Flash', 'DeepSeek V4 Pro'],
        descs: ['Fast • Text-only', 'Reasoning • Text-only'],
        pmKey: 'deepseekPreferredModel'
    },
    nvidia_nim: {
        hasKeyCheck: (creds) => !!creds?.hasNvidiaNimKey,
        ids: ['nvidia_nim/meta/llama-3.1-8b-instruct', 'nvidia_nim/z-ai/glm4.7'],
        names: ['Llama 3.1 8B (Nvidia Nim)', 'GLM 4.7 (Nvidia Nim)'],
        descs: ['Nvidia hosted', 'Reasoning • Nvidia hosted'],
        pmKey: 'nvidia_nimPreferredModel'
    },
};

export const CODEX_CLI_MODEL = {
    id: 'codex-cli',
    name: 'Codex CLI',
    desc: 'Official Codex connection',
};

// Filled by the official model/list IPC; no account-independent catalog.
export const CODEX_CLI_MODEL_PRESETS: { id: string; name: string }[] = [];

export const codexCliSelectorId = (modelId: string): string => `codex-cli:${modelId}`;

export const getCodexCliModelDisplayName = (id: string): string | null => {
    if (id === CODEX_CLI_MODEL.id) return CODEX_CLI_MODEL.name;
    if (!id.startsWith('codex-cli:')) return null;

    const modelId = id.slice('codex-cli:'.length);
    const preset = CODEX_CLI_MODEL_PRESETS.find(model => model.id === modelId);
    return preset?.name || prettifyModelId(modelId);
};

// Claude Code CLI (the user's own `claude` login). The id prefix is `claudecode`
// with NO hyphen on purpose: `claude-…` ids are the Anthropic API family and
// would be routed to the API-key client. Mirrors LLMHelper.isClaudeCodeModel.
export const CLAUDE_CODE_MODEL = {
    id: 'claudecode',
    name: 'Claude Code',
    desc: 'Your Claude plan via Claude Code',
};

// Aliases track the latest model of each tier; keep in sync with
// CLAUDE_CODE_MODEL_PRESETS in electron/services/ClaudeCodeCliService.ts.
export const CLAUDE_CODE_MODEL_PRESETS: { id: string; name: string }[] = [
    { id: 'sonnet', name: 'Claude Sonnet (latest)' },
    { id: 'opus', name: 'Claude Opus (latest)' },
    { id: 'haiku', name: 'Claude Haiku (latest)' },
    { id: 'claude-fable-5-1', name: 'Claude Fable 5.1' },
    { id: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
    { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' },
    { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5' },
    { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
    { id: 'claude-opus-4-1', name: 'Claude Opus 4.1' },
    { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5' },
];

export const claudeCodeSelectorId = (modelId: string): string => `claudecode:${modelId}`;

export const getClaudeCodeModelDisplayName = (id: string): string | null => {
    if (id === CLAUDE_CODE_MODEL.id) return CLAUDE_CODE_MODEL.name;
    if (!id.startsWith('claudecode:')) return null;
    const modelId = id.slice('claudecode:'.length);
    const preset = CLAUDE_CODE_MODEL_PRESETS.find(model => model.id === modelId);
    return `${CLAUDE_CODE_MODEL.name}: ${preset?.name || prettifyModelId(modelId)}`;
};

export const prettifyModelId = (id: string): string => {
    if (!id) return '';
    return id.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
};

/**
 * Providers whose model allow-list is OPT-IN: an empty list means NOTHING is
 * selected, not "everything".
 *
 * Every other provider ships a curated handful of preset models, so "empty =
 * all" is the right default there and stays. A LiteLLM gateway fronts the
 * upstream's entire catalogue — 300+ models is normal — and defaulting that to
 * "all" floods the meeting-overlay picker with a list nobody chose.
 *
 * MIRRORED in ipcHandlers.ts modelAvailable(). The two must agree: this one
 * decides what the user can pick, that one decides what routing will accept.
 * A drift guard test pins them together.
 */
export const isOptInModelProvider = (provider: string): boolean => provider === 'litellm';

/**
 * Does `modelId` survive `provider`'s allow-list?
 *
 * The single definition of the allow-list contract, so the settings panel, the
 * meeting-overlay picker and routing cannot disagree about what "empty" means.
 */
export const isModelAllowed = (provider: string, modelId: string, allowList: string[]): boolean => {
    // Opt-in: nothing is permitted until the user ticks it.
    if (isOptInModelProvider(provider)) return allowList.includes(modelId);
    // Everyone else: empty means no filter at all.
    return allowList.length === 0 || allowList.includes(modelId);
};

/**
 * The display label for a LiteLLM-proxied model.
 *
 * TWO prefixes stack on these ids, and neither is identity:
 *   1. `litellm/` — Natively's own routing prefix. providerFamily() and
 *      modelAvailable() (ipcHandlers.ts) key off it, so it can never be
 *      dropped from the ID; it just has no business being on screen.
 *   2. `<upstream>/` — the PROXY's own model id. Most LiteLLM configs name
 *      models `openai/gpt-4o`, `anthropic/claude-3-5-sonnet`, `bedrock/...`,
 *      so a raw id reads `litellm/openai/gpt-4o`.
 *
 * The label is therefore the LAST segment. Accepts prefixed and bare ids
 * alike, because the two callers hold different forms: the picker and the
 * allow-list hold `litellm/<id>`, while the discovery cache
 * (getAvailableLiteLLMModels) holds the proxy's `<id>` verbatim.
 *
 * Deliberately NOT prettifyModelId(): that is built for our own hyphenated
 * ids and mangles proxy ids — `bedrock/anthropic.claude-v2` came out as
 * "Bedrock/Anthropic.Claude V2". A proxy model id is a literal the user typed
 * into their own config, so it renders verbatim.
 *
 * KNOWN, ACCEPTED: two upstreams can expose the same model name, so
 * `openai/gpt-4o` and `azure/gpt-4o` both label as "gpt-4o" and are
 * indistinguishable in a list. Showing the bare name was chosen with that
 * trade-off understood; disambiguating is a change to this one function.
 */
export const litellmModelLabel = (id: string): string => {
    if (!id) return '';
    const segments = id.replace(/^litellm\//, '').split('/').filter(Boolean);
    // Degenerate ids ("litellm/", "///") keep the input rather than becoming
    // an empty label — a blank row is worse than an ugly one.
    return segments.length ? segments[segments.length - 1] : id;
};
