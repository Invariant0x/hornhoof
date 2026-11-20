import { render } from '@testing-library/react';
import { memo, type ComponentProps, type ReactElement } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { TreeView } from '../src/screens/TreeView';
import type { Department } from '../src/types';
import { DEV_TREE, TREE_ORG } from './api-mock';
import { taskRoute } from './task-route';

/* Every chip the tree draws, by its employee's name: the same Chip, counted as it renders. */
const drawn = vi.hoisted(() => [] as string[]);
vi.mock('../src/ui/Chip', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/ui/Chip')>();
  type Props = ComponentProps<typeof actual.Chip>;
  const draw = (actual.Chip as unknown as { type: (props: Props) => ReactElement }).type;
  return { ...actual, Chip: memo(function Chip(props: Props) { drawn.push(props.e.name); return draw(props); }) };
});

const view = (department: Department) => <LanguageProvider><TreeView tree={DEV_TREE} department={department} onOpenTask={() => {}} /></LanguageProvider>;
const lanes = () => [...document.querySelectorAll<HTMLElement>('.tv-labs .dept-chip')];
/* Where a lane's chip stands in the labels: its own offset and that of the place that holds it. */
const placed = (chip: HTMLElement) => parseFloat(chip.style.top) + (parseFloat(chip.parentElement!.style.top) || 0);

afterEach(() => { vi.restoreAllMocks(); });

/* #1595: a live update of one employee whose plate grows with its new words moves the lanes under it down, and draws no
   chip but that employee's again. */
it('moves the lanes under a plate that grows without drawing their chips again', () => {
  const department = TREE_ORG.departments.find(d => d.id === 'd2')!, agent = DEV_TREE.lines[0]!.agent;
  const { rerender } = render(view(department));
  const tops = lanes().map(placed);
  expect(tops.length).toBeGreaterThan(2);
  const long = 'Move the checkout to the new payment_provider_and_keep_every_old_receipt_readable in both languages for years';
  /* jsdom lays nothing out: the plate with the long title measures 130 px and the rest nothing, so they keep their size. */
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('dept-chip') && this.textContent!.includes(long) ? 130 : 0;
  });
  drawn.length = 0;
  /* The server sends the whole department again: every employee is a new object, and only one of them says anything new. */
  const task = { id: 't-long', number: 77, title: long, echelons: taskRoute() };
  rerender(view({ ...department, employees: department.employees.map(e => (e.id === agent.id ? { ...e, task } : { ...e })) }));
  expect(lanes().map(placed), 'the lanes under the grown plate moved down').toEqual(tops.map((top, i) => (i ? top + 130 - 84 : top)));
  expect([...new Set(drawn)], 'only the employee with new words is drawn again').toEqual([agent.name]);
});
