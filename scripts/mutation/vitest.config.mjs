import product from '../../vitest.config.mjs';

/* Use the same pinned protocol source as the product run, without database or reporter setup. A built copy may belong
   to another candidate, and must not decide whether a mutation's unmodified baseline masks a secret. */
const alias = product.test.projects.find(project => project.test.name === '@hornhoof/protocol').test.alias;
export default { test: { alias, include: ['test/**/*.test.ts'], env: { TZ: 'UTC' } } };
