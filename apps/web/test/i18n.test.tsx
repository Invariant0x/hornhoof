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
});

describe('internal-first question explanations and error reasons', () => {
  it('provides plain human explanation labels and action kinds in English and Russian', () => {
    expect(en.tasks.situationLabel).toBe('Situation');
    expect(ru.tasks.situationLabel).toBe('Ситуация');
    expect(en.tasks.requiredActionLabel).toBe('What is needed from you');
    expect(ru.tasks.requiredActionLabel).toBe('Что нужно от вас');
    expect(en.tasks.consequenceLabel).toBe('Consequence');
    expect(ru.tasks.consequenceLabel).toBe('Последствия');
    expect(en.tasks.actionResourceLabel).toBe('Resource');
    expect(ru.tasks.actionResourceLabel).toBe('Ресурс');
    expect(en.tasks.actionScopeLabel).toBe('Scope');
    expect(ru.tasks.actionScopeLabel).toBe('Объем доступа');
    expect(en.tasks.actionDurationLabel).toBe('Duration');
    expect(ru.tasks.actionDurationLabel).toBe('Срок');
    expect(en.tasks.actionAmountLabel).toBe('Amount');
    expect(ru.tasks.actionAmountLabel).toBe('Сумма');
    expect(en.tasks.plainExplanationPending).toBe('A plain summary without code or commands is being prepared.');
    expect(ru.tasks.plainExplanationPending).toBe('Готовится простое объяснение без кода и команд.');
    expect(en.tasks.hiddenDecisionLabel).toBe('Decision');
    expect(ru.tasks.hiddenDecisionLabel).toBe('Решение');
    expect(en.tasks.actionKinds).toEqual({
      payment: 'Payment',
      owner_login: 'Subscription owner sign-in',
      manual_machine_action: 'Action on a machine',
      ceo_permission: 'CEO permission',
    });
    expect(ru.tasks.actionKinds).toEqual({
      payment: 'Оплата',
      owner_login: 'Вход владельца подписки',
      manual_machine_action: 'Действие на машине',
      ceo_permission: 'Разрешение CEO',
    });
  });

  it('translates 409 and 503 question routing and classification error reasons in both languages', () => {
    const reasons409 = [
      'stale_revision',
      'stale_route',
      'source_closed',
      'operation_conflict',
      'classification_required',
    ] as const;
    for (const reason of reasons409) {
      const failure = new ApiFailure(409, 'conflict', 'Server conflict.', reason);
      expect(errorText(en, failure)).toBe(en.errors[reason]);
      expect(errorText(ru, failure)).toBe(ru.errors[reason]);
      expect(en.errors[reason].length).toBeGreaterThan(10);
      expect(ru.errors[reason].length).toBeGreaterThan(10);
    }

    const reasons503 = ['internal_route_unavailable', 'source_producer_unavailable'] as const;
    for (const reason of reasons503) {
      const failure = new ApiFailure(503, 'unavailable', 'Service unavailable.', reason);
      expect(errorText(en, failure)).toBe(en.errors[reason]);
      expect(errorText(ru, failure)).toBe(ru.errors[reason]);
      expect(en.errors[reason].length).toBeGreaterThan(10);
      expect(ru.errors[reason].length).toBeGreaterThan(10);
    }
  });
});
