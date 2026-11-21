import { useSyncExternalStore } from 'react';
import type { Language, Messages } from '../i18n';
import { skinsState, subscribeSkins } from '../skins/store';
import type { GuideCompanionKind, GuideStep, GuideVoicePack, GuideVoiceTriplet } from './types';

/* Built-in Egypt voice matching design #1812 (scenario.md / voices.js), kept separate from step logic.
   Cyberpunk (standard) voice lives in i18n/en.ts and i18n/ru.ts so every theme without its own voice
   gets the complete standard voice automatically. */
const EGYPT_VOICE: GuideVoicePack = {
  en: {
    company: [
      'Yes, master. What name shall we put in the company records?',
      'The name is entered. Your company has its place in the records.',
      'The name is still blank in the records. Check the field before you continue.',
    ],
    account: [
      'Enter your details so the company records show who is in charge.',
      'Your details are in order. We can choose a plan for the orchestrator.',
      'The account still needs attention. Check the note by the field.',
    ],
    plan: [
      'Choose the plan the orchestrator will work with. You can return to Subscriptions when you are ready.',
      'The plan is ready, master. The orchestrator can take your instructions.',
      'The plan has yet to connect. Read the note on the subscription and try again if the option is there.',
    ],
    machine: [
      'Follow the command on this page to connect the machine for your plan.',
      'Your machine is here, master. It is ready to serve the plan.',
      'The machine is still out of reach. Its latest state is recorded in Machines.',
    ],
    department: [
      'Call on the orchestrator to lay out the first department.',
      'The first department stands, master. There is room for your team.',
      'The layout has yet to change. Review the card and try applying it again.',
    ],
    staff: [
      'Choose Hire and decide who will take up the work in this department.',
      'The team is in place, master. There is someone to take the work.',
      'The team is still unchanged. Check the plan and the note on the hiring card.',
    ],
    goal: [
      'Open New goal and set down what you want the team to achieve.',
      'Your goal is on record, master. The team has a direction.',
      'Your goal is still a draft. Read the note in the form before saving again.',
    ],
    task: [
      'Open New task and set down the first piece of work for the department.',
      'Your task is recorded. I will tell you when work begins.',
      'The entry has yet to be confirmed. Check the tracker before you send it again.',
    ],
    work: [
      'Your task is in the queue, master. The tracker will show when someone takes it up.',
      'Yes, master. An employee has begun your first task.',
      'The work is waiting for attention, master. Open the task to see what it needs.',
    ],
  },
  ru: {
    company: [
      'Да, хозяин. Какое имя запишем в книгу компании?',
      'Имя записано. У вашей компании есть место в книге.',
      'Запись имени еще открыта. Проверьте поле перед тем, как продолжить.',
    ],
    account: [
      'Внесите свои данные, чтобы в книге компании было записано, кто ею управляет.',
      'С вашими данными все в порядке. Можно выбрать план для оркестратора.',
      'Запись об аккаунте еще требует внимания. Проверьте заметку у поля.',
    ],
    plan: [
      'Выберите план для оркестратора. К этому можно вернуться в разделе «Подписки», когда будете готовы.',
      'План готов, хозяин. Оркестратор может принимать ваши указания.',
      'План еще не подключен. Прочтите заметку у подписки и повторите попытку, если такая кнопка доступна.',
    ],
    machine: [
      'Выполните команду на этой странице, чтобы подключить машину для вашего плана.',
      'Машина на связи, хозяин. На ней сможет работать план.',
      'Машина пока недоступна. Последний статус указан в разделе «Машины».',
    ],
    department: [
      'Позовите оркестратора, чтобы заложить первый отдел.',
      'Первый отдел готов, хозяин. У вашей команды есть место для работы.',
      'Устройство компании пока не изменилось. Проверьте карточку и примените ее снова.',
    ],
    staff: [
      'Выберите «Нанять» и решите, кто возьмется за работу в этом отделе.',
      'Команда на месте, хозяин. Есть кому поручить работу.',
      'Состав команды пока не изменился. Проверьте план и заметку в карточке найма.',
    ],
    goal: [
      'Откройте «Новая цель» и запишите, чего должна достичь команда.',
      'Ваша цель записана, хозяин. У команды есть направление.',
      'Цель еще в черновике. Прочтите заметку в форме перед повторным сохранением.',
    ],
    task: [
      'Откройте «Новая задача» и запишите первое дело для отдела.',
      'Ваша задача записана. Я сообщу, когда начнется работа.',
      'Запись еще не подтверждена. Проверьте трекер перед повторной отправкой.',
    ],
    work: [
      'Задача в очереди, хозяин. Трекер покажет, когда за нее возьмутся.',
      'Да, хозяин. Сотрудник уже взялся за вашу первую задачу.',
      'Работа ждет внимания, хозяин. Откройте задачу и проверьте, что ей нужно.',
    ],
  },
};

const registry = new Map<string, GuideVoicePack>([['egypt', EGYPT_VOICE]]);
const voiceListeners = new Set<() => void>();

function notifyVoices(): void {
  voiceListeners.forEach(fn => fn());
}

/* Registers a theme voice pack by skinId without touching wizard steps; returns an unregister callback. */
export function registerGuideVoice(skinId: string, pack: GuideVoicePack): () => void {
  const prev = registry.get(skinId);
  registry.set(skinId, pack);
  notifyVoices();
  return () => {
    if (prev) registry.set(skinId, prev);
    else registry.delete(skinId);
    notifyVoices();
  };
}

function pickLine(custom: string | undefined, fallback: string): string {
  const text = custom?.trim();
  return text ? text : fallback;
}

/* Resolves [guidance, confirmed, recovery] for skinId + language + step, falling back to full standard voice. */
export function resolveGuideVoice(
  skinId: string,
  language: Language,
  step: GuideStep,
  t: Messages,
): GuideVoiceTriplet {
  const standard = t.guide.voices[step];
  const custom = registry.get(skinId)?.[language]?.[step];
  if (!custom) return standard;
  return [
    pickLine(custom[0], standard[0]),
    pickLine(custom[1], standard[1]),
    pickLine(custom[2], standard[2]),
  ];
}

export function guideCompanionKind(skinId: string): GuideCompanionKind {
  return skinId === 'egypt' ? 'reed' : 'signal';
}

/* Reads active skin/world id, integrating seamlessly with both skinsStore and #1803's data-world/data-theme attributes. */
export function readActiveGuideSkin(): string {
  if (typeof document !== 'undefined') {
    const { world, theme } = document.documentElement.dataset;
    if (world && registry.has(world)) return world;
    if (theme && registry.has(theme)) return theme;
  }
  return skinsState().active;
}

function subscribeActiveSkin(onChange: () => void): () => void {
  const unsubStore = subscribeSkins(onChange);
  voiceListeners.add(onChange);
  let observer: MutationObserver | null = null;
  if (typeof MutationObserver !== 'undefined' && typeof document !== 'undefined') {
    observer = new MutationObserver(onChange);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'data-world', 'data-surface'],
    });
  }
  return () => {
    unsubStore();
    voiceListeners.delete(onChange);
    observer?.disconnect();
  };
}

export function useActiveGuideSkin(): string {
  return useSyncExternalStore(subscribeActiveSkin, readActiveGuideSkin, () => 'cyberpunk');
}
