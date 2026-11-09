/**
 * ConstructOS formula language.
 *
 * A small, side-effect-free expression language for client-specific commercial
 * rules (overtime, allowances, retention, rate escalation). It is parsed into an
 * AST and interpreted. No JavaScript is ever evaluated, there are no loops, and
 * input size/depth are capped, so a tenant's formula cannot escape, hang or
 * exhaust the server. All arithmetic is decimal (never binary floating point).
 *
 * Example:
 *   const f = compile('if(hours > 45, (hours - 45) * rate * 1.5, 0)');
 *   f.variables                         // ['hours', 'rate']
 *   f.evaluate({ hours: '50', rate: '85.40' }).toString()   // '640.5'
 */
import { FormulaError, type Node } from './ast';
import { parse, LIMITS } from './parser';
import { D, evaluateAst, FUNCTIONS, type Dec, type InputValue, type Value } from './evaluate';

export { FormulaError, LIMITS, D as Decimal };
export type { Node, Dec, InputValue, Value };

export interface CompiledFormula {
  readonly source: string;
  readonly ast: Node;
  /** Variable names referenced, in first-use order. */
  readonly variables: string[];
  evaluate(vars: Readonly<Record<string, InputValue>>): Value;
  /** Evaluate and require a numeric result. */
  evaluateNumber(vars: Readonly<Record<string, InputValue>>): Dec;
}

function validate(node: Node, vars: string[]) {
  switch (node.kind) {
    case 'var':
      if (!vars.includes(node.name)) vars.push(node.name);
      return;
    case 'unary':
      return validate(node.operand, vars);
    case 'binary':
      validate(node.left, vars);
      return validate(node.right, vars);
    case 'call': {
      const spec = FUNCTIONS[node.fn];
      if (!spec) throw new FormulaError(`Unknown function "${node.fn}"`, node.pos);
      if (node.args.length < spec.minArgs || node.args.length > spec.maxArgs) {
        const want = spec.minArgs === spec.maxArgs ? `${spec.minArgs}` : `${spec.minArgs}-${spec.maxArgs}`;
        throw new FormulaError(`${node.fn}() takes ${want} argument(s), got ${node.args.length}`, node.pos);
      }
      node.args.forEach((a) => validate(a, vars));
      return;
    }
    default:
      return;
  }
}

/** Parse and statically validate a formula (syntax, function names, arity). */
export function compile(source: string): CompiledFormula {
  const ast = parse(source);
  const variables: string[] = [];
  validate(ast, variables);
  return {
    source,
    ast,
    variables,
    evaluate: (vars) => evaluateAst(ast, vars),
    evaluateNumber: (vars) => {
      const v = evaluateAst(ast, vars);
      if (typeof v === 'boolean') throw new FormulaError('Formula must produce a number, not true/false');
      return v;
    },
  };
}

export function evaluate(source: string, vars: Readonly<Record<string, InputValue>> = {}): Value {
  return compile(source).evaluate(vars);
}

export const SUPPORTED_FUNCTIONS = Object.keys(FUNCTIONS);
