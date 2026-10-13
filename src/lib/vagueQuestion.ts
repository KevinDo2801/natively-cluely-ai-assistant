// src/lib/vagueQuestion.ts
//
// "Vague / referential" question detection for the chat overlays.
//
// A question like "giải thích", "explain what she said" or "qué dijo ella" names
// no topic, so the model tends to anchor on whichever transcript block is most
// "explainable" — often an older story — instead of the last thing said. The
// chat composer bounds those turns to the MOST RECENT statements.
//
// Coverage: en, vi (incl. telegraphed no-diacritic typing), es, fr, de, pt, it,
// id, tr, ru, zh, ja, ko, hi, ar. These are PATTERNS, not language ID: a language
// that is not listed simply gets no extra bound. That is a soft failure — the
// base persona already tells the model, in any language, to answer a question
// that names no topic from the latest statements; this detector only adds the
// stronger "recent-only, short" instruction on top.
//
// Precision matters as much as recall: a false positive truncates a legitimate
// topical question to "the last two statements". Every pattern therefore needs
// either an imperative ("explain", "repeat") or a reference to what a speaker
// just said — never a bare "what does X mean".
//
// Self-contained (no relative imports) so the renderer and the electron main
// process can both import it.

// Latin-script patterns run on diacritic-stripped text (see foldLatin), so they
// are written WITHOUT accents and match both "giải thích" and "giai thich".
const B = '(?<![\\p{L}\\p{N}])';
const E = '(?![\\p{L}\\p{N}])';

const LATIN_PATTERNS: string[] = [
  // English
  'explain|describe|summari[sz]e|repeat that|go on|continue|say that again|tell me (?:more|about)',
  'what (?:did|does) (?:she|he|they|the (?:speaker|person|interviewer|candidate|teacher)|him|her) (?:say|mean)',
  'what (?:was|is) (?:that|this|it)',
  'can you (?:say|repeat|clarify) (?:that|this|it)',
  // Vietnamese
  'giai thich|noi gi|dang noi|nghia la|nhac lai|noi lai|tom tat',
  'y (?:thay|co|anh|chi|nguoi|ho) (?:noi|muon|dang)',
  '(?:thay|co|anh|chi|ong|ba|ho|no|ban) (?:ay |do )?(?:dang )?noi gi',
  // Spanish
  // NOTE: bare "resume" is deliberately absent from the es/fr/pt lists below —
  // it is also the English word for a CV, and this app is full of "review my
  // resume" questions. Only unambiguous forms are listed.
  'explic(?:a|ame|alo)|resumen|resumeme|repite(?:lo)?|sigue|continua|cuentame mas|dime mas',
  'que (?:dijo|dice|quiso decir) (?:ella|el|ellos|eso|esto|la profesora|el profesor|el ponente)',
  'que significa (?:eso|esto)|que fue eso|puedes (?:repetir|aclarar)',
  // French
  'explique(?:z)?(?: moi)?|resume moi|resumez(?: moi)?|repete(?:z)?|continuez|dis moi en plus',
  'qu est ce qu (?:il|elle|ils|elles) (?:a |ont )?(?:dit|veut dire|voulait dire)|qu a t (?:il|elle) dit',
  'c etait quoi (?:ca|cela)|peux tu (?:repeter|clarifier)',
  // German
  'erklar(?:e|en)?(?: sie)?|fass(?:e)? zusammen|zusammenfass\\w*|wiederhol\\w*|mehr dazu',
  'was (?:hat|meint) (?:er|sie|der|die)(?: \\w+)? (?:gesagt|damit)|was sagt (?:er|sie)|was war das',
  // Portuguese
  'explique|explica|resuma|repita|repete|continua|me conte mais|fale mais',
  'o que (?:ele|ela|eles|elas|o professor|a professora) (?:disse|falou|quis dizer)|o que foi isso|pode (?:repetir|esclarecer)',
  // Italian
  'spiega(?:mi)?|riassumi|ripeti|continua|dimmi di piu',
  '(?:cosa|che cosa) (?:ha detto|dice|intende|voleva dire) (?:lui|lei|loro|il professore|la professoressa)|cos era (?:questo|quello)|puoi (?:ripetere|chiarire)',
  // Indonesian
  'jelaskan|terangkan|ringkas(?:kan)?|rangkum|ulangi|lanjutkan|ceritakan lebih',
  'apa (?:yang )?(?:dia|dosen|guru|pembicara|beliau|mereka) (?:katakan|bilang|maksud)|dia bilang apa|maksudnya apa|apa tadi',
  // Turkish
  'acikla(?:r misin|yin)?|ozetle|tekrarla|tekrar eder misin|devam et|ne dedi|ne demek istedi',
];

// Non-Latin scripts run on lowercase NFC text: diacritic stripping would turn
// Cyrillic "й" into "и" and split Japanese voiced kana, so they must not share
// the Latin folding.
const NATIVE_PATTERNS: string[] = [
  // Russian
  'объясни(?:те)?|поясни(?:те)?|перескажи(?:те)?|повтори(?:те)?|расскажи(?:те)? (?:подробнее|ещё|еще)|продолжай(?:те)?',
  'что (?:он|она|они|преподаватель|спикер|лектор) (?:сказал|сказала|сказали|имел[аи]? в виду)|что это было',
  // Chinese
  '解释|讲解|总结|概括|重复一下|再说一遍|再说一次|详细说|多说(?:点|一点)|继续(?:说|讲)?',
  '(?:他|她|他们|老师|讲师)(?:刚才|刚刚)?说了什么|(?:刚才|刚刚)说了什么|(?:这|那|他说的|她说的|老师说的)(?:是)?什么意思',
  // Japanese
  '説明して|解説して|要約して|まとめて|もう一度(?:言って|お願い)|繰り返して|何て言った|何と言った|(?:今|それ|これ|あれ)(?:は|って)?どういう意味|続けて',
  // Korean
  '설명해|요약해|정리해|다시 말해|반복해|방금 뭐라|뭐라고 (?:했|하셨|말했)|(?:방금|그게|이게|그거|이거) ?(?:무슨|뭔) 뜻|계속해|자세히',
  // Hindi
  'समझा(?:ओ|इए|इये|ना|एं)|सारांश|संक्षेप में|दोहरा(?:ओ|इए)|(?:उसने|उन्होंने|शिक्षक ने) क्या कहा|इसका मतलब क्या',
  // Arabic
  'اشرح|فسر|لخص|كرر|أعد|ماذا (?:قال|قالت|قالوا|يقصد)|ماذا كان ذلك|تابع|أكمل',
];

const LATIN_RE = new RegExp(`${B}(?:${LATIN_PATTERNS.join('|')})${E}`, 'iu');
// CJK / Hindi / Arabic have no space-delimited word boundary, so they are
// matched as plain substrings; Cyrillic keeps the boundary lookarounds.
const NATIVE_RE = new RegExp(`(?:${NATIVE_PATTERNS.join('|')})`, 'iu');

function foldLatin(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/ı/g, 'i')
    // Apostrophes and hyphens split French contractions ("qu'est-ce qu'il").
    .replace(/[’'`´-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isVagueChatQuestion(text: string): boolean {
  const raw = String(text ?? '').trim();
  if (!raw) return false;
  if (LATIN_RE.test(foldLatin(raw))) return true;
  return NATIVE_RE.test(raw.toLowerCase().normalize('NFC'));
}
