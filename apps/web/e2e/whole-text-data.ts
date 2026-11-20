import type { Department, DeptRole, Employee, Org, PersonView } from '../src/types';
import { taskRoute } from '../test/task-route';
import { ME } from './api';

/* The words a company's map and a department's screen show, in four kinds of text: plain English, Russian, a long pseudo
   translation and right to left Arabic, plus Japanese for a script with no spaces. Pseudo strings only test the rule; they
   are not translations. */
export type Script = 'en' | 'ru' | 'pseudo' | 'cjk' | 'rtl';

/* A person of the map: a name and a title; with no title the map says in its place what the person looks after. */
type Who = [name: string, title: string];

type Words = {
  depts: [string, string, string, string];
  products: string;
  task: string;
  head: string;
  headTitle: string;
  roles: { head: string; dev: string; devAbout: string; review: string; reviewAbout: string; test: string; testAbout: string };
  people: [string, string, string, string];
  memberTask: string;
  /* The map's people chips: the whole-company row on top, one person beside the second department and two beside the fourth,
     and three deputies, two placed under the lowest row and one between the two cards of the right column. */
  leaders: [Who, Who, Who];
  deptPeople: [Who, Who, Who];
  deputies: [Who, Who, Who];
};

const ACCENTS: Record<string, string> = {
  a: 'å', b: 'ƀ', c: 'ç', d: 'ð', e: 'é', f: 'ƒ', g: 'ĝ', h: 'ĥ', i: 'î', j: 'ĵ', k: 'ķ', l: 'ļ', m: 'ṁ', n: 'ñ', o: 'ö', p: 'þ', r: 'ŕ', s: 'š', t: 'ţ', u: 'û', v: 'ṽ', w: 'ŵ', y: 'ý', z: 'ž',
  A: 'Å', B: 'Ɓ', C: 'Ç', D: 'Ð', E: 'É', F: 'Ƒ', G: 'Ĝ', H: 'Ĥ', I: 'Î', K: 'Ķ', L: 'Ļ', M: 'Ṁ', N: 'Ñ', O: 'Ö', P: 'Þ', R: 'Ŕ', S: 'Š', T: 'Ţ', U: 'Û', W: 'Ŵ',
};
const accent = (s: string) => s.replace(/[a-zA-Z]/g, ch => ACCENTS[ch] ?? ch);
/* About twice as long as the English, as German or Finnish run, in brackets that show where a string ends. */
export const pseudo = (s: string) => `⟦${accent(s)} ${accent(s.split(' ').reverse().join(' '))}⟧`;
/* One word longer than any card is wide: it may break only because it fits no line of its own. */
export const LONG_WORD = accent('Softwareentwicklungsabteilungsleiterstellvertretungsbeauftragter');

const EN: Words = {
  depts: ['Development', 'Marketing', 'Sales', 'Support'],
  products: 'Shop, Mobile app',
  task: 'Checkout API',
  head: 'Hana',
  headTitle: 'Head of development',
  roles: { head: 'Head of development', dev: 'Developer', devAbout: 'Writes the code and its tests.', review: 'Code reviewer', reviewAbout: 'Reads every change.', test: 'Test engineer', testAbout: 'Checks the turn.' },
  people: ['Bruno', 'Dina', 'Rita', 'Tom'],
  memberTask: 'Card form',
  leaders: [['Mira', 'CEO'], ['Oskar', ''], ['Lena', 'Finance']],
  deptPeople: [['Ivo', ''], ['Nora', 'Support lead'], ['Pavel', '']],
  deputies: [['Sana', 'Partners'], ['Teo', 'Operations'], ['Alma', 'Customers']],
};

const RU: Words = {
  depts: ['Разработка', 'Маркетинг', 'Продажи', 'Поддержка'],
  products: 'Магазин, Приложение',
  task: 'API оплаты',
  head: 'Хана',
  headTitle: 'Глава разработки',
  roles: { head: 'Глава разработки', dev: 'Разработчик', devAbout: 'Пишет код и тесты к нему.', review: 'Ревьюер кода', reviewAbout: 'Читает каждое изменение.', test: 'Инженер по тестированию', testAbout: 'Проверяет ход.' },
  people: ['Бруно', 'Дина', 'Рита', 'Том'],
  memberTask: 'Форма карты',
  leaders: [['Мира', 'Генеральный директор'], ['Оскар', ''], ['Лена', 'Финансы']],
  deptPeople: [['Иво', ''], ['Нора', 'Ведущая поддержки'], ['Павел', '']],
  deputies: [['Сана', 'Партнеры'], ['Тео', 'Операционный отдел'], ['Альма', 'Клиенты']],
};

