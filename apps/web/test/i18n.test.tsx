import { render } from '@testing-library/react';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { api, ApiFailure } from '../src/api';
import { ECHELON_STAGES } from '@hornhoof/protocol/echelons';
import { detectLanguage, errorText, LanguageProvider, LANGUAGES, plural, type ShippedLanguage } from '../src/i18n';
import { DICTIONARIES } from '../src/i18n/dictionaries';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import { mockApi } from './api-mock';

describe('detectLanguage', () => {
  it('follows the browser until a language is saved', () => {
    expect(detectLanguage(null, ['ru-RU', 'en'])).toBe('ru');
    expect(detectLanguage(null, ['de-DE'])).toBe('en');
    expect(detectLanguage('en', ['ru'])).toBe('en');
    expect(detectLanguage('xx', ['ru'])).toBe('ru');
  });
});

/* The Head of Design's word for #1489 (#1539, N4): the page names its language, so a browser breaks its words by that
   language's syllables, with a hyphen. */
describe('the language of the page', () => {
  it.each(LANGUAGES.map(({ id }) => id))("names the chosen language on the page's root from the start: %s", language => {
    localStorage.setItem('hh-lang', language);
    document.documentElement.lang = '';
    onTestFinished(() => {
      localStorage.removeItem('hh-lang');
      document.documentElement.lang = '';
    });
    render(<LanguageProvider><p>{language}</p></LanguageProvider>);
    expect(document.documentElement.lang).toBe(language);
  });
});

describe('plural', () => {
  it('picks the Russian form by the number', () => {
    const forms = { one: 'команда', few: 'команды', many: 'команд', other: 'команды' };
    expect([1, 3, 5, 21].map(n => plural('ru', n, forms))).toEqual(['команда', 'команды', 'команд', 'команда']);
  });
});

/* Every text in a language, with functions called on placeholder arguments. */
function textsOf(messages: unknown): string[] {
  const texts: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === 'string') texts.push(v);
    else if (typeof v === 'function') texts.push(String((v as (...a: string[]) => unknown)('X', 'Y', 'Z')));
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(messages);
  return texts;
}

describe('company template headcount', () => {
  it('counts employees with the right Russian form', () => {
    expect([1, 2, 5, 11, 21].map(n => ru.companyTemplates.employees(n))).toEqual(['1 сотрудник', '2 сотрудника', '5 сотрудников', '11 сотрудников', '21 сотрудник']);
    expect([1, 2].map(n => en.companyTemplates.employees(n))).toEqual(['1 employee', '2 employees']);
  });
});

describe('Russian vocabulary', () => {
  it('calls them машина and нода everywhere', () => {
    expect(textsOf(ru).filter(t => /узел|узл|компьютер/i.test(t))).toEqual([]);
  });

  it('writes е without dots and uses no em dashes in either language', () => {
    expect(textsOf(ru).filter(t => /[\u0451\u0401]/.test(t))).toEqual([]);
    expect(textsOf(en).filter(t => t.includes('\u2014'))).toEqual([]);
    expect(textsOf(ru).filter(t => t.includes('\u2014'))).toEqual([]);
  });
});

describe('Stage names', () => {
  /* A stage whose word a language truly spells as English does; none so far. */
  const SAME_AS_ENGLISH: Partial<Record<ShippedLanguage, readonly string[]>> = {};

  it('are in the own words of every shipped language, as call frames and task workflows show them', () => {
    const stages = (t: typeof en) => ({ ...Object.fromEntries(ECHELON_STAGES.map(s => [s, t.tasks.echelons.stages[s]])), ...Object.fromEntries(Object.entries(t.tasks.echelons.documentStages).map(([s, w]) => [`document.${s}`, w])) });
    const english = stages(en);
    const leftovers = LANGUAGES.filter(l => l.id !== 'en').flatMap(({ id }) =>
      Object.entries(stages(DICTIONARIES[id])).filter(([stage, word]) => !word.trim() || (word === english[stage] && !SAME_AS_ENGLISH[id]?.includes(stage))).map(([stage, word]) => `${id} ${stage}: ${word}`));
    expect(leftovers).toEqual([]);
  });
});

