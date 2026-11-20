import { expect, it } from 'vitest';
import { RULES, rulesFor } from './css';

/* Every declaration a selector gets, outside any @media or inside the one named. */
const declsOf = (selector: string, media: string | null = null) => Object.assign({}, ...rulesFor(selector).filter(rule => rule.media === media).map(rule => rule.decls));

/* Design #1628 (style book 1.6, section 4 "Working now", spec sections 3 and 7): the dot of a task an employee works on now
   has a filled core in its ring's colour. Only the core's top layer breathes, on the product's dbreathe, down to a weakest
   opacity set per skin, 1 for a skin not measured yet; nothing breathes for a person who asked for less motion. */
it('sizes and times the working-now dot with tokens of its own, with no colour in them, its weakest core set per skin', () => {
  expect(declsOf(':root')).toMatchObject({
    '--tracker-dot-size': '14px', '--tracker-dot-ring': '2px', '--tracker-dot-core': '6px',
    '--tracker-pulse-time': '2.6s', '--tracker-pulse-ease': 'ease-in-out', '--tracker-pulse-low': '1',
  });
  expect(['cyberpunk', 'matrix', 'pixel', 'light'].map(skin => declsOf(`:root[data-theme='${skin}']`)['--tracker-pulse-low'])).toEqual(['.55', '.55', '.55', '.8']);
});

it('draws a still core in the ring of a task worked on now and breathes only its top layer, never under reduced motion', () => {
  expect(declsOf('.tr-status-dot')).toMatchObject({ position: 'relative', 'inline-size': 'var(--tracker-dot-size)', 'block-size': 'var(--tracker-dot-size)' });
  const core = RULES.find(rule => rule.media === null && rule.selectors.includes('.tr-status-dot.working.now::before') && rule.selectors.includes('.tr-status-dot.working.now::after'));
  expect(core?.decls).toEqual({
    content: "''", position: 'absolute', inset: '0', margin: 'auto', 'inline-size': 'var(--tracker-dot-core)', 'block-size': 'var(--tracker-dot-core)',
    'border-radius': '50%', background: 'var(--tracker-working-ring)', 'pointer-events': 'none',
  });
  expect(declsOf('.tr-status-dot.working.now::before')).toMatchObject({ opacity: 'var(--tracker-pulse-low)' });
  expect(declsOf('.tr-status-dot.working.now::after')).toMatchObject({ opacity: '1', animation: 'dbreathe var(--tracker-pulse-time) var(--tracker-pulse-ease) infinite' });
  expect(declsOf('.tr-status-dot.working.now::after', '(prefers-reduced-motion: reduce)')).toEqual({ animation: 'none' });
});
