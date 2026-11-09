import Decimal from 'decimal.js';
import { FormulaError, type Node } from './ast';

/** Isolated Decimal constructor: 34 significant digits, banker-safe HALF_UP for money. */
export const D = Decimal.clone({ precision: 34, rounding: Decimal.ROUND_HALF_UP });
export type Dec = InstanceType<typeof D>;

export type Value = Dec | boolean;
export type InputValue = string | number | boolean | Dec;

interface FnSpec {
  minArgs: number;
  maxArgs: number;
  /** if() is lazy so only the chosen branch is evaluated (avoids spurious divide-by-zero). */
  lazy?: boolean;
  call: (args: Value[], pos: number) => Value;
}

const num = (v: Value, pos: number, fn: string): Dec => {
  if (typeof v === 'boolean') throw new FormulaError(`${fn}() expects a number`, pos);
  return v;
};

export const FUNCTIONS: Record<string, FnSpec> = {
  min: { minArgs: 1, maxArgs: 20, call: (a, p) => D.min(...a.map((v) => num(v, p, 'min'))) },
  max: { minArgs: 1, maxArgs: 20, call: (a, p) => D.max(...a.map((v) => num(v, p, 'max'))) },
  abs: { minArgs: 1, maxArgs: 1, call: (a, p) => num(a[0]!, p, 'abs').abs() },
  round: {
    minArgs: 1,
    maxArgs: 2,
    call: (a, p) => {
      const dp = a[1] === undefined ? 0 : num(a[1], p, 'round').toNumber();
      if (!Number.isInteger(dp) || dp < 0 || dp > 10) throw new FormulaError('round() places must be 0-10', p);
      return num(a[0]!, p, 'round').toDecimalPlaces(dp, D.ROUND_HALF_UP);
    },
  },
  floor: { minArgs: 1, maxArgs: 1, call: (a, p) => num(a[0]!, p, 'floor').floor() },
  ceil: { minArgs: 1, maxArgs: 1, call: (a, p) => num(a[0]!, p, 'ceil').ceil() },
  clamp: {
    minArgs: 3,
    maxArgs: 3,
    call: (a, p) => {
      const [x, lo, hi] = a.map((v) => num(v, p, 'clamp')) as [Dec, Dec, Dec];
      return D.min(D.max(x, lo), hi);
    },
  },
  if: { minArgs: 3, maxArgs: 3, lazy: true, call: () => { throw new Error('unreachable'); } },
};

function toValue(name: string, v: InputValue, pos: number): Value {
  if (typeof v === 'boolean') return v;
  if (v instanceof D) return v;
  if (typeof v === 'number' && !Number.isFinite(v)) throw new FormulaError(`Variable "${name}" is not finite`, pos);
  try {
    return new D(v);
  } catch {
    throw new FormulaError(`Variable "${name}" is not a valid number`, pos);
  }
}

export function evaluateAst(node: Node, vars: Readonly<Record<string, InputValue>>): Value {
  switch (node.kind) {
    case 'number':
      return new D(node.value);
    case 'bool':
      return node.value;
    case 'var': {
      // own-property lookup only: no prototype access ("constructor", "__proto__").
      if (!Object.prototype.hasOwnProperty.call(vars, node.name)) {
        throw new FormulaError(`Unknown variable "${node.name}"`, node.pos);
      }
      return toValue(node.name, vars[node.name]!, node.pos);
    }
    case 'unary': {
      const v = evaluateAst(node.operand, vars);
      if (node.op === '-') {
        if (typeof v === 'boolean') throw new FormulaError('Cannot negate a true/false value', node.pos);
        return v.negated();
      }
      if (typeof v !== 'boolean') throw new FormulaError('"not" expects a true/false value', node.pos);
      return !v;
    }
    case 'binary': {
      if (node.op === 'and' || node.op === 'or') {
        const l = evaluateAst(node.left, vars);
        if (typeof l !== 'boolean') throw new FormulaError(`"${node.op}" expects true/false values`, node.pos);
        if (node.op === 'and' ? !l : l) return l; // short-circuit
        const r = evaluateAst(node.right, vars);
        if (typeof r !== 'boolean') throw new FormulaError(`"${node.op}" expects true/false values`, node.pos);
        return r;
      }
      const l = evaluateAst(node.left, vars);
      const r = evaluateAst(node.right, vars);
      if (node.op === '==' || node.op === '!=') {
        if (typeof l !== typeof r) throw new FormulaError('Cannot compare a number with true/false', node.pos);
        const eq = typeof l === 'boolean' ? l === r : (l as Dec).equals(r as Dec);
        return node.op === '==' ? eq : !eq;
      }
      if (typeof l === 'boolean' || typeof r === 'boolean') {
        throw new FormulaError(`"${node.op}" expects numbers`, node.pos);
      }
      switch (node.op) {
        case '+': return l.plus(r);
        case '-': return l.minus(r);
        case '*': return l.times(r);
        case '/':
          if (r.isZero()) throw new FormulaError('Division by zero', node.pos);
          return l.dividedBy(r);
        case '%':
          if (r.isZero()) throw new FormulaError('Division by zero', node.pos);
          return l.modulo(r);
        case '<': return l.lessThan(r);
        case '<=': return l.lessThanOrEqualTo(r);
        case '>': return l.greaterThan(r);
        case '>=': return l.greaterThanOrEqualTo(r);
      }
      throw new FormulaError(`Unknown operator ${node.op}`, node.pos);
    }
    case 'call': {
      const spec = FUNCTIONS[node.fn];
      if (!spec) throw new FormulaError(`Unknown function "${node.fn}"`, node.pos);
      if (node.fn === 'if') {
        const cond = evaluateAst(node.args[0]!, vars);
        if (typeof cond !== 'boolean') throw new FormulaError('if() condition must be true/false', node.pos);
        return evaluateAst(cond ? node.args[1]! : node.args[2]!, vars);
      }
      return spec.call(node.args.map((a) => evaluateAst(a, vars)), node.pos);
    }
  }
}
