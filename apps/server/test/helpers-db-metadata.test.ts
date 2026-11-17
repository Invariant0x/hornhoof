import { describe, expect, it } from 'vitest';
import { decodeDatabaseMetadata, encodeDatabaseMetadata, type DatabaseMetadata } from './helpers-db-metadata.js';

const dump = Buffer.from('recorded migrated database');
const bytes = Buffer.from([0, 255, 13, 10, 1]);
const metadata: DatabaseMetadata = {
  shape: 'schema fingerprint',
  planner: '[{"oid":12,"relpages":1,"reltuples":2,"relallvisible":0}]',
  pointedAtBy: [['public.companies', ['public.people', 'public.agents']]],
  seeded: { tables: [{ name: 'net.horizon', rows: new Blob([bytes]) }], numbers: [{ name: 'public.events_seq', value: '9007199254740993' }] },
};

describe('prepared database metadata', () => {
  it('keeps catalog, planner, dependencies, binary seed rows and exact sequence values', async () => {
    const read = decodeDatabaseMetadata(await encodeDatabaseMetadata(metadata, dump), dump);
    expect(read.shape).toBe(metadata.shape);
    expect(read.planner).toBe(metadata.planner);
    expect(read.pointedAtBy).toEqual(metadata.pointedAtBy);
    expect(read.seeded.numbers).toEqual([{ name: 'public.events_seq', value: '9007199254740993' }]);
    expect(read.seeded.tables.map(t => t.name)).toEqual(['net.horizon']);
    expect(Buffer.from(await read.seeded.tables[0]!.rows.arrayBuffer())).toEqual(bytes);
  });

  it('rejects metadata paired with another dump', async () => {
    const text = await encodeDatabaseMetadata(metadata, dump);
    expect(() => decodeDatabaseMetadata(text, Buffer.from('another database'))).toThrow('does not match its migrated dump');
  });

  it('rejects an unsupported metadata version', async () => {
    const text = await encodeDatabaseMetadata(metadata, dump);
    expect(() => decodeDatabaseMetadata(text.replace('"version":1', '"version":2'), dump)).toThrow('does not match its migrated dump');
  });
});
