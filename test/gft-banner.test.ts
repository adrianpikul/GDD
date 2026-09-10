import { describe, expect, it } from 'vitest';
import {
  buildGftBannerFrames,
  canAnimateBanner,
  finalGftBannerLines,
  gddInitIntroLines,
  squareStartCol
} from '../src/gft-banner.js';

describe('GFT init banner', () => {
  it('renders five rows with a filled square on the right', () => {
    const lines = finalGftBannerLines(false);
    const cell = lines[0]?.includes('██') ? '██' : '##';
    const squareWidth = cell.length * 3;

    expect(lines).toHaveLength(5);
    for (const line of lines) expect(line.slice(-squareWidth)).toBe(cell.repeat(3));
    expect(squareStartCol()).toBeGreaterThan(0);
  });

  it('reveals the filled square last', () => {
    const frames = buildGftBannerFrames(false);
    const full = frames.at(-1);
    const dimSquare = frames.at(-2);
    const beforeSquare = frames.at(-3);
    const cell = full?.[0]?.includes('██') ? '██' : '##';
    const dimCell = cell === '██' ? '░░' : '++';
    const squareWidth = cell.length * 3;

    expect(full?.[0]?.slice(-squareWidth)).toBe(cell.repeat(3));
    expect(dimSquare?.[0]?.slice(-squareWidth)).toBe(dimCell.repeat(3));
    expect(beforeSquare?.[0]?.slice(-squareWidth)).toBe(' '.repeat(squareWidth));
  });

  it('only animates in supported terminals', () => {
    expect(canAnimateBanner({}, { isTTY: false, columns: 80 })).toBe(false);
    expect(canAnimateBanner({ GFT_SDD_NO_ANIMATION: '1' }, { isTTY: true, columns: 80 })).toBe(
      false
    );
    expect(canAnimateBanner({ CI: '1' }, { isTTY: true, columns: 80 })).toBe(false);
    expect(canAnimateBanner({ NO_COLOR: '' }, { isTTY: true, columns: 80 })).toBe(false);
    expect(canAnimateBanner({}, { isTTY: true, columns: 39 })).toBe(false);
    expect(canAnimateBanner({}, { isTTY: true, columns: 80 })).toBe(true);
  });

  it('introduces the GDD lifecycle before integration selection', () => {
    expect(gddInitIntroLines()).toEqual([
      'Welcome to GDD — a spec-driven development framework.',
      'Turn an idea into evidence-backed delivery',
      '\nWorkflow:',
      'define change → design → build → validate → archive'
    ]);
  });
});
