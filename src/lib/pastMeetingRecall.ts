// src/lib/pastMeetingRecall.ts
//
// Does a typed question ask about a PAST meeting ("what did we decide in
// yesterday's call?", "hôm qua họp nói gì", "la reunión de la semana pasada")?
//
// Such a question cannot be answered from the live transcript or the active
// mode's files; it needs the cross-meeting search that already exists for the
// "search all meetings" surface (RAGManager.queryGlobal). The pill chat never
// reached it, so asking about an earlier meeting from the idle pill got a
// generic answer.
//
// Precision first: a false positive diverts a normal question into a search of
// old meetings. So BOTH a past-time marker AND a meeting noun must appear close
// together, and an explicit reference to the current meeting vetoes the match.
// Pattern based (en, vi, es, fr, de, pt, it, id, tr, ru, zh, ja, ko, hi, ar); a
// language that is not listed simply keeps today's behaviour.
//
// Self-contained (no relative imports) so the renderer and the electron main
// process can both import it.

const PAST_LATIN =
  'yesterday|day before yesterday|last (?:week|month|time|night)|the other day|'
  + 'hom qua|hom kia|tuan truoc|thang truoc|lan truoc|buoi truoc|truoc do|'
  + 'ayer|anteayer|semana pasada|mes pasado|ultima vez|anterior|'
  + 'hier|avant hier|semaine derniere|mois dernier|derniere fois|precedente?|'
  + 'gestern|vorgestern|letzte[nrm]? (?:woche|monat)|vergangene[nrm]? woche|letztes mal|vorherige\\w*|'
  + 'ontem|anteontem|semana passada|mes passado|ultima vez|'
  + 'ieri|settimana scorsa|mese scorso|ultima volta|'
  + 'kemarin|minggu lalu|bulan lalu|sebelumnya|terakhir|'
  + 'dun|dunku|gecen hafta|gecen ay|onceki|gecen';

const MEETING_LATIN =
  'meeting|call|session|lecture|class|standup|stand up|interview|discussion|conversation|'
  + 'cuoc hop|buoi hop|lan hop|hop|buoi hoc|cuoc goi|phong van|'
  + 'reunion|llamada|clase|entrevista|conferencia|junta|'
  + 'appel|cours|entretien|'
  + 'besprechung|termin|anruf|vorlesung|gesprach|'
  + 'reuniao|chamada|aula|'
  + 'riunione|chiamata|lezione|colloquio|'
  + 'rapat|pertemuan|kuliah|panggilan|wawancara|'
  + 'toplanti\\w*|gorusme\\w*|ders';

// "earlier / previous / prior" are NOT past markers on their own: in a live call
// "what did he say earlier in the conversation" is about THIS meeting. They only
// count when glued to a meeting noun ("previous meeting", "earlier call").
const ADJACENT_PAST =
  '(?:previous|prior|earlier|last|former) (?:meeting|call|session|lecture|class|interview|standup)'
  // Vietnamese puts the time word AFTER the noun: "lần họp trước", "buổi học hôm qua".
  + '|(?:cuoc hop|buoi hop|lan hop|buoi hoc|cuoc goi|buoi phong van) (?:truoc|hom qua|hom kia|tuan truoc|thang truoc)';

const B = '(?<![\\p{L}\\p{N}])';
const E = '(?![\\p{L}\\p{N}])';

const LATIN_NEAR_RE = new RegExp(
  `${B}(?:${ADJACENT_PAST})${E}`
  + `|${B}(?:${PAST_LATIN})${E}[^.?!\\n]{0,32}?${B}(?:${MEETING_LATIN})${E}`
  + `|${B}(?:${MEETING_LATIN})${E}[^.?!\\n]{0,32}?${B}(?:${PAST_LATIN})${E}`,
  'iu',
);

const NATIVE_RES: RegExp[] = [
  // Chinese
  /(?:昨天|前天|上周|上星期|上个月|上次|之前|以前)[^。？！\n]{0,8}(?:会议|开会|会|课|通话|面试|讨论)/u,
  /(?:会议|开会|课|面试)[^。？！\n]{0,4}(?:昨天|上次|上周)/u,
  // Japanese
  /(?:昨日|先週|先月|前回|この前|以前)[^。？！\n]{0,8}(?:会議|ミーティング|授業|通話|面接|打ち合わせ)/u,
  // Korean
  /(?:어제|지난주|지난달|저번|지난|이전)[^.?!\n]{0,8}(?:회의|미팅|수업|통화|면접)/u,
  // Russian
  /(?:вчера|на прошлой неделе|в прошлом месяце|в прошлый раз|прошл\p{L}*|предыдущ\p{L}*)[^.?!\n]{0,20}(?:встреч\p{L}*|совещани\p{L}*|лекци\p{L}*|созвон\p{L}*|собеседовани\p{L}*|урок\p{L}*)/iu,
  // Hindi
  /(?:कल|पिछले हफ्ते|पिछली)[^.?!\n]{0,15}(?:मीटिंग|बैठक|कक्षा)/u,
  // Arabic
  /(?:أمس|الأسبوع الماضي|السابق)[^.?!\n]{0,15}(?:اجتماع|مكالمة|محاضرة)/u,
  /(?:اجتماع|مكالمة|محاضرة)[^.?!\n]{0,8}(?:أمس|الماضي|السابق)/u,
];

// An explicit reference to the meeting that is happening NOW cancels the match:
// "what did she say earlier in this meeting" is about the live transcript.
const CURRENT_LATIN_RE = new RegExp(
  `${B}(?:this|current|ongoing|today s|todays|este|esta|ce|cette|dieses|diese|questo|questa|ini|bu)${E}[^.?!\\n]{0,10}?${B}(?:${MEETING_LATIN})${E}`
  + `|${B}(?:${MEETING_LATIN})${E}[^.?!\\n]{0,4}?${B}(?:nay|hien tai|hom nay|actual)${E}`,
  'iu',
);

function foldLatin(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/ı/g, 'i')
    .replace(/[’'`´-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isPastMeetingRecallQuestion(text: string): boolean {
  const raw = String(text ?? '').trim();
  if (!raw) return false;
  const folded = foldLatin(raw);
  if (CURRENT_LATIN_RE.test(folded)) return false;
  if (LATIN_NEAR_RE.test(folded)) return true;
  const native = raw.toLowerCase().normalize('NFC');
  return NATIVE_RES.some((re) => re.test(native));
}