describe('The agent in the center', () => {
  it('is the orchestrator in both languages, since the chief is the CEO', () => {
    expect(textsOf(en).filter(t => /chief/i.test(t))).toEqual([]);
    expect(textsOf(ru).filter(t => /шеф/i.test(t))).toEqual([]);
  });
});

describe('errorText', () => {
  it('shows a known reason in the chosen language', () => {
    expect(errorText(ru, new ApiFailure(401, 'unauthorized', 'Wrong email or password.', 'wrong_password'))).toBe(ru.errors.wrong_password);
    const notConfirmed = new ApiFailure(503, 'unavailable', 'x', 'not_confirmed');
    expect(errorText(en, notConfirmed)).toBe('Hornhoof could not confirm this change. It may be saved; look before you try again.');
    expect(errorText(ru, notConfirmed)).toBe('Hornhoof не смог подтвердить это изменение. Возможно, оно сохранено: проверьте, прежде чем повторять.');
    const alreadyDone = new ApiFailure(409, 'conflict', 'x', 'already_done');
    expect(errorText(en, alreadyDone)).toBe('This change was already sent, and Hornhoof made it or began to make it, but its answer was lost. Reload the page to see what is there.');
    expect(errorText(ru, alreadyDone)).toBe('Это изменение уже было отправлено, и Hornhoof его сделал или начал делать, но ответ потерялся. Обновите страницу, чтобы увидеть, что получилось.');
  });

  it('words the reasons of maintenance, read-only and starting in both languages', () => {
    const answer = (reason: string) => new ApiFailure(503, 'unavailable', 'x', reason);
    expect(errorText(en, answer('maintenance'))).toBe('Hornhoof is installing an update and takes no changes until it ends. Try again in a few minutes.');
    expect(errorText(ru, answer('maintenance'))).toBe('Hornhoof ставит обновление и не принимает изменений, пока оно не закончится. Попробуйте через несколько минут.');
    expect(errorText(en, answer('read_only'))).toBe('Hornhoof only reads on this machine now, so nothing was changed.');
    expect(errorText(ru, answer('read_only'))).toBe('Сейчас Hornhoof на этой машине только читает, поэтому ничего не изменилось.');
    expect(errorText(en, answer('starting'))).toBe('Hornhoof is starting. Try again in a few seconds.');
    expect(errorText(ru, answer('starting'))).toBe('Hornhoof запускается. Попробуйте еще раз через несколько секунд.');
  });

  it('tells a person who tried too often to wait, in both languages', () => {
    const err = new ApiFailure(429, 'too_many', 'Too many attempts. Wait up to 15 minutes, then try again.', 'too_many_attempts');
    /* A sign-in past the softer cap per email waits up to an hour. */
    expect(errorText(en, err)).toBe('Too many attempts. Wait up to an hour, then try again.');
    expect(errorText(ru, err)).toBe('Слишком много попыток. Подождите до часа и попробуйте снова.');
    expect(errorText(ru, new ApiFailure(429, 'too_many', 'x'))).toBe('Слишком много попыток. Подождите немного и попробуйте снова.');
  });

  it('words a failure the server did not word from the dictionary, in English too', async () => {
    mockApi({ 'GET /api/x': [503, { error: { code: 'unavailable' } }] });
    const silent = await api.get('/api/x').catch((err: unknown) => err);
    expect(errorText(en, silent)).toBe(en.errors.codes.unavailable);
    expect(errorText(ru, silent)).toBe(ru.errors.codes.unavailable);
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))));
    const unreachable = await api.get('/api/x').catch((err: unknown) => err);
    expect(errorText(en, unreachable)).toBe(en.errors.codes.network);
    expect(errorText(ru, unreachable)).toBe(ru.errors.codes.network);
  });

  it('falls back to the error code in Russian and to the server message in English', () => {
    const err = new ApiFailure(401, 'unauthorized', 'Some new server text.', 'not_a_reason_yet');
    expect(errorText(ru, err)).toBe(ru.errors.codes.unauthorized);
    expect(errorText(en, err)).toBe('Some new server text.');
    const unavailableProducer = new ApiFailure(503, 'unavailable', '', 'source_producer_unavailable');
    expect(errorText(en, unavailableProducer)).toBe(en.errors.source_producer_unavailable);
    expect(errorText(ru, unavailableProducer)).toBe(ru.errors.source_producer_unavailable);
  });

  it('words GitHub rate limit resets, missing commit history and named host errors in both languages', () => {
    const timed = Object.assign(new ApiFailure(409, 'conflict', 'limit', 'github_rate_limited'), { details: { resetTime: '23:45' } });
    expect(errorText(en, timed)).toBe(en.errors.github_rate_limited('23:45'));
    expect(errorText(ru, timed)).toBe(ru.errors.github_rate_limited('23:45'));
    const untimed = new ApiFailure(409, 'conflict', 'limit', 'github_rate_limited');
    expect(errorText(en, untimed)).toBe(en.errors.github_rate_limited(null));
    expect(errorText(ru, untimed)).toBe(ru.errors.github_rate_limited(null));
    const unread = new ApiFailure(409, 'conflict', 'history', 'commit_history_unavailable');
    expect(errorText(en, unread)).toBe(en.errors.commit_history_unavailable);
    expect(errorText(ru, unread)).toBe(ru.errors.commit_history_unavailable);
    const leader = Object.assign(new ApiFailure(409, 'conflict', 'leader', 'leader'), { details: { host: 'mac' } });
    expect(errorText(en, leader)).toBe(en.errors.leader('mac'));
    expect(errorText(ru, leader)).toBe(ru.errors.leader('mac'));
  });

  it('streams bytes across arrayBuffer fallback and content-length headers', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string) => {
        if (path === '/no-body-short') {
          const fake = {
            ok: true,
            status: 200,
            headers: new Headers({ 'content-length': '10' }),
            body: null,
            arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
          };
          return fake as unknown as Response;
        }
        return new Response(new Uint8Array([4, 5]), {
          status: 200,
          headers: { 'content-length': 'not-a-number' },
        });
      }),
    );
    const shortRes = await api.streamBytes('/no-body-short');
    expect(shortRes.complete).toBe(false);
    expect(shortRes.error).toBe('incomplete');
    const badHeaderRes = await api.streamBytes('/bad-len');
    expect(badHeaderRes.complete).toBe(true);
    expect( Array.from(badHeaderRes.bytes) ).toEqual([4, 5]);
  });
});

