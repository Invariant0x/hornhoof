import { getTableColumns } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { tasks } from '../src/db/schema.js';

describe('one route without the replaced task gate state', () => {
  it.each(['gates', 'panel', 'stage', 'merging', 'bounces'])('does not retain the obsolete %s field', field => {
    expect(Object.keys(getTableColumns(tasks))).not.toContain(field);
  });
});
