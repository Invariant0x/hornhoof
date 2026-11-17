import type { Company, Me, Org, PersonView } from '../../src/types';

export const MOONFERN_COMPANY: Company = {
  id: 'comp-moonfern',
  name: 'Moonfern',
};

export const MAYA_VIEW: PersonView = {
  id: 'p-maya',
  name: 'Maya Chen',
  email: 'maya@moonfern.app',
  title: 'CEO',
  status: 'active',
  isOwner: true,
  isCeoDelegate: false,
  access: { whole: true, departments: [], teams: [] },
  pendingDecisions: 2,
};

export const LEO_VIEW: Org['people'][number] = {
  id: 'p-leo',
  name: 'Leo Park',
  email: 'leo@moonfern.app',
  title: 'Marketing & Design',
  status: 'active',
  isOwner: false,
  isCeoDelegate: true,
  deputy: true,
  departments: ['dept-dsn', 'dept-mkt'],
  access: {
    whole: true,
    departments: [
      { id: 'dept-dsn', name: 'Design' },
      { id: 'dept-mkt', name: 'Marketing' },
    ],
    teams: [],
  },
  pendingDecisions: 1,
};

export const SAM_VIEW: PersonView = {
  id: 'p-sam',
  name: 'Sam Rivera',
  email: 'sam@moonfern.app',
  title: 'Head of Engineering',
  status: 'active',
  isOwner: false,
  isCeoDelegate: false,
  access: {
    whole: false,
    departments: [{ id: 'dept-dev', name: 'Development' }],
    teams: [],
  },
  pendingDecisions: 0,
};

export const MOONFERN_PEOPLE: PersonView[] = [MAYA_VIEW, LEO_VIEW, SAM_VIEW];

export const MOONFERN_ME: Me = {
  person: {
    id: MAYA_VIEW.id,
    companyId: MOONFERN_COMPANY.id,
    name: MAYA_VIEW.name,
    email: MAYA_VIEW.email ?? '',
    title: MAYA_VIEW.title,
    status: 'active',
    scopeKind: 'company',
    isOwner: true,
    isCeoDelegate: false,
  },
  company: MOONFERN_COMPANY,
  canDecideCompany: true,
};
