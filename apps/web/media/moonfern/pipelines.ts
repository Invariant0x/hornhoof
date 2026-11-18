import type { DepartmentPipeline } from '../../src/types';

/* The way every Development change goes: build, review, security and a TestFlight smoke test. */
export const MOONFERN_PIPELINE: DepartmentPipeline = {
  id: 'pl-beta', department: { id: 'dept-dev', name: 'Development' }, name: 'Beta build way',
  archived: false, version: 1, mayEdit: true, isDefault: true,
  why: 'Every change is built, reviewed by another maker, checked for security and smoke-tested on TestFlight.',
  stages: [
    { id: 's-build', parentId: null, name: 'Build', ownerRole: 'DEV-ENG', owner: null, position: 0, echelon: 'development' },
    { id: 's-review', parentId: 's-build', name: 'Review', ownerRole: 'DEV-REV', owner: { id: 'rev-codex', name: 'Marcus' }, position: 0, echelon: 'review' },
    { id: 's-security', parentId: 's-review', name: 'Security', ownerRole: 'DEV-SEC', owner: { id: 'dev-sec', name: 'Petra' }, position: 0, echelon: 'security' },
    { id: 's-smoke', parentId: 's-security', name: 'TestFlight smoke test', ownerRole: 'DEV-TEST', owner: { id: 'dev-test', name: 'Gideon' }, position: 0, echelon: 'tests' },
  ],
};

export const CARE_PIPELINE: DepartmentPipeline = {
  id: 'pl-care', department: { id: 'dept-mkt', name: 'Marketing' }, name: 'Houseplant care guides',
  archived: false, version: 1, isDefault: true,
  why: 'Write, check and publish the care guides beta testers will read.',
  stages: [
    { id: 's-care-brief', parentId: null, name: 'Write the brief', ownerRole: 'MKT-HEAD', owner: null, position: 0 },
    {
      id: 's-care-draft', parentId: 's-care-brief', name: 'Write the care pages', ownerRole: 'MKT-SEO',
      owner: { id: 'mkt-seo', name: 'Jonah' }, position: 0, echelon: 'development', oneShot: { fanOut: 30, judge: true },
    },
    { id: 's-care-publish', parentId: 's-care-draft', name: 'Publish the guides', ownerRole: 'MKT-HEAD', owner: null, position: 0 },
  ],
};