describe('request sending state', () => {
  it('names the in-flight request sending state in English and Russian', () => {
    expect(en.tasks.sending).toBe('Sending');
    expect(ru.tasks.sending).toBe('Отправка');
  });
});

describe('work tree words', () => {
  it('uses the actual turn, branch and times in every language of the registry', () => {
    for (const L of LANGUAGES.map(({ id }) => DICTIONARIES[id].dept.tree)) {
      expect(L.treeAria(7)).toContain('7');
      expect(L.reviewH(7)).toContain('7');
      expect(L.mergeH(49, 'turn-7')).toContain('turn-7');
      expect(L.turnSay(7, '11:42', 'develop')).toContain('11:42');
      expect(L.turnSay(7, '11:42', 'develop')).toContain('develop');
      expect(L.spdSub(7, '11:42', '17:24')).toContain('17:24');
      expect(L.verdict(false, null)).not.toContain('null');
    }
  });

  it('counts findings in Russian and tasks in English', () => {
    expect([1, 2, 5, 11, 21].map(ru.dept.tree.found)).toEqual(['1 находка', '2 находки', '5 находок', '11 находок', '21 находка']);
    expect(en.dept.tree.inTurn(1, 1)).toBe('1 of 1 task');
  });

  it('names the restricted route screen in English and Russian', () => {
    expect(en.routes.accessDenied).toBe('Insufficient permissions');
    expect(ru.routes.accessDenied).toBe('Недостаточно прав');
  });

  it('names terminal permission and picture upload notices in English and Russian', () => {
    expect(en.window.controlDenied).toBe("Only the owner of this agent's subscription can control its program. Ask the owner, or write an ordinary message.");
    expect(ru.window.controlDenied).toBe('Управлять программой агента может только владелец его подписки. Попросите владельца или напишите обычное сообщение.');
    expect(en.window.messageDenied).toBe('You cannot write to this agent. Ask someone who has access to its department.');
    expect(ru.window.messageDenied).toBe('Вы не можете писать этому агенту. Попросите того, у кого есть доступ к его отделу.');
    expect(en.window.pictureUploading).toBe('Uploading the file...');
    expect(ru.window.pictureUploading).toBe('Файл загружается...');
    expect(en.window.pictureUploaded).toBe('The file path is in the terminal. Press Enter to send it.');
    expect(ru.window.pictureUploaded).toBe('Путь к файлу вставлен в терминал. Нажмите Enter для отправки.');
  });

  it('names the notebook saving state in English and Russian', () => {
    expect(en.notebook.saving).toBe('Saving');
    expect(ru.notebook.saving).toBe('Сохранение');
  });

  it('names a hidden employee in English and Russian', () => {
    expect(en.window.hiddenEmployee).toBe('Employee');
    expect(ru.window.hiddenEmployee).toBe('Сотрудник');
  });

  it('names separate material viewing and choice answer actions in English and Russian without changing existing labels', () => {
    expect(en.tasks.approve).toBe('Approve');
    expect(ru.tasks.approve).toBe('Одобрить');
    expect(en.tasks.decline).toBe('Decline');
    expect(ru.tasks.decline).toBe('Отклонить');
    expect(en.tasks.sendAnswer).toBe('Send answer');
    expect(ru.tasks.sendAnswer).toBe('Отправить ответ');
    expect(en.tasks.cancelTask).toBe('Cancel task');
    expect(ru.tasks.cancelTask).toBe('Отменить задачу');
    expect(en.tasks.seeWork).toBe('See the work');
    expect(ru.tasks.seeWork).toBe('Посмотреть работу');
    expect(en.tasks.sendFeedback).toBe('Send without choosing');
    expect(ru.tasks.sendFeedback).toBe('Отправить без выбора');
    expect(en.tasks.chooseOption(2)).toBe('Choose option 2');
    expect(ru.tasks.chooseOption(2)).toBe('Выбрать вариант 2');
    expect(en.tasks.materials.open).toBe('Open');
    expect(ru.tasks.materials.open).toBe('Открыть');
    expect(en.tasks.materials.showAll(14)).toBe('Show all: 14');
    expect(ru.tasks.materials.showAll(14)).toBe('Показать все: 14');
    expect(en.tasks.materials.picturePos(2, 3)).toBe('Picture 2 of 3');
    expect(ru.tasks.materials.picturePos(2, 3)).toBe('Картинка 2 из 3');
    expect(en.tasks.materials.materialPos(1, 4)).toBe('Material 1 of 4');
    expect(ru.tasks.materials.materialPos(1, 4)).toBe('Материал 1 из 4');
    expect(en.tasks.materials.pageOf(1, 5)).toBe('Page 1 of 5');
    expect(ru.tasks.materials.pageOf(1, 5)).toBe('Страница 1 из 5');
    expect(en.tasks.materials.endOfDocument).toBe('End of document. Shown in full.');
    expect(ru.tasks.materials.endOfDocument).toBe('Конец документа. Показано целиком.');
    expect(en.tasks.materials.incomplete).toBe('Not all of the document is loaded yet.');
    expect(ru.tasks.materials.incomplete).toBe('Документ загружен еще не полностью.');
    expect(en.tasks.materials.pdfUnavailable).toBe('PDF preview is not available right now. Download the file.');
    expect(ru.tasks.materials.pdfUnavailable).toBe('Просмотр PDF пока недоступен. Скачайте файл.');
    expect(en.tasks.materials.proposalNote).toBe('Original proposal. Your changes are not part of it.');
    expect(ru.tasks.materials.proposalNote).toBe('Исходное предложение. Ваши правки в него не входят.');
    expect(en.failures.model_access_denied).toBe('this plan cannot use the selected model');
    expect(ru.failures.model_access_denied).toBe('этот тариф не дает доступ к выбранной модели');
  });

  it('formats plural and duration helpers consistently across numeric ranges in every language of the registry', () => {
    for (const dict of LANGUAGES.map(({ id }) => DICTIONARIES[id])) {
      for (const count of [0, 1, 2, 5, 11, 21]) {
        expect(dict.companyTemplates.employees(count)).toContain(String(count));
        expect(dict.map.decisionsOf('Ivan', count)).toContain('Ivan');
        expect(dict.updates.cutText(count)).toContain(String(count || 0));
      }
      expect(dict.map.decisionsOf('Ivan', null)).toContain('Ivan');
      expect(dict.agent.every(15)).toContain('15');
      expect(dict.agent.every(60).length).toBeGreaterThan(0);
      expect(dict.agent.every(120)).toContain('2');
      expect(dict.machines.part({ kind: 'tests', run: 7, task: null, part: 1, parts: 1 })).toContain('7');
      expect(dict.machines.part({ kind: 'work', run: 8, task: 512, part: 2, parts: 4 })).toContain('512');
      expect(dict.machines.drainWaiting(0, 0, '12:00')).toContain('12:00');
      expect(dict.machines.drainWaiting(1, 0, '12:00')).toContain('1');
      expect(dict.machines.drainWaiting(0, 2, '12:00')).toContain('2');
      expect(dict.machines.drainWaiting(5, 11, '12:00')).toContain('5');
      expect(dict.dept.tree.dur(0)).toContain('0');
      expect(dict.dept.tree.dur(45)).toContain('45');
      expect(dict.dept.tree.dur(60)).toContain('1');
      expect(dict.dept.tree.dur(125)).toContain('2');
      expect(dict.dept.tree.verdict(true, null).length).toBeGreaterThan(0);
      expect(dict.dept.tree.verdict(false, 2)).toContain('2');
      expect(dict.dept.now.retryAttempt(1, null, null)).toContain('1');
      expect(dict.dept.now.retryAttempt(2, 5, '12:05')).toContain('5');
      expect(dict.dept.stats(1, 2, 3)).toContain('1');
      expect(dict.dept.stats(1, 1, 2)).toContain('2');
      expect(dict.dept.statusSummary({ working: 1, idle: 2 })).toContain('1');
      expect(dict.updates.result({ state: 'done', version: '0.8.0' }, '0.7.0')).toContain('0.8.0');
      expect(dict.updates.result({ state: 'rolled_back', version: '0.8.0' }, '0.7.0')).toContain('0.7.0');
      expect(dict.updates.result({ state: 'failed', version: '0.8.0' }, '0.7.0')).toContain('0.8.0');
      expect(dict.window.noticeSource('task', '', '', 'Agent')).toContain('Agent');
    }
  });
});

