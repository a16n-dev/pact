import { describe, expect, it } from 'vitest';
import { rebaseText, textSplices } from '../src/text/diff';

function applySplices(text: string, from: string, to: string): string {
  for (const { index, deleteCount, insert } of textSplices(from, to)) {
    text = text.slice(0, index) + insert + text.slice(index + deleteCount);
  }
  return text;
}

describe('textSplices', () => {
  it.each([
    ['', 'abc'],
    ['abc', ''],
    ['the quick brown fox', 'the slow brown dog'],
    ['# Title\n\nbody', '# New title\n\nbody text\n'],
    ['emoji 😀 here', 'emoji 😃 there'],
  ])('turns %j into %j', (from, to) => {
    expect(applySplices(from, from, to)).toBe(to);
  });

  it('touches only the changed span', () => {
    expect(textSplices('one two three', 'one 2 three')).toEqual([
      { index: 4, deleteCount: 3, insert: '2' },
    ]);
    expect(textSplices('same', 'same')).toEqual([]);
  });
});

describe('rebaseText', () => {
  it('applies edits on top of independent changes', () => {
    expect(rebaseText('hello world', '> hello world', 'hello, world')).toBe('> hello, world');
    expect(rebaseText('a\nb\nc\n', 'a\nb\nc\nd\n', 'A\nb\nc\n')).toBe('A\nb\nc\nd\n');
  });

  it('returns either side when the other is unchanged', () => {
    expect(rebaseText('base', 'base', 'next')).toBe('next');
    expect(rebaseText('base', 'current', 'base')).toBe('current');
  });

  it('lands an insertion both sides made only once', () => {
    expect(rebaseText('ab', 'aXb', 'aXb')).toBe('aXb');
    expect(rebaseText('abc', 'aXc', 'aXc')).toBe('aXc');
  });

  it('keeps both sides where edits overlap', () => {
    expect(rebaseText('the cat sat', 'the dog sat', 'the bird sat')).toBe('the dogbird sat');
  });

  it('drops text deleted on either side', () => {
    expect(rebaseText('one two three', 'one three', 'one two three!')).toBe('one three!');
  });
});
