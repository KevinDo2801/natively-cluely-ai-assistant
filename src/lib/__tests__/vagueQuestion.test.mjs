import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { isVagueChatQuestion } from '../vagueQuestion.ts';

const VAGUE = {
  en: ['explain what she said', 'what did he mean', 'tell me more', 'repeat that', 'Can you repeat that?'],
  vi: ['giải thích', 'giai thich', 'thầy đang nói gì', 'thay dang noi gi', 'anh ay noi gi', 'nghĩa là gì', 'nhắc lại đi'],
  es: ['explícame', 'repite eso', '¿Qué dijo ella?', 'qué quiso decir el profesor', 'cuéntame más'],
  fr: ['explique-moi', "qu'est-ce qu'il a dit ?", "Qu'a-t-elle dit ?", 'répète', "c'était quoi ça"],
  de: ['erkläre das', 'Was hat er gesagt?', 'Was meint sie damit?', 'wiederhole bitte', 'Was war das?'],
  pt: ['explique isso', 'o que ele disse?', 'o que o professor quis dizer', 'pode repetir'],
  it: ['spiegami', 'cosa ha detto lui', 'ripeti', 'puoi ripetere'],
  id: ['jelaskan', 'dia bilang apa', 'apa yang dosen katakan', 'bisa ulangi? ulangi'],
  tr: ['açıkla', 'ne dedi', 'tekrarla'],
  ru: ['объясни', 'Что он сказал?', 'повтори пожалуйста', 'что это было'],
  zh: ['解释一下', '他说了什么', '老师刚才说了什么', '再说一遍', '总结一下'],
  ja: ['説明して', '今何て言った', 'もう一度言って'],
  ko: ['설명해줘', '방금 뭐라고 했어', '다시 말해줘'],
  hi: ['समझाओ', 'उसने क्या कहा', 'दोहराओ'],
  ar: ['اشرح', 'ماذا قال', 'كرر'],
};

const SPECIFIC = [
  'what is a kernel',
  'sigma de lam gi',
  'my name is Kiet',
  'review my resume',
  'what is on my resume',
  'how do I build a REST API in Go',
  'che cosa è Kubernetes',
  'qué es un array en Java',
  'was ist ein Pointer',
  'quelle est la capitale de la France',
  '什么是微服务架构',
  'Какая столица России',
  '',
  '   ',
];

describe('isVagueChatQuestion — multilingual', () => {
  for (const [lang, qs] of Object.entries(VAGUE)) {
    test(`matches referential / imperative phrasings in ${lang}`, () => {
      for (const q of qs) assert.equal(isVagueChatQuestion(q), true, `${lang}: expected vague: ${q}`);
    });
  }

  test('rejects topical questions in several languages', () => {
    for (const q of SPECIFIC) assert.equal(isVagueChatQuestion(q), false, `expected specific: "${q}"`);
  });

  test('the English word "resume" (CV) is not treated as a Romance-language "summarise"', () => {
    for (const q of ['review my resume experience for me', 'update my resume', 'does my resume mention Go']) {
      assert.equal(isVagueChatQuestion(q), false, q);
    }
  });

  test('tolerates null / undefined', () => {
    assert.equal(isVagueChatQuestion(undefined), false);
    assert.equal(isVagueChatQuestion(null), false);
  });
});