describe("the words of a copy's question to the CEO", () => {
  it('words the question in both languages', () => {
    const said = (dict: typeof en): Record<string, string> =>
      Object.fromEntries(Object.entries(dict.question).map(([key, value]) => [key, typeof value === 'function' ? (value as (...words: string[]) => string)('a', 'b', 'c', 'd') : value]));
    const [english, russian] = [said(en), said(ru)];
    expect(Object.keys(russian).sort()).toEqual(Object.keys(english).sort());
    expect(Object.keys(english)).toEqual(expect.arrayContaining(['oneCopy', 'moreCopies', 'goOn', 'goOnAt', 'wait', 'warning', 'waiting', 'ceoOnly']));
    for (const [key, text] of Object.entries(russian)) {
      expect(text.length, key).toBeGreaterThan(0);
      expect(text, key).not.toMatch(/[ёЁ—]|компьютер|узел|узл/i);
      expect(text, key).not.toBe(english[key]);
    }
    for (const [key, text] of Object.entries(english)) expect(text, key).not.toMatch(/—/);
    /* A time that is not known is left out, in both. */
    expect(en.question.oneCopy('deb', null, 'mac', null)).toBe('deb stopped answering. This mac may not have what deb did last. That comes back when deb does.');
    expect(ru.question.oneCopy('deb', null, 'mac', null)).toBe('Машина deb перестала отвечать. У mac может не быть последнего, что сделала машина deb. Это вернется вместе с deb.');
    expect([en.errors.question_changed, ru.errors.question_changed]).toEqual(['The question changed. Look again.', 'Вопрос изменился. Посмотрите еще раз.']);
  });
});

