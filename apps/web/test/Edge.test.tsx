import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Edge } from '../src/ui/Edge';

describe('the chamfered frame', () => {
  it('stands alone unless it is what a button shows', () => {
    const { container } = render(<Edge cut={12}>Body</Edge>);
    expect(container.children).toHaveLength(1);
    expect(container.querySelector('.halo')).toBeNull();
  });

  it("puts a button's glow and focus ring under the frame, with the frame's own cut, and hides them from screen readers", () => {
    const { container } = render(
      <button type="button">
        <Edge cut={12} corner halo>
          Body
        </Edge>
      </button>,
    );
    const button = container.querySelector('button')!;
    const [halo, frame] = [...button.children] as HTMLElement[];
    expect(button.children).toHaveLength(2);
    expect(halo).toHaveClass('halo');
    expect(frame).toHaveClass('edge');
    expect(halo).toHaveAttribute('aria-hidden', 'true');
    expect(halo.style.getPropertyValue('--cut')).toBe('12px');
    expect(frame.style.getPropertyValue('--cut')).toBe('12px');
    expect(halo.querySelector(':scope > .halo-glow > i')).not.toBeNull();
    expect(halo.querySelector(':scope > .halo-ring')).not.toBeNull();
    expect(halo.textContent).toBe('');
    expect(button).toHaveTextContent(/^Body$/);
  });
});
