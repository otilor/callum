import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { lookForStage, Marble } from './Marble.js';

describe('Marble', () => {
  it('goes from grey to colour as people get closer', () => {
    expect(lookForStage('stranger').tone).toBe('grey');
    expect(lookForStage('hello').tone).toBe('cool');
    expect(lookForStage('following').tone).toBe('near');
    expect(lookForStage('talking').tone).toBe('warm');
    const filterOf = (tone: 'grey' | 'cool' | 'near' | 'warm') => {
      const { container } = render(<Marble seed={1} tone={tone} />);
      return (container.firstChild as HTMLElement).style.filter;
    };
    expect(filterOf('grey')).toContain('grayscale(1)');
    expect(filterOf('cool')).toBe('grayscale(0.62)');
    expect(filterOf('near')).toBe('grayscale(0.28)');
    expect(filterOf('warm')).toBe('saturate(1.1)');
  });

  it('gives the same face for the same seed and no ring when asked', () => {
    const a = render(<Marble seed={303} ring={null} />).container.firstChild as HTMLElement;
    const b = render(<Marble seed={303} ring={null} />).container.firstChild as HTMLElement;
    expect(a.style.background).toBe(b.style.background);
    expect(a.style.boxShadow).toBe('none');
  });
});