describe('the words of a move of the server', () => {
  it('words the move and what follows it in both languages', () => {
    const said = (part: object): Record<string, string> =>
      Object.fromEntries(Object.entries(part).map(([key, value]) => [key, typeof value === 'function' ? (value as (...words: string[]) => string)('a', 'b', 'c') : (value as string)]));
    for (const [english, russian] of [[said(en.switch), said(ru.switch)], [said(en.switched), said(ru.switched)]] as const) {
      expect(Object.keys(russian).sort()).toEqual(Object.keys(english).sort());
      for (const [key, text] of Object.entries(russian)) {
        expect(text.length, key).toBeGreaterThan(0);
        expect(text, key).not.toMatch(/[ёЁ—]|компьютер|узел|узл/i);
        expect(text, key).not.toBe(english[key]);
      }
      for (const [key, text] of Object.entries(english)) expect(text, key).not.toMatch(/—/);
    }
    expect(Object.keys(en.switch)).toEqual(expect.arrayContaining(['moving', 'movingSomewhere', 'lost', 'lostLeader', 'cut']));
    expect(Object.keys(en.switched)).toEqual(expect.arrayContaining(['takeover', 'ceo', 'planned', 'diskFull', 'close']));
    /* A time nobody wrote down is left out. */
    expect([en.switched.takeover('mac', 'deb', null), ru.switched.takeover('mac', 'deb', null)]).toEqual(['Hornhoof runs on mac now. deb stopped answering.', 'Hornhoof теперь работает на mac. Машина deb перестала отвечать.']);
    expect([en.switched.ceo('mac', null), ru.switched.ceo('mac', null)]).toEqual(['Hornhoof runs on mac now, as you chose.', 'Hornhoof теперь работает на mac, как вы выбрали.']);
  });
});

