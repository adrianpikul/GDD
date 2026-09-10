type Cell = 0 | 1 | 2;

const supportsUnicode =
  process.platform !== 'win32' ||
  Boolean(process.env.WT_SESSION) ||
  Boolean(process.env.TERM_PROGRAM);

const CHARS = supportsUnicode
  ? { full: '██', dim: '░░', empty: '  ' }
  : { full: '##', dim: '++', empty: '  ' };

const COLOR_MARK = '\x1b[38;2;0;82;180m';
const COLOR_SQUARE = '\x1b[97m';
const COLOR_DIM = '\x1b[2m';
const RESET = '\x1b[0m';

const GAP: Cell[][] = [[0], [0], [0], [0], [0]];

const G: boolean[][] = [
  [true, true, true, true],
  [true, false, false, false],
  [true, false, true, true],
  [true, false, false, true],
  [true, true, true, true]
];

const F: boolean[][] = [
  [true, true, true],
  [true, false, false],
  [true, true, false],
  [true, false, false],
  [true, false, false]
];

const T: boolean[][] = [
  [true, true, true],
  [false, true, false],
  [false, true, false],
  [false, true, false],
  [false, true, false]
];

const SQUARE: boolean[][] = [
  [true, true, true],
  [true, true, true],
  [true, true, true],
  [true, true, true],
  [true, true, true]
];

const FRAME_MS = 90;
const HOLD_MS = 220;

function maskToCells(mask: boolean[][], level: Cell): Cell[][] {
  return mask.map((row) => row.map((on) => (on ? level : 0)));
}

function concatGlyphs(glyphs: Cell[][][]): Cell[][] {
  return Array.from({ length: 5 }, (_, row) => glyphs.flatMap((glyph) => glyph[row] ?? []));
}

export function squareStartCol(): number {
  return (G[0]?.length ?? 0) + 1 + (F[0]?.length ?? 0) + 1 + (T[0]?.length ?? 0) + 1;
}

function paintGrid({ g, f, t, square }: { g: Cell; f: Cell; t: Cell; square: Cell }): Cell[][] {
  return concatGlyphs([
    maskToCells(G, g),
    GAP,
    maskToCells(F, f),
    GAP,
    maskToCells(T, t),
    GAP,
    maskToCells(SQUARE, square)
  ]);
}

function cellChar(cell: Cell): string {
  if (cell === 2) return CHARS.full;
  if (cell === 1) return CHARS.dim;
  return CHARS.empty;
}

export function useBannerColor(
  env: NodeJS.ProcessEnv = process.env,
  stdout: { isTTY?: boolean } = process.stdout
): boolean {
  return env.NO_COLOR === undefined && Boolean(stdout.isTTY);
}

export function renderBannerGrid(grid: Cell[][], colored: boolean): string[] {
  const squareColumn = squareStartCol();
  return grid.map((row) =>
    row
      .map((cell, column) => {
        const character = cellChar(cell);
        if (!colored || cell === 0) return character;
        const color = column >= squareColumn ? COLOR_SQUARE : COLOR_MARK;
        return cell === 1
          ? `${COLOR_DIM}${color}${character}${RESET}`
          : `${color}${character}${RESET}`;
      })
      .join('')
  );
}

function paintFrame(
  values: { g: Cell; f: Cell; t: Cell; square: Cell },
  colored: boolean
): string[] {
  return renderBannerGrid(paintGrid(values), colored);
}

export function buildGftBannerFrames(colored = false): string[][] {
  const steps: Array<{ g: Cell; f: Cell; t: Cell; square: Cell }> = [
    { g: 0, f: 0, t: 0, square: 0 },
    { g: 1, f: 0, t: 0, square: 0 },
    { g: 2, f: 0, t: 0, square: 0 },
    { g: 2, f: 1, t: 0, square: 0 },
    { g: 2, f: 2, t: 0, square: 0 },
    { g: 2, f: 2, t: 1, square: 0 },
    { g: 2, f: 2, t: 2, square: 0 },
    { g: 2, f: 2, t: 2, square: 1 },
    { g: 2, f: 2, t: 2, square: 2 }
  ];
  return steps.map((step) => paintFrame(step, colored));
}

export function finalGftBannerLines(colored = false): string[] {
  return paintFrame({ g: 2, f: 2, t: 2, square: 2 }, colored);
}

export function gddInitIntroLines(): string[] {
  return [
    'Welcome to GDD — a spec-driven development framework.',
    'Turn an idea into evidence-backed delivery',
    '\nWorkflow:',
    'define change → design → build → validate → archive'
  ];
}

export function canAnimateBanner(
  env: NodeJS.ProcessEnv = process.env,
  stdout: { isTTY?: boolean; columns?: number } = process.stdout
): boolean {
  if (
    !stdout.isTTY ||
    'CI' in env ||
    env.NO_COLOR !== undefined ||
    env.GFT_SDD_NO_ANIMATION !== undefined
  )
    return false;
  return (stdout.columns ?? 80) >= 40;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function writeFrame(lines: string[]): void {
  for (const line of lines) process.stdout.write(`\x1b[2K  ${line}\n`);
}

export async function printGftBanner(): Promise<void> {
  const frames = buildGftBannerFrames(useBannerColor());
  const finalFrame = frames[frames.length - 1];
  if (!finalFrame) return;

  if (!canAnimateBanner()) {
    console.log('');
    for (const line of finalFrame) console.log(`  ${line}`);
    return;
  }

  process.stdout.write('\n');
  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index];
    if (!frame) continue;
    if (index > 0) process.stdout.write(`\x1b[${frame.length}A`);
    writeFrame(frame);
    await sleep(index === frames.length - 1 ? HOLD_MS : FRAME_MS);
  }
}
