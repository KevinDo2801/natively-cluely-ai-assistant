import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { isPastMeetingRecallQuestion } from '../pastMeetingRecall.ts';

const RECALL = {
  en: ['what did we decide in yesterday\'s meeting', 'summarize last week\'s call', 'what was said in the previous meeting', 'in our last meeting who owned the migration', 'remind me what the interview yesterday covered'],
  vi: ['hôm qua họp nói gì', 'cuộc họp hôm qua quyết định gì', 'buổi học tuần trước thầy giảng gì', 'hom qua hop noi gi', 'lần họp trước ai nhận việc deploy'],
  es: ['¿qué se decidió en la reunión de ayer?', 'resume la llamada de la semana pasada'],
  fr: ['qu\'est-ce qu\'on a décidé à la réunion d\'hier', 'résume l\'appel de la semaine dernière'],
  de: ['was wurde in der Besprechung gestern beschlossen', 'fasse das Meeting der letzten Woche zusammen'],
  pt: ['o que ficou decidido na reunião de ontem', 'resuma a chamada da semana passada'],
  it: ['cosa abbiamo deciso nella riunione di ieri'],
  id: ['apa keputusan rapat kemarin'],
  tr: ['dünkü toplantıda ne konuşuldu'],
  ru: ['что решили на вчерашней встрече', 'о чём говорили на прошлой неделе на совещании'],
  zh: ['昨天的会议决定了什么', '上次开会谁负责上线'],
  ja: ['昨日の会議で何を決めた', '前回のミーティングの内容'],
  ko: ['어제 회의에서 뭘 정했지', '지난주 미팅 내용 알려줘'],
  hi: ['कल की मीटिंग में क्या तय हुआ'],
  ar: ['ماذا تقرر في اجتماع أمس'],
};

const NOT_RECALL = [
  // about the live / current meeting
  'what did she say earlier in this meeting',
  'what did he say earlier in the conversation',
  'what did the interviewer ask just now',
  'cuộc họp này vừa nói gì',
  'giải thích',
  'tóm tắt cuộc họp hiện tại',
  // time word without a meeting noun, or a meeting noun without a time word
  'I deployed it yesterday, why is it failing',
  'how do I run a good meeting',
  'schedule a call with the client',
  'what is a kernel',
  'review my resume',
  'the previous question was about Go',
  '',
];

describe('isPastMeetingRecallQuestion', () => {
  for (const [lang, qs] of Object.entries(RECALL)) {
    test(`detects past-meeting recall in ${lang}`, () => {
      for (const q of qs) assert.equal(isPastMeetingRecallQuestion(q), true, `${lang}: expected recall: ${q}`);
    });
  }

  test('does not divert ordinary or live-meeting questions', () => {
    for (const q of NOT_RECALL) assert.equal(isPastMeetingRecallQuestion(q), false, `expected NOT recall: "${q}"`);
  });

  test('tolerates null / undefined', () => {
    assert.equal(isPastMeetingRecallQuestion(undefined), false);
    assert.equal(isPastMeetingRecallQuestion(null), false);
  });
});