describe('the words of copies', () => {
  /* Every string of a copy's part, each function called with words of its own. */
  const said = (dict: typeof en): Record<string, string> =>
    Object.fromEntries(Object.entries(dict.machines.copy).map(([key, value]) => [key, typeof value === 'function' ? (value as (...words: string[]) => string)('a', 'b', 'c') : value]));

  it('words copies in both languages', () => {
    const [english, russian] = [said(en), said(ru)];
    expect(Object.keys(russian).sort()).toEqual(Object.keys(english).sort());
    for (const [key, text] of Object.entries(russian)) {
      expect(text.length, key).toBeGreaterThan(0);
      expect(text, key).not.toMatch(/[ёЁ—]|компьютер|узел|узл/i);
      expect(text, key).not.toBe(english[key]);
    }
    for (const [key, text] of Object.entries(english)) expect(text, key).not.toMatch(/—/);
    expect([english.saving, russian.saving]).toEqual(['Copy: saving what it did while it led', 'Копия: сохраняет то, что сделано, пока она держала сервер']);
  });

  /* Every string of the server order, with the groups inside it, each function called with words of its own. */
  const flat = (part: object, under = ''): [string, string][] =>
    Object.entries(part).flatMap(([key, value]): [string, string][] =>
      typeof value === 'function' ? [[under + key, (value as (...words: unknown[]) => string)('a', 2, 'c')]] : typeof value === 'string' ? [[under + key, value]] : flat(value as object, `${under}${key}.`));

  it('words the move of the server in both languages', () => {
    const REASONS = ['already_leader', 'no_number', 'updating', 'switching', 'moving', 'leader', 'server_install'] as const;
    const words = (dict: typeof en) =>
      Object.fromEntries([...flat(dict.machines.move), ...REASONS.map((reason): [string, string] => [`errors.${reason}`, typeof dict.errors[reason] === 'function' ? (dict.errors[reason] as (host: string) => string)('a') : (dict.errors[reason] as string)])]);
    const [english, russian] = [words(en), words(ru)];
    expect(Object.keys(russian).sort()).toEqual(Object.keys(english).sort());
    expect(Object.keys(english)).toEqual(expect.arrayContaining(['here', 'ask', 'yes', 'cancel', 'stop', 'waiting', 'switching', 'failed', 'reason.no_answer', 'reason.not_ready', 'reason.behind', 'reason.no_link', 'reason.expired', 'reason.left', 'led', ...REASONS.map(reason => `errors.${reason}`)]));
    for (const [key, text] of Object.entries(russian)) {
      expect(text.length, key).toBeGreaterThan(0);
      expect(text, key).not.toMatch(/[ёЁ—]|компьютер|узел|узл/i);
      expect(text, key).not.toBe(english[key]);
    }
    for (const [key, text] of Object.entries(english)) expect(text, key).not.toMatch(/—/);
    expect([en.machines.move.led('d', '14:02'), ru.machines.move.led('d', '14:02')]).toEqual(['d ran the server until 14:02 and is up to date again.', 'Машина d держала сервер до 14:02, ее копия снова актуальна.']);
    /* The share is said only while there is one. */
    expect([en.machines.move.waiting('d', 40), en.machines.move.waiting('d', null)]).toEqual(['d takes the server once its copy is up to date (40%)', 'd takes the server once its copy is up to date.']);
    expect([ru.machines.move.waiting('d', 40), ru.machines.move.waiting('d', null)]).toEqual(['d возьмет сервер, как только ее копия станет актуальной (40%)', 'd возьмет сервер, как только ее копия станет актуальной.']);
    expect([en.errors.leader('d'), ru.errors.leader('d')]).toEqual(['d runs the company server. Move the server to another machine first.', 'На d работает сервер компании. Сначала перенесите сервер на другую машину.']);
  });

  it('words the server order in both languages', () => {
    const order = (dict: typeof en) => Object.fromEntries([...flat(dict.machines.priority), ['errors.leader_pin', dict.errors.leader_pin], ['errors.unfit', dict.errors.unfit]]);
    const [english, russian] = [order(en), order(ru)];
    expect(Object.keys(russian).sort()).toEqual(Object.keys(english).sort());
    expect(Object.keys(english)).toEqual(expect.arrayContaining(['why.pinned', 'online.often_off', 'part.few_cores', 'unfit.scope', 'onlyCopy', 'errors.unfit']));
    for (const [key, text] of Object.entries(russian)) {
      expect(text.length, key).toBeGreaterThan(0);
      expect(text, key).not.toMatch(/[ёЁ—]|компьютер|узел|узл/i);
      /* Two parts joined by a comma read the same in both. */
      if (key !== 'both') expect(text, key).not.toBe(english[key]);
    }
    for (const [key, text] of Object.entries(english)) expect(text, key).not.toMatch(/—/);
    /* How many departments a person sees, in the Russian forms. */
    expect([0, 1, 2, 5, 21].map(n => ru.machines.priority.unfit.scope('Анна', n).split(', а ')[1])).toEqual([
      'Анна не видит ни одного отдела.', 'Анна видит один отдел.', 'Анна видит 2 отдела.', 'Анна видит 5 отделов.', 'Анна видит 21 отдел.',
    ]);
  });
});

