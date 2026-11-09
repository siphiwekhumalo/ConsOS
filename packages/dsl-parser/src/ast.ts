export type BinaryOp = '+' | '-' | '*' | '/' | '%' | '==' | '!=' | '<' | '<=' | '>' | '>=' | 'and' | 'or';

export type Node =
  | { kind: 'number'; value: string; pos: number }
  | { kind: 'bool'; value: boolean; pos: number }
  | { kind: 'var'; name: string; pos: number }
  | { kind: 'unary'; op: '-' | 'not'; operand: Node; pos: number }
  | { kind: 'binary'; op: BinaryOp; left: Node; right: Node; pos: number }
  | { kind: 'call'; fn: string; args: Node[]; pos: number };

export class FormulaError extends Error {
  constructor(
    message: string,
    /** 0-based character offset in the source, when known */
    public readonly position?: number,
  ) {
    super(position === undefined ? message : `${message} (at position ${position})`);
    this.name = 'FormulaError';
  }
}
