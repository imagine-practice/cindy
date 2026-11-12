// Value: a `var(--token)` reference that no stylesheet registers silently renders as an inherited
// colour instead of the intended semantic one. `--danger-text` did exactly that in 9 places
// (error text and the archived-project delete warning looked like ordinary body text).
// Minimal failure: add `text-[var(--danger-text)]` anywhere in renderer TSX — this test fails
// with the file:line list instead of shipping invisible colours.
// Tier: static guard over the renderer sources; no runtime, no browser.
// Limits: it checks token *existence*, not that the token resolves to the right colour in both
// themes, and it cannot see tokens produced by string concatenation (`--x-${i}`) or by a
// stylesheet outside `apps/desktop/src/renderer`.
// Standalone measurement: 1 case, 0.6s wall on Windows (2026-11-09).
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const RENDERER = fileURLToPath(new URL('..', import.meta.url));
const SOURCE = /\.(ts|tsx|css)$/;
/** Tokens the browser or Radix supplies at runtime; they are not ours to register. */
const RUNTIME_PREFIXES = ['radix-'];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      walk(target, out);
    } else if (SOURCE.test(entry.name)) out.push(target);
  }
  return out;
}

/** Every `--name` this renderer can legitimately resolve. */
function registeredTokens(files: readonly string[]): Set<string> {
  const tokens = new Set<string>();
  const colors = readFileSync(path.join(RENDERER, 'themes/colors.ts'), 'utf8');
  for (const match of colors.matchAll(/registerColor\(\s*['"]([a-z0-9-]+)['"]/g)) tokens.add(match[1]);
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    if (file.endsWith('.css')) {
      for (const match of text.matchAll(/--([a-z0-9-]+)\s*:/g)) tokens.add(match[1]);
    }
    // Inline custom properties: style={{ '--wl-key': … }} and setProperty('--x', …).
    for (const match of text.matchAll(/['"]--([a-z0-9-]+)['"]/g)) tokens.add(match[1]);
  }
  return tokens;
}

describe('renderer design token references', () => {
  it('references only tokens that are registered in themes/colors.ts or defined by a stylesheet', () => {
    const files = walk(RENDERER);
    const tokens = registeredTokens(files);
    const unknown = new Map<string, string[]>();
    for (const file of files) {
      if (!file.endsWith('.tsx')) continue;
      const text = readFileSync(file, 'utf8');
      // Tailwind arbitrary values: text-[var(--x)], bg-[var(--x)], border-[var(--x)] …
      for (const match of text.matchAll(/\[var\(--([a-z0-9-]+)\)\]/g)) {
        const name = match[1];
        if (tokens.has(name) || RUNTIME_PREFIXES.some(prefix => name.startsWith(prefix))) continue;
        const line = text.slice(0, match.index).split('\n').length;
        const at = `${path.relative(RENDERER, file).replace(/\\/g, '/')}:${line}`;
        unknown.set(name, [...(unknown.get(name) ?? []), at]);
      }
    }
    const report = [...unknown].map(([name, where]) => `--${name} → ${where.join(', ')}`).join('\n');
    expect(report, `Unregistered CSS variables used in renderer (they render as inherited text colour):\n${report}`)
      .toBe('');
  });
});
