import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DepartmentView } from '../src/screens/Department';
import { MapScreen } from '../src/screens/Map';
import { sameView, worldTransition } from '../src/ui/canvas';
import { ShellTop } from '../src/ui/shellBars';
import { DEV_ORG, ME, mockApi } from './api-mock';
import { fakeStream } from './fake-stream';

/* The world (map and open department schema) stays stationary under the UI HUD when shell bars come or go (#1874, #1882). */
function sizeBox(el: HTMLElement, width: number, height: number) {
  Object.defineProperties(el, {
    clientWidth: { configurable: true, value: width },
    clientHeight: { configurable: true, value: height },
  });
  el.getBoundingClientRect = () => new DOMRect(0, 0, width, height);
}

describe('the world stays stationary when shell bars appear or disappear (#1874)', () => {
  it.each([
    ['wide', 1440, 900],
    ['narrow', 375, 812],
  ] as const)('keeps the map world transform and map-room top identical on %s screens across ShellTop changes', async (_label, width, height) => {
    fakeStream();
    mockApi({
      'GET /api/org': [200, DEV_ORG],
      'GET /api/map/layout': [200, { blocks: {}, bends: {} }],
      'GET /api/version': [200, { version: '0.40.2', commit: 'abcdef1' }],
    });
    const ui = (top: number | null) => (
      <ShellTop value={top}>
        <MapScreen me={ME} windowOpen={false} onOpenOrchestrator={() => {}} />
      </ShellTop>
    );
    const { container, rerender } = render(ui(null));
    await screen.findByRole('button', { name: /^Development/ });
    const map = container.querySelector<HTMLElement>('.map')!;
    sizeBox(map, width, height);
    rerender(ui(null));
    await waitFor(() => expect(container.querySelector<HTMLElement>('.map .world')!.style.transform).not.toBe(''));
    const worldBefore = container.querySelector<HTMLElement>('.map .world')!.style.transform;
    const mapTopBefore = container.querySelector<HTMLElement>('.map-room')!.style.getPropertyValue('--map-top');

    for (const top of [120, 176, null]) {
      rerender(ui(top));
      expect(container.querySelector<HTMLElement>('.map .world')!.style.transform).toBe(worldBefore);
      expect(container.querySelector<HTMLElement>('.map-room')!.style.getPropertyValue('--map-top')).toBe(mapTopBefore);
    }
  });

  it('keeps an open department world transform stationary when shell bars come or go after opening', async () => {
    fakeStream();
    mockApi({ 'GET /api/org': [200, DEV_ORG] });
    const dept = DEV_ORG.departments[0]!;
    const ui = (top: number | null) => (
      <ShellTop value={top}>
        <DepartmentView
          me={ME}
          department={dept}
          deputies={[]}
          selected={null}
          panel={null}
          onBack={() => {}}
          onHire={() => {}}
          onOpen={() => {}}
          onOpenTask={() => {}}
        />
      </ShellTop>
    );
    const { container, rerender } = render(ui(null));
    const canvas = await waitFor(() => {
      const el = container.querySelector<HTMLElement>('.dview .dcanvas');
      expect(el).not.toBeNull();
      return el!;
    });
    sizeBox(canvas, 1440, 900);
    rerender(ui(null));
    await waitFor(() => expect(container.querySelector<HTMLElement>('.dview .world')!.style.transform).not.toBe(''));
    const worldBefore = container.querySelector<HTMLElement>('.dview .world')!.style.transform;

    for (const top of [120, 176, null]) {
      rerender(ui(top));
      expect(container.querySelector<HTMLElement>('.dview .world')!.style.transform).toBe(worldBefore);
    }
  });
});

describe('sameView and worldTransition', () => {
  it('compares views to the half pixel and transitions only for Fit glide or department fly', () => {
    expect(sameView({ x: 10, y: 20, k: 1 }, { x: 10.2, y: 19.8, k: 1 })).toBe(true);
    expect(sameView({ x: 10, y: 20, k: 1 }, { x: 10, y: 20, k: 1.5 })).toBe(false);
    const fly = 'transform 1.2s cubic-bezier(.55,0,.25,1)';
    expect(worldTransition(true, true, fly)).toBe('none');
    expect(worldTransition(false, false, fly)).toBe('none');
    expect(worldTransition('fly', false, fly)).toBe(fly);
    expect(worldTransition(true, false, fly)).toBe('transform .8s cubic-bezier(.3,.7,.2,1)');
    expect(worldTransition(true, false)).toBe('transform .8s cubic-bezier(.3,.7,.2,1)');
  });
});
