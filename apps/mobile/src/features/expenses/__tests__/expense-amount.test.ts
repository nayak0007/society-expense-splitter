import {
  AMOUNT_PROBLEM_MESSAGES,
  amountTextProblem,
  formatPaiseForInput,
  groupIndianDigits,
  parseRupeeText,
} from '../schemas/expense-amount';

/**
 * The money boundary (Roadmap T074 §4): every accepted shape, every refused shape, and the
 * round trip in both directions.
 *
 * These are the tests that make "never a float" a fact rather than a claim. The parser is the
 * only place a rupee string becomes a number, so the boundary cases live here rather than behind
 * a rendered input: a component test could only reach them through the UI.
 */
const MAX_SAFE = Number.MAX_SAFE_INTEGER;

describe('parseRupeeText — accepted shapes', () => {
  it('reads plain digits as whole rupees', () => {
    expect(parseRupeeText('1234')).toEqual({ paise: 123_400, problem: null });
  });

  it('reads Indian-grouped rupees with paise', () => {
    expect(parseRupeeText('1,23,456.78')).toEqual({ paise: 12_345_678, problem: null });
    expect(parseRupeeText('12,345')).toEqual({ paise: 1_234_500, problem: null });
    expect(parseRupeeText('₹1,23,456.78')).toEqual({ paise: 12_345_678, problem: null });
  });

  it('reads a single paise as an integer', () => {
    expect(parseRupeeText('0.01')).toEqual({ paise: 1, problem: null });
  });

  it('pads one decimal place to paise rather than scaling it as a float', () => {
    // `1.5` is one rupee fifty paise — 150, not 15 and not 1.5.
    expect(parseRupeeText('1.5')).toEqual({ paise: 150, problem: null });
    expect(parseRupeeText('1.05')).toEqual({ paise: 105, problem: null });
  });

  it('tolerates surrounding whitespace', () => {
    expect(parseRupeeText('  2,500.00  ')).toEqual({ paise: 250_000, problem: null });
  });

  it('accepts the largest amount the wire can carry', () => {
    expect(parseRupeeText('9,00,71,99,25,47,409.91')).toEqual({ paise: MAX_SAFE, problem: null });
  });
});

describe('parseRupeeText — refused shapes', () => {
  it.each([
    ['', 'empty'],
    ['   ', 'empty'],
    ['-1', 'negative'],
    ['(500)', 'negative'],
    ['0', 'zero'],
    ['0.00', 'zero'],
    ['1.234', 'decimals'],
    ['1.', 'format'],
    ['1.2.3', 'format'],
    ['abc', 'format'],
    ['12a', 'format'],
    // Western grouping is a *different amount* from the Indian one, so it is refused rather than
    // reinterpreted: `1,23,456` and `123,456` are not the same number.
    ['123,456', 'grouping'],
    ['1,23,45', 'grouping'],
    ['1,2345', 'grouping'],
    [',123', 'grouping'],
  ])('refuses %s as %s', (text, problem) => {
    expect(parseRupeeText(text)).toEqual({ paise: null, problem });
  });

  it('refuses one paise above the safe ceiling', () => {
    expect(parseRupeeText('9,00,71,99,25,47,409.92')).toEqual({ paise: null, problem: 'range' });
  });
});

describe('formatPaiseForInput ← → parseRupeeText', () => {
  it.each([1, 99, 100, 150, 12_345_678, 250_000, MAX_SAFE])(
    'round-trips %i paise exactly',
    (paise) => {
      expect(parseRupeeText(formatPaiseForInput(paise)).paise).toBe(paise);
    },
  );

  it('formats the ceiling with Indian grouping', () => {
    expect(formatPaiseForInput(MAX_SAFE)).toBe('9,00,71,99,25,47,409.91');
  });
});

describe('groupIndianDigits', () => {
  it.each([
    ['1', '1'],
    ['123', '123'],
    ['1234', '1,234'],
    ['12345', '12,345'],
    ['123456', '1,23,456'],
    ['1234567', '12,34,567'],
  ])('groups %s as %s', (digits, grouped) => {
    expect(groupIndianDigits(digits)).toBe(grouped);
  });
});

describe('amountTextProblem', () => {
  it('is null for a valid amount and a sentence otherwise', () => {
    expect(amountTextProblem('1,23,456.78')).toBeNull();
    expect(amountTextProblem('123,456')).toBe(AMOUNT_PROBLEM_MESSAGES.grouping);
    expect(amountTextProblem('')).toBe(AMOUNT_PROBLEM_MESSAGES.empty);
  });
});
