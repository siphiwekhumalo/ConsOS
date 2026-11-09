import { describe, expect, it } from 'vitest';
import { compile, evaluate, FormulaError, LIMITS } from '../src';

const n = (src: string, vars = {}) => evaluate(src, vars).toString();

describe('arithmetic', () => {
  it('uses decimal arithmetic, not binary floats', () => {
    expect(n('0.1 + 0.2')).toBe('0.3');
    expect(evaluate('0.1 + 0.2 == 0.3')).toBe(true);
    expect(n('1250000.10 * 3')).toBe('3750000.3');
  });

  it('respects precedence and parentheses', () => {
    expect(n('2 + 3 * 4')).toBe('14');
    expect(n('(2 + 3) * 4')).toBe('20');
    expect(n('-2 * -3')).toBe('6');
    expect(n('10 - 4 - 3')).toBe('3'); // left-associative
    expect(n('10 % 4')).toBe('2');
  });

  it('rounds half-up for money', () => {
    expect(n('round(2.345, 2)')).toBe('2.35');
    expect(n('round(-2.345, 2)')).toBe('-2.35');
    expect(n('round(10 / 3, 2)')).toBe('3.33');
  });
});

describe('construction rules', () => {
  it('overtime above 45 hours at 1.5x', () => {
    const f = compile('if(hours > 45, (hours - 45) * rate * 1.5, 0)');
    expect(f.variables).toEqual(['hours', 'rate']);
    expect(f.evaluateNumber({ hours: '50', rate: '85.40' }).toString()).toBe('640.5');
    expect(f.evaluateNumber({ hours: '40', rate: '85.40' }).toString()).toBe('0');
  });

  it('retention at 10% capped at 5% of contract value', () => {
    const f = compile('round(min(gross * 0.10, contract_value * 0.05 - retained_to_date), 2)');
    expect(f.evaluateNumber({ gross: '2000000', contract_value: '48500000', retained_to_date: '0' }).toString()).toBe('200000');
    expect(
      f.evaluateNumber({ gross: '2000000', contract_value: '48500000', retained_to_date: '2350000' }).toString(),
    ).toBe('75000');
  });

  it('site allowance with boolean conditions', () => {
    const f = compile('if(remote_site and not accommodation_provided, days * 350, 0)');
    expect(f.evaluateNumber({ remote_site: true, accommodation_provided: false, days: 22 }).toString()).toBe('7700');
    expect(f.evaluateNumber({ remote_site: true, accommodation_provided: true, days: 22 }).toString()).toBe('0');
  });

  it('clamp for escalation bounds', () => {
    expect(n('clamp(index_ratio - 1, 0, 0.15)', { index_ratio: '1.21' })).toBe('0.15');
  });
});

describe('safety', () => {
  it('if() is lazy, so the untaken branch cannot fail', () => {
    expect(n('if(qty == 0, 0, total / qty)', { qty: 0, total: 100 })).toBe('0');
  });

  it('rejects division by zero', () => {
    expect(() => evaluate('1 / x', { x: 0 })).toThrow(/Division by zero/);
  });

  it('rejects unknown functions at compile time', () => {
    expect(() => compile('eval(1)')).toThrow(/Unknown function "eval"/);
    expect(() => compile('round(1, 2, 3)')).toThrow(/takes 1-2 argument/);
  });

  it('only reads own variables: no prototype access', () => {
    expect(() => evaluate('constructor + 1', {})).toThrow(/Unknown variable "constructor"/);
    expect(() => evaluate('__proto__', {})).toThrow(/Unknown variable/);
  });

  it('rejects anything that is not the language', () => {
    for (const src of ['process.exit()', 'a; b', '"text"', '[1,2]', 'x = 1', '1 +', '(1', '`x`']) {
      expect(() => compile(src), src).toThrow(FormulaError);
    }
  });

  it('enforces size and depth limits', () => {
    expect(() => compile('1+'.repeat(LIMITS.maxSourceLength) + '1')).toThrow(/longer than/);
    expect(() => compile('('.repeat(200) + '1' + ')'.repeat(200))).toThrow(/nested too deeply/);
  });

  it('reports positions for errors', () => {
    try {
      compile('hours * # rate');
      expect.unreachable();
    } catch (err) {
      expect((err as FormulaError).position).toBe(8);
    }
  });

  it('type-checks mixed booleans and numbers', () => {
    expect(() => evaluate('true + 1')).toThrow(/expects numbers/);
    expect(() => evaluate('if(1, 2, 3)')).toThrow(/condition must be true\/false/);
    expect(() => compile('x > 1').evaluateNumber({ x: 2 })).toThrow(/must produce a number/);
  });

  it('rejects malformed variable inputs', () => {
    expect(() => evaluate('x + 1', { x: 'abc' })).toThrow(/not a valid number/);
    expect(() => evaluate('x + 1', { x: Number.NaN })).toThrow(/not finite/);
  });
});
