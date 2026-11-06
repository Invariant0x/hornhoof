import { describe, expect, it, vi } from 'vitest';
import { api, ApiFailure } from '../src/api';
import { detectLanguage, errorText, plural } from '../src/i18n';
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

describe('The agent in the center', () => {
  it('is the orchestrator in both languages, since the chief is the CEO', () => {
    expect(textsOf(en).filter(t => /chief/i.test(t))).toEqual([]);
    expect(textsOf(ru).filter(t => /шеф/i.test(t))).toEqual([]);
  });
});

describe('errorText', () => {
  it('shows a known reason in the chosen language', () => {
    expect(errorText(ru, new ApiFailure(401, 'unauthorized', 'Wrong email or password.', 'wrong_password'))).toBe(ru.errors.wrong_password);
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
  it('uses the actual turn, branch and times in both languages', () => {
    for (const L of [en.dept.tree, ru.dept.tree]) {
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
    expect(en.window.pictureUploading).toBe('Uploading the picture...');
    expect(ru.window.pictureUploading).toBe('Картинка загружается...');
    expect(en.window.pictureUploaded).toBe('The picture path is in the terminal. Press Enter to send it.');
    expect(ru.window.pictureUploaded).toBe('Путь к картинке вставлен в терминал. Нажмите Enter для отправки.');
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
    expect(en.failures.model_access_denied).toBe('model access denied');
    expect(ru.failures.model_access_denied).toBe('нет доступа к модели');
  });

  it('formats plural and duration helpers consistently across numeric ranges in English and Russian', () => {
    for (const dict of [en, ru]) {
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
      expect(dict.dept.stats(1, 2, 3, 0)).toContain('1');
      expect(dict.dept.stats(1, 1, 1, 2)).toContain('2');
      expect(dict.dept.statusSummary({ working: 1, idle: 2 })).toContain('1');
      expect(dict.updates.result({ state: 'done', version: '0.8.0' }, '0.7.0')).toContain('0.8.0');
      expect(dict.updates.result({ state: 'rolled_back', version: '0.8.0' }, '0.7.0')).toContain('0.7.0');
      expect(dict.updates.result({ state: 'failed', version: '0.8.0' }, '0.7.0')).toContain('0.8.0');
      expect(dict.window.noticeSource('task', '', '', 'Agent')).toContain('Agent');
    }
  });
});
