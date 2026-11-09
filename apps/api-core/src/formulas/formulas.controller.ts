import { BadRequestException, Body, Controller, HttpCode, Post } from '@nestjs/common';
import { z } from 'zod';
import { compile, FormulaError, SUPPORTED_FUNCTIONS } from '@constructos/dsl-parser';
import { Roles } from '../auth/decorators';
import { ZodBodyPipe } from '../common/zod-body.pipe';

const EvaluateBody = z.object({
  formula: z.string().min(1).max(2000),
  variables: z.record(z.union([z.string().max(40), z.boolean()])).default({}),
});
type EvaluateBody = z.infer<typeof EvaluateBody>;

/**
 * Formula tester for commercial rules (overtime, retention, allowances).
 * Pure computation: reads nothing, writes nothing.
 */
@Controller('formulas')
@Roles('owner', 'admin', 'finance', 'project_manager')
export class FormulasController {
  @Post('evaluate')
  @HttpCode(200)
  evaluate(@Body(new ZodBodyPipe(EvaluateBody)) body: EvaluateBody) {
    try {
      const f = compile(body.formula);
      const missing = f.variables.filter((v) => !(v in body.variables));
      if (missing.length) {
        return { ok: false, variables: f.variables, error: `Missing values for: ${missing.join(', ')}` };
      }
      const value = f.evaluate(body.variables);
      return { ok: true, variables: f.variables, result: typeof value === 'boolean' ? value : value.toString() };
    } catch (err) {
      if (err instanceof FormulaError) {
        return { ok: false, error: err.message, position: err.position, functions: SUPPORTED_FUNCTIONS };
      }
      throw new BadRequestException('Could not evaluate formula');
    }
  }
}
