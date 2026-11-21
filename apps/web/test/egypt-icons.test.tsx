import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chooseSkin, initSkins } from '../src/skins/store';
import { AlertIcon, ConversationIcon, DepartmentIcon, ListIcon, MachineIcon, MapIcon, NotebookIcon, OrchestratorIcon, PayIcon, PeopleIcon, PlugIcon, SettingsIcon, TerminalIcon, ThemeShopIcon, TrackerIcon } from '../src/ui/icons';

function clearPage() {
  const root = document.documentElement;
  delete root.dataset.theme;
  delete root.dataset.scheme;
  delete root.dataset.cut;
  delete root.dataset.world;
  delete root.dataset.surface;
  delete root.dataset.grain;
  root.removeAttribute('style');
}

beforeEach(() => {
  localStorage.clear();
  clearPage();
  initSkins();
});

afterEach(() => {
  localStorage.clear();
  clearPage();
  initSkins();
});

describe('Ancient Egypt original CC0 icon set', () => {
  it('swaps navigation, payment, alert and tracker icons cleanly in Egypt and restores Cyberpunk icons on switch back', () => {
    const view = () => (
      <div>
        <MapIcon />
        <ListIcon />
        <PeopleIcon />
        <MachineIcon />
        <PlugIcon />
        <PayIcon kind="personal" />
        <PayIcon kind="api_key" />
        <AlertIcon />
        <TrackerIcon name="mine" />
        <TrackerIcon name="waits" />
        <TrackerIcon name="failure" />
        <TrackerIcon name="pipeline" />
        <TrackerIcon name="dates" />
        <TrackerIcon name="goals" />
        <TrackerIcon name="list" />
        <TrackerIcon name="board" />
        <TrackerIcon name="branch" />
        <TrackerIcon name="employees" />
        <SettingsIcon />
        <DepartmentIcon />
        <OrchestratorIcon />
        <ConversationIcon />
        <TerminalIcon />
        <NotebookIcon />
        <ThemeShopIcon />
      </div>
    );

    const { container, rerender } = render(view());
    const cyberpunkMarkup = container.innerHTML;
    expect(container.querySelectorAll('svg')).toHaveLength(25);
    expect([...container.querySelectorAll('svg')].every(svg => svg.getAttribute('aria-hidden') === 'true')).toBe(true);

    chooseSkin('egypt');
    rerender(view());
    const egyptMarkup = container.innerHTML;
    expect(egyptMarkup).not.toBe(cyberpunkMarkup);
    expect(container.querySelectorAll('svg')).toHaveLength(25);
    expect([...container.querySelectorAll('svg')].every(svg => svg.getAttribute('aria-hidden') === 'true')).toBe(true);
    expect(container.querySelectorAll('svg[data-icon-set="egypt"]')).toHaveLength(25);

    chooseSkin('cyberpunk');
    rerender(view());
    expect(container.innerHTML).toBe(cyberpunkMarkup);
    expect(container.querySelectorAll('svg[data-icon-set="egypt"]')).toHaveLength(0);
  });
});
