import { describe, expect, it } from 'vitest';
import { parseBeat, type Stance } from '../src/modules/keeper/beats.js';

const term = { number: 7, machine: 'net-a', split: false };
const aBeat = (stance: unknown) => ({
  machine: 'net-a',
  host: 'debian',
  stance,
  number: 1,
  reach: '2026-11-03T23:40:00.000Z',
  ready: true,
  full: false,
});

describe('parseBeat', () => {
  const stances: [name: string, stance: Stance][] = [
    ['I lead', { kind: 'lead', term, lease: 'normal', sync: 'net-b', until: 1e12 }],
    ['I lead under a split term with no sync', { kind: 'lead', term: { ...term, split: true }, lease: 'split', sync: null, until: 1e12 }],
    ['I lead in maintenance', { kind: 'lead', term, lease: 'maintenance', sync: null, until: 1e12 }],
    ['I follow', { kind: 'follow', term }],
    ['I follow, with no term kept yet', { kind: 'follow', term: null }],
    ['I am attempting', { kind: 'attempting' }],
    ['I am handing over', { kind: 'handing', to: 'net-b' }],
    ['idle', { kind: 'idle', term }],
    ['idle, with no term', { kind: 'idle', term: null }],
  ];

  it.each(stances)('reads a beat that says: %s', (_name, stance) => {
    expect(parseBeat(aBeat(stance))).toEqual(aBeat(stance));
  });

  it('reads a machine with no place in the order and no reach yet', () => {
    const beat = { ...aBeat({ kind: 'attempting' }), number: null, reach: null };
    expect(parseBeat(beat)).toEqual(beat);
  });

  /* Messages between keepers change only by additions, so what a newer keeper adds must not read as silence. */
  it('reads a beat from a newer keeper that says more', () => {
    const stance = { kind: 'follow', term };
    expect(parseBeat({ ...aBeat({ ...stance, extra: true }), disk: 85 })).toEqual(aBeat(stance));
  });

  const refused: [name: string, body: unknown][] = [
    ['no body', null],
    ['a body that is not an object', 'lead'],
    ['a stance of another kind', aBeat({ kind: 'other' })],
    ['no stance', aBeat(undefined)],
    ['a lead stance with no term', aBeat({ kind: 'lead', lease: 'normal', sync: null, until: 1 })],
    ['a lead stance with another lease kind', aBeat({ kind: 'lead', term, lease: 'other', sync: null, until: 1 })],
    ['a lead stance with no end of its lease', aBeat({ kind: 'lead', term, lease: 'normal', sync: null })],
    ['a handing stance with no target', aBeat({ kind: 'handing' })],
    ['a term whose number is not whole', aBeat({ kind: 'follow', term: { ...term, number: 1.5 } })],
    ['a term whose number is below 0', aBeat({ kind: 'follow', term: { ...term, number: -1 } })],
    ['a term with no machine', aBeat({ kind: 'follow', term: { ...term, machine: '' } })],
    ['a term with no split', aBeat({ kind: 'follow', term: { number: 7, machine: 'net-a' } })],
    ['a sender with no id', { ...aBeat({ kind: 'attempting' }), machine: '' }],
    ['a host that is not text', { ...aBeat({ kind: 'attempting' }), host: 7 }],
    ['a place in the order that is not a number', { ...aBeat({ kind: 'attempting' }), number: '1' }],
    ['a reach that is not text', { ...aBeat({ kind: 'attempting' }), reach: 7 }],
    ['a ready that is not a boolean', { ...aBeat({ kind: 'attempting' }), ready: 'yes' }],
    ['a full that is missing', { ...aBeat({ kind: 'attempting' }), full: undefined }],
  ];

  it.each(refused)('refuses %s', (_name, body) => {
    expect(parseBeat(body)).toBeNull();
  });
});
