import { useEffect, useState } from 'react';
import { CheckCircle2, FunctionSquare, OctagonAlert } from 'lucide-react';
import { api, type FormulaResult } from '../api';
import { Card, CardHeader, Field, Input, Textarea, cx, errorMessage } from '../components/ui';

const EXAMPLES: { name: string; description: string; formula: string; values: Record<string, string> }[] = [
  {
    name: 'Overtime',
    description: 'Hours above 45 per week at 1.5×',
    formula: 'round(if(hours > 45, (hours - 45) * rate * 1.5, 0), 2)',
    values: { hours: '52', rate: '85.40' },
  },
  {
    name: 'Retention',
    description: '10% per certificate, capped at 5% of contract',
    formula: 'round(min(gross * 0.10, contract_value * 0.05 - retained_to_date), 2)',
    values: { gross: '2000000', contract_value: '48500000', retained_to_date: '2350000' },
  },
  {
    name: 'Remote site allowance',
    description: 'Daily allowance where no accommodation is provided',
    formula: 'if(remote_site and not accommodation_provided, days * 350, 0)',
    values: { remote_site: 'true', accommodation_provided: 'false', days: '22' },
  },
  {
    name: 'Escalation cap',
    description: 'Contract price adjustment capped at 15%',
    formula: 'round(base_amount * clamp(index_now / index_base - 1, 0, 0.15), 2)',
    values: { base_amount: '1250000', index_now: '128.4', index_base: '112.0' },
  },
];

const toValue = (v: string): string | boolean => (v === 'true' ? true : v === 'false' ? false : v.trim());

export function RulesEngine() {
  const [active, setActive] = useState(0);
  const [formula, setFormula] = useState(EXAMPLES[0]!.formula);
  const [values, setValues] = useState<Record<string, string>>(EXAMPLES[0]!.values);
  const [result, setResult] = useState<FormulaResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => {
      const vars = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, toValue(v)]));
      api.evaluateFormula(formula, vars).then(
        (r) => {
          setResult(r);
          setError(null);
          if (r.variables) setValues((prev) => Object.fromEntries(r.variables!.map((v) => [v, prev[v] ?? ''])));
        },
        (e) => setError(errorMessage(e)),
      );
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formula, JSON.stringify(values)]);

  return (
    <div className="grid gap-6 xl:grid-cols-[18rem_1fr]">
      <div className="space-y-2">
        <div className="px-1 pb-1 text-xs font-semibold uppercase tracking-wider text-ink-3">Rule templates</div>
        {EXAMPLES.map((ex, i) => (
          <button
            key={ex.name}
            onClick={() => {
              setActive(i);
              setFormula(ex.formula);
              setValues(ex.values);
            }}
            className={cx(
              'w-full rounded-xl border p-3 text-left transition-colors',
              active === i ? 'border-brand bg-brand-soft' : 'border-line bg-surface hover:border-line-strong',
            )}
          >
            <div className="text-sm font-medium text-ink">{ex.name}</div>
            <div className="mt-0.5 text-xs text-ink-2">{ex.description}</div>
          </button>
        ))}
      </div>

      <Card>
        <CardHeader
          title={<span className="inline-flex items-center gap-2"><FunctionSquare className="size-4 text-ink-3" /> Formula</span>}
          subtitle="Exact decimal arithmetic. Formulas are interpreted, never executed as code."
        />
        <Textarea
          rows={3}
          value={formula}
          onChange={(e) => {
            setFormula(e.target.value);
            setActive(-1);
          }}
          spellCheck={false}
          className="mt-4 font-mono text-[13px]"
        />
        {Object.keys(values).length > 0 && (
          <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {Object.keys(values).map((v) => (
              <Field key={v} label={v}>
                <Input className="num font-mono" value={values[v]} placeholder="number, true or false" onChange={(e) => setValues({ ...values, [v]: e.target.value })} />
              </Field>
            ))}
          </div>
        )}
        <div className={cx('mt-6 flex items-center gap-4 rounded-xl border p-5', result?.ok ? 'border-good/30 bg-good-soft' : 'border-line bg-surface-2')}>
          {result?.ok ? <CheckCircle2 className="size-6 text-good-ink" /> : <OctagonAlert className="size-6 text-ink-3" />}
          <div>
            <div className="text-xs font-medium uppercase tracking-wide text-ink-3">Result</div>
            {result?.ok ? (
              <div className="text-2xl font-semibold text-ink">{String(result.result)}</div>
            ) : (
              <div className="text-sm text-critical-ink">{error ?? result?.error ?? 'Evaluating…'}</div>
            )}
          </div>
        </div>
        <p className="mt-4 text-xs leading-relaxed text-ink-3">
          Functions: <code>min</code>, <code>max</code>, <code>round(x, places)</code>, <code>floor</code>, <code>ceil</code>, <code>abs</code>,{' '}
          <code>clamp(x, low, high)</code>, <code>if(condition, then, else)</code>. Operators: + − * / % == != &lt; &lt;= &gt; &gt;= and or not.
        </p>
      </Card>
    </div>
  );
}
