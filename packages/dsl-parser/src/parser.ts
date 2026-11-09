/**
 * Tokenizer + recursive-descent parser.
 *
 * Grammar (lowest to highest precedence):
 *   expr    := or
 *   or      := and ("or" and)*
 *   and     := not ("and" not)*
 *   not     := "not" not | cmp
 *   cmp     := add (("==" | "!=" | "<" | "<=" | ">" | ">=") add)?
 *   add     := mul (("+" | "-") mul)*
 *   mul     := unary (("*" | "/" | "%") unary)*
 *   unary   := "-" unary | primary
 *   primary := NUMBER | "true" | "false" | IDENT | IDENT "(" args? ")" | "(" expr ")"
 */
import { FormulaError, type BinaryOp, type Node } from './ast';

export const LIMITS = {
  maxSourceLength: 2000,
  maxDepth: 40,
  maxNodes: 400,
};

type Token =
  | { t: 'num'; v: string; pos: number }
  | { t: 'ident'; v: string; pos: number }
  | { t: 'op'; v: string; pos: number }
  | { t: 'eof'; pos: number };

const KEYWORDS = new Set(['and', 'or', 'not', 'true', 'false']);

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const m = /^(?:\d+(?:\.\d*)?|\.\d+)/.exec(src.slice(i))!;
      tokens.push({ t: 'num', v: m[0], pos: i });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!;
      const word = m[0];
      tokens.push(KEYWORDS.has(word.toLowerCase())
        ? { t: 'op', v: word.toLowerCase(), pos: i }
        : { t: 'ident', v: word, pos: i });
      i += word.length;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (['==', '!=', '<=', '>='].includes(two)) {
      tokens.push({ t: 'op', v: two, pos: i });
      i += 2;
      continue;
    }
    if ('+-*/%<>(),'.includes(c)) {
      tokens.push({ t: 'op', v: c, pos: i });
      i++;
      continue;
    }
    throw new FormulaError(`Unexpected character "${c}"`, i);
  }
  tokens.push({ t: 'eof', pos: src.length });
  return tokens;
}

export function parse(src: string): Node {
  if (src.length > LIMITS.maxSourceLength) {
    throw new FormulaError(`Formula is longer than ${LIMITS.maxSourceLength} characters`);
  }
  const tokens = tokenize(src);
  let p = 0;
  let depth = 0;
  let nodes = 0;

  const peek = () => tokens[p]!;
  const isOp = (v: string) => {
    const tk = peek();
    return tk.t === 'op' && tk.v === v;
  };
  const expectOp = (v: string) => {
    if (!isOp(v)) throw new FormulaError(`Expected "${v}"`, peek().pos);
    p++;
  };
  const make = <N extends Node>(n: N): N => {
    if (++nodes > LIMITS.maxNodes) throw new FormulaError('Formula is too complex');
    return n;
  };
  const nested = <T>(fn: () => T): T => {
    if (++depth > LIMITS.maxDepth) throw new FormulaError('Formula is nested too deeply', peek().pos);
    try {
      return fn();
    } finally {
      depth--;
    }
  };

  const binaryLevel = (ops: string[], next: () => Node) => (): Node => {
    let left = next();
    while (peek().t === 'op' && ops.includes((peek() as { v: string }).v)) {
      const tk = tokens[p++] as { v: string; pos: number };
      const right = next();
      left = make({ kind: 'binary', op: tk.v as BinaryOp, left, right, pos: tk.pos });
    }
    return left;
  };

  const primary = (): Node =>
    nested(() => {
      const tk = peek();
      if (tk.t === 'num') {
        p++;
        return make({ kind: 'number', value: tk.v, pos: tk.pos });
      }
      if (tk.t === 'op' && (tk.v === 'true' || tk.v === 'false')) {
        p++;
        return make({ kind: 'bool', value: tk.v === 'true', pos: tk.pos });
      }
      if (tk.t === 'ident') {
        p++;
        if (isOp('(')) {
          p++;
          const args: Node[] = [];
          if (!isOp(')')) {
            do {
              args.push(expr());
            } while (isOp(',') && ++p);
          }
          expectOp(')');
          return make({ kind: 'call', fn: tk.v.toLowerCase(), args, pos: tk.pos });
        }
        return make({ kind: 'var', name: tk.v, pos: tk.pos });
      }
      if (tk.t === 'op' && tk.v === '(') {
        p++;
        const inner = expr();
        expectOp(')');
        return inner;
      }
      throw new FormulaError(tk.t === 'eof' ? 'Unexpected end of formula' : `Unexpected "${tk.v}"`, tk.pos);
    });

  const unary = (): Node =>
    nested(() => {
      if (isOp('-')) {
        const pos = tokens[p++]!.pos;
        return make({ kind: 'unary', op: '-', operand: unary(), pos });
      }
      return primary();
    });

  const mul = binaryLevel(['*', '/', '%'], unary);
  const add = binaryLevel(['+', '-'], mul);

  const cmp = (): Node => {
    const left = add();
    const tk = peek();
    if (tk.t === 'op' && ['==', '!=', '<', '<=', '>', '>='].includes(tk.v)) {
      p++;
      return make({ kind: 'binary', op: tk.v as BinaryOp, left, right: add(), pos: tk.pos });
    }
    return left;
  };

  const not = (): Node =>
    nested(() => {
      if (isOp('not')) {
        const pos = tokens[p++]!.pos;
        return make({ kind: 'unary', op: 'not', operand: not(), pos });
      }
      return cmp();
    });

  const and = binaryLevel(['and'], not);
  const or = binaryLevel(['or'], and);
  function expr(): Node {
    return nested(or);
  }

  const ast = expr();
  if (peek().t !== 'eof') throw new FormulaError(`Unexpected "${(peek() as { v: string }).v}"`, peek().pos);
  return ast;
}
