import { render } from '@testing-library/react';
import { describe, expect, it, onTestFinished } from 'vitest';
import { LiveWay } from '../src/ui/wires';

describe('continuous work signals', () => {
  it('starts both signals on arrival at their phases and keeps their start across redraws', () => {
    /* jsdom has no SMIL clock. Capture this component's requests to the native SVG API. */
    const previous = Object.getOwnPropertyDescriptor(SVGElement.prototype, 'beginElementAt');
    const starts: { node: SVGElement; offset: number }[] = [];
    Object.defineProperty(SVGElement.prototype, 'beginElementAt', {
      configurable: true,
      value(this: SVGElement, offset: number) { starts.push({ node: this, offset }); },
    });
    onTestFinished(() => {
      if (previous) Object.defineProperty(SVGElement.prototype, 'beginElementAt', previous);
      else Reflect.deleteProperty(SVGElement.prototype, 'beginElementAt');
    });
    const { container, rerender } = render(<svg><LiveWay pts={[[0, 0], [120, 0]]} speed={60} tone="c" still={false} /></svg>);
    const motions = [...container.querySelectorAll('animateMotion')];
    expect(starts).toEqual([{ node: motions[0], offset: 0 }, { node: motions[1], offset: -1 }]);
    rerender(<svg><LiveWay pts={[[0, 0], [120, 0]]} speed={60} tone="c" still={false} /></svg>);
    rerender(<svg><LiveWay pts={[[0, 0], [120, 0]]} speed={60} tone="c" still /></svg>);
    expect(starts).toHaveLength(2);
  });

  it('keeps the path and both dots through redraws and a switch to slower motion', () => {
    const { container, rerender } = render(<svg><LiveWay pts={[[0, 0], [120, 0]]} speed={60} tone="c" still={false} /></svg>);
    const path = container.querySelector('path')!;
    const dots = [...container.querySelectorAll('circle')];
    const motions = [...container.querySelectorAll('animateMotion')];
    expect(dots).toHaveLength(2);
    expect(motions[0]).toHaveAttribute('dur', '2.00s');
    rerender(<svg><LiveWay pts={[[0, 0], [120, 0]]} speed={60} tone="c" still={false} /></svg>);
    expect(container.querySelector('path')).toBe(path);
    expect([...container.querySelectorAll('circle')]).toEqual(dots);
    rerender(<svg><LiveWay pts={[[0, 0], [120, 0]]} speed={60} tone="c" still /></svg>);
    expect(container.querySelector('path')).toBe(path);
    expect([...container.querySelectorAll('circle')]).toEqual(dots);
    expect(motions[0]).toHaveAttribute('dur', '8.00s');
    expect(motions[1]).toHaveAttribute('begin', '-4.00s');
    expect(motions[0]).toHaveAttribute('repeatCount', 'indefinite');
  });
});