const LONG: Words = {
  depts: [
    pseudo('Development of payments and receipts'),
    `${pseudo('Marketing')} ${LONG_WORD}`,
    pseudo('Sales and partnerships'),
    pseudo('Support'),
  ],
  products: pseudo('Shop, Mobile app, Partner portal, Receipts archive'),
  task: pseudo('Move the checkout to the new payment provider and keep every old receipt readable'),
  head: `${pseudo('Hana Constantinopolskaya')} ${LONG_WORD}`,
  headTitle: pseudo('Head of development and of the payments platform'),
  roles: {
    head: pseudo('Head of development'),
    dev: `${pseudo('Developer of payments')} ${LONG_WORD}`,
    devAbout: pseudo('Writes the code of the checkout and its tests in both languages.'),
    review: pseudo('Code reviewer of the checkout'),
    reviewAbout: pseudo('Reads every change before it goes into the turn.'),
    test: pseudo('Test engineer of the whole turn'),
    testAbout: pseudo('Checks the turn on every machine before it is released.'),
  },
  people: [`${pseudo('Bruno')} ${LONG_WORD}`, pseudo('Dina Vasilievna'), pseudo('Rita'), pseudo('Tom')],
  memberTask: pseudo('Card form that checks the number and the date before it sends them'),
  leaders: [[`${pseudo('Mira Konstantinova')} ${LONG_WORD}`, pseudo('Chief executive officer')], [pseudo('Oskar'), ''], [pseudo('Lena'), pseudo('Finance and accounting')]],
  deptPeople: [[pseudo('Ivo'), ''], [pseudo('Nora Vasilievna'), `${pseudo('Support lead')} ${LONG_WORD}`], [pseudo('Pavel'), '']],
  deputies: [[pseudo('Sana'), pseudo('Partners and resellers')], [pseudo('Teo'), pseudo('Operations')], [pseudo('Alma'), pseudo('Customers and their contracts')]],
};

const CJK: Words = {
  depts: ['決済と領収書を長期間保存するための開発部門', 'マーケティング', '営業と提携', 'サポート'],
  products: 'ショップ、モバイルアプリ、パートナーポータル、領収書アーカイブ',
  task: '新しい決済事業者への移行と古い領収書をすべて読めるように保つ作業',
  head: '花子',
  headTitle: '開発部長と決済基盤の責任者',
  roles: { head: '開発部長', dev: '決済の開発者と領収書の担当者', devAbout: '決済のコードとそのテストを書きます。', review: 'コードレビュー担当', reviewAbout: 'すべての変更を読みます。', test: 'テスト担当', testAbout: 'リリース前にすべてのマシンで確認します。' },
  people: ['ブルーノ', 'ディナ', 'リタ', 'トム'],
  memberTask: 'カード番号と日付を送信前に確認するカードフォーム',
  leaders: [['ミラ', '最高経営責任者'], ['オスカー', ''], ['レナ', '財務と経理の責任者']],
  deptPeople: [['イヴォ', ''], ['ノラ', 'サポートチームのリーダー'], ['パヴェル', '']],
  deputies: [['サナ', 'パートナーと販売代理店'], ['テオ', '業務運営'], ['アルマ', '顧客と契約の担当者']],
};

const RTL: Words = {
  depts: ['قسم تطوير أنظمة الدفع والإيصالات طويلة الأمد', 'التسويق', 'المبيعات والشراكات', 'الدعم'],
  products: 'المتجر، تطبيق الهاتف، بوابة الشركاء، أرشيف الإيصالات',
  task: 'نقل الدفع إلى المزود الجديد مع إبقاء كل الإيصالات القديمة مقروءة',
  head: 'هناء قسطنطين',
  headTitle: 'رئيسة قسم التطوير ومنصة المدفوعات',
  roles: { head: 'رئيس التطوير', dev: 'مطور أنظمة الدفع', devAbout: 'يكتب الشيفرة واختباراتها.', review: 'مراجع الشيفرة', reviewAbout: 'يقرأ كل تغيير.', test: 'مهندس الاختبار', testAbout: 'يفحص الدورة قبل إصدارها.' },
  people: ['برونو', 'دينا', 'ريتا', 'توم'],
  memberTask: 'نموذج البطاقة الذي يفحص الرقم والتاريخ قبل إرسالهما',
  leaders: [['ميرا', 'الرئيسة التنفيذية'], ['أوسكار', ''], ['لينا', 'المالية والمحاسبة']],
  deptPeople: [['إيفو', ''], ['نورا', 'قائدة فريق الدعم'], ['بافل', '']],
  deputies: [['سنا', 'الشركاء والموزعون'], ['تيو', 'العمليات'], ['ألما', 'العملاء وعقودهم']],
};

