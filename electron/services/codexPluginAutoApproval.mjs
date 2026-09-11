/**
 * Auto-approval policy for Codex plugin ("app connector") interactions.
 *
 * WHY THIS EXISTS
 * ---------------
 * A connector action that needs a user decision arrives as a JSON-RPC request
 * FROM the App Server (item/tool/requestUserInput or mcpServer/elicitation/
 * request). By default CodexAppServerService surfaces it as a card in the
 * overlay and waits for a click. Users who want plugin actions to just happen
 * (e.g. "add a LeetCode event at 5 PM") can turn on
 * Settings → Plugins → "Approve plugin actions automatically", which routes
 * every incoming request through this module first.
 *
 * WHAT IT MAY DECIDE — deliberately narrow
 * -----------------------------------------
 * Only genuine CONFIRMATIONS are auto-accepted. Everything that carries
 * user-provided DATA (free-text answers, secret fields, a pick list of
 * non-yes/no choices such as "5 PM" / "6 PM", or an elicitation schema with
 * required fields) returns `null` so the card is still shown — silently
 * picking the first option there would write wrong data into the user's
 * account, which is worse than one extra click.
 *
 * Pure and clock-free so it can be unit-tested without Electron or the
 * App Server.
 */

/**
 * Confirmation labels, compared diacritic-free.
 *
 * A regex with `\b` is unusable here: JavaScript's `\b` is ASCII-only, so it
 * never matches after Vietnamese letters ("Đồng ý", "Không") and the alternation
 * silently fails. Labels are instead lowercased, stripped of combining marks
 * (plus đ→d, the usual ASCII spelling), and matched as whole prefixes bounded by
 * whitespace/punctuation — so "Allow" matches while "Allocate" does not.
 */
const AFFIRMATIVE_LABELS = [
  'y', 'yes', 'yeah', 'yep', 'ok', 'okay', 'sure', 'allow', 'approve', 'accept',
  'confirm', 'continue', 'proceed', 'create', 'add', 'save', 'send',
  'dong y', 'co', 'cho phep', 'tiep tuc', 'tao',
];
const NEGATIVE_LABELS = [
  'n', 'no', 'nope', 'cancel', 'decline', 'deny', 'reject', 'stop', 'dont',
  'khong', 'huy', 'thoi', 'dung',
];

function normalizeLabel(label) {
  return String(label ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'd')
    .toLowerCase()
    .trim();
}

function matchesLabel(normalized, candidates) {
  return candidates.some(candidate =>
    normalized === candidate || /^[\s,.!?:;)\]-]/.test(normalized.slice(candidate.length)));
}

function optionLabels(question) {
  const options = Array.isArray(question?.options) ? question.options : [];
  return options
    .map(option => (typeof option?.label === 'string' ? option.label.trim() : ''))
    .filter(label => label.length > 0);
}

/**
 * A question can only be answered without the human when it is a binary
 * confirmation: it offers exactly one affirmative label AND at least one
 * negative counterpart. A 2-option pick list without a negative side
 * ("5 PM" / "6 PM") is data, not consent.
 */
function affirmativeAnswer(labels) {
  const normalized = labels.map(normalizeLabel);
  const affirmative = labels.filter((_, index) => matchesLabel(normalized[index], AFFIRMATIVE_LABELS));
  const negative = labels.filter((_, index) => matchesLabel(normalized[index], NEGATIVE_LABELS));
  if (affirmative.length !== 1) return null;
  if (negative.length === 0) return null;
  return affirmative[0];
}

function answerUserInputQuestions(questions) {
  if (!Array.isArray(questions) || questions.length === 0) return {};
  const values = {};
  for (const question of questions) {
    const id = String(question?.id || '');
    if (!id) return null;
    // Secrets and free-text prompts are always the user's to answer.
    if (question?.isSecret === true) return null;
    const labels = optionLabels(question);
    if (labels.length === 0) return null;
    const answer = affirmativeAnswer(labels);
    if (answer === null) return null;
    values[id] = answer;
  }
  return values;
}

function requiredSchemaFields(schema) {
  if (!schema || typeof schema !== 'object') return [];
  const required = schema.required;
  return Array.isArray(required) ? required.filter(field => typeof field === 'string' && field.length > 0) : [];
}

/**
 * Decide whether an incoming plugin interaction can be answered without the
 * user. Returns null when the card must still be shown.
 *
 * @param {{ kind?: string, questions?: unknown[], requestedSchema?: unknown, mode?: string, url?: string }} request
 * @returns {{ action: 'accept', values: Record<string, string> } | null}
 */
export function buildAutoApprovalResponse(request) {
  if (!request || typeof request !== 'object') return null;

  if (request.kind === 'user_input') {
    const values = answerUserInputQuestions(request.questions);
    return values === null ? null : { action: 'accept', values };
  }

  if (request.kind === 'elicitation') {
    // A URL elicitation hands the user to a browser (OAuth/consent). Answering
    // "accept" for them would fake a flow they never completed.
    if (typeof request.url === 'string' && request.url.length > 0) return null;
    if (String(request.mode || '').toLowerCase() === 'url') return null;
    // A schema asking for fields needs data this module must not invent.
    if (requiredSchemaFields(request.requestedSchema).length > 0) return null;
    return { action: 'accept', values: {} };
  }

  return null;
}