describe('the load given up at 30 seconds', () => {
  /* Design on #1654 (#1620): its number stays on one line with its unit, as #1601's units do, in every shipped language. */
  it.each(LANGUAGES.map(l => l.id))('keeps the number and its unit together in %s', id => {
    const said = DICTIONARIES[id].load.failed.timeout;
    expect(said).toMatch(/\d\u00a0\p{L}/u);
    expect(said).not.toMatch(/\d \p{L}/u);
  });
});

describe('request headings for another person', () => {
  it.each(LANGUAGES.map(l => l.id))('never addresses the viewer as you or вас in %s across every request kind', id => {
    const other = DICTIONARIES[id].tasks.asksOther;
    expect(Object.keys(other).sort()).toEqual(['approval', 'approvalOf', 'choice', 'question']);
    for (const [kind, format] of Object.entries(other)) {
      const text = format('Nadia');
      expect(text, kind).toContain('Nadia');
      expect(text, kind).not.toMatch(/\byou\b/i);
      expect(text, kind).not.toMatch(/(?:^|[^\p{L}])вас(?:$|[^\p{L}])/iu);
    }
  });

  it('keeps direct viewer phrasing on viewer-targeted strings', () => {
    expect(en.tasks.asksChoice('Nadia')).toBe('Nadia asks you to pick one');
    expect(en.tasks.asksApproval('Dana')).toBe('Dana asks you to approve a commit');
    expect(en.tasks.asksApprovalOf('Bruno')).toBe('Bruno asks you to approve this');
    expect(ru.tasks.asksApprovalOf('Bruno')).toBe('Bruno просит вас это одобрить');
  });
});