export const WORDS: Record<Script, Words> = { en: EN, ru: RU, pseudo: LONG, cjk: CJK, rtl: RTL };

/* The hint at the foot of a department's screen, as a long translation would put it. */
export const LONG_HINT = `${pseudo('Work goes left to right through the gates. Whoever leads a stage now is marked in its role.')} ${LONG_WORD}`;

const both = (s: string) => ({ en: s, ru: s });

const role = (id: string, title: string, about: string, kind: DeptRole['kind'], gate: number | null = null, schema?: DeptRole['schema']): DeptRole => ({
  id, title: both(title), description: both(about), kind, gate, ...(schema ? { schema } : {}),
});

const employee = (id: string, name: string, roleId: string, over: Partial<Employee> = {}): Employee => ({
  id, name, roleId, title: null, kind: 'worker', model: 'claude-opus-5-5', modelName: 'Opus 5.5', provider: 'claude', state: 'sleeping', status: 'idle', on: true,
  effort: null, timer: null, task: null, context: null, program: null, alarm: null, retry: null, failure: null, ...over,
});

const NOW = '2026-11-05T12:00:00.000Z';

/* Someone of the map with no decisions waiting, seeing the whole company unless the department list says what they reach. */
const person = (id: string, [name, title]: Who, departments: { id: string; name: string }[] = []): PersonView => ({
  id, name, email: `${id}@example.com`, title, status: 'active', isOwner: false, pendingDecisions: null,
  access: { whole: !departments.length, departments, teams: [] },
});

/* A company of four departments; the first, d2 as the routes of the API fixture answer it, has a head and staff in three
   stages and works on a task. */
export function wholeTextOrg(script: Script): Org {
  const w = WORDS[script];
  const task = (id: string, number: number, title: string) => ({ id, number, title, echelons: taskRoute('development', 'b1') });
  const staff: Employee[] = [
    employee('h1', w.head, 'R-HEAD', { kind: 'head', title: both(w.headTitle), status: 'working', state: 'working', task: task('t12', 12, w.task), context: 0.4 }),
    employee('b1', w.people[0], 'R-DEV', { status: 'working', state: 'working', task: task('t13', 13, w.memberTask), context: 0.2 }),
    employee('b2', w.people[1], 'R-DEV'),
    employee('b3', w.people[2], 'R-REV'),
    employee('b4', w.people[3], 'R-TEST'),
  ];
  const roles = [
    role('R-HEAD', w.roles.head, '', 'head'),
    role('R-DEV', w.roles.dev, w.roles.devAbout, 'member'),
    role('R-REV', w.roles.review, w.roles.reviewAbout, 'member', 1),
    role('R-TEST', w.roles.test, w.roles.testAbout, 'member', null, 'final_check'),
  ];
  const dept = (i: number, employees: Employee[], more: Partial<Department> = {}): Department => ({
    id: `d${i + 2}`, name: w.depts[i]!, templateKey: null, roleCode: ['DEV', 'MKT', 'SAL', 'SUP'][i]!, about: '',
    agents: { total: employees.length, working: employees.filter(e => e.status === 'working').length },
    products: [], teams: [], people: [], employees, roles: employees.length ? roles : [], workLines: [], reworkAt: null, ...more,
  });
  /* The department people stand beside the second and the fourth department, so the first, whose screen the checks open,
     keeps its own. */
  const own = (i: number) => [{ id: `d${i + 2}`, name: w.depts[i]! }];
  const departments = [
    dept(0, staff, { products: w.products.split(/[,、،]\s*/).map((name, i) => ({ id: `p${i}`, name })), current: { id: 't12', number: 12, title: w.task } }),
    dept(1, [employee('m1', w.people[1], 'R-DEV')], { current: { id: 't20', number: 20, title: w.memberTask }, people: [person('n1', w.deptPeople[0], own(1))] }),
    dept(2, []),
    dept(3, [employee('s1', w.people[3], 'R-DEV')], { people: [person('n2', w.deptPeople[1], own(3)), person('n3', w.deptPeople[2], own(3))] }),
  ];
  /* Deputies reach the departments they look after by the list the map reads, and no department's screen by their access. */
  const deputy = (id: string, who: Who, of: string[]) => ({ ...person(id, who, []), access: { whole: false, departments: [], teams: [] }, deputy: true, departments: of });
  const people = [
    ...w.leaders.map((who, i) => person(`l${i + 1}`, who)),
    deputy('v1', w.deputies[0], ['d3', 'd4']),
    deputy('v2', w.deputies[1], ['d4', 'd5']),
    deputy('v3', w.deputies[2], ['d3', 'd5']),
  ];
  return { company: ME.company, orchestrator: null, agents: { total: 7, working: 2 }, people, serverNow: NOW, departments };
}
