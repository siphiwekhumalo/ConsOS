import { useEffect, useState } from 'react';
import { api, type FormulaResult } from '../api';
import { Button, Card, ErrorText, errorMessage, inputClass, PageHeader } from '../components/ui';

const EXAMPLES: { name: string; formula: string; values: Record<string, string> }[] = [
  { name: 'Overtime above 45 h at 1.5×', formula: 'round(if(hours > 45, (hours - 45) * rate * 1.5, 0), 2)', values: { hours: '52', rate: '85.40' } },
  {
    name: 'Retention 10% capped at 5% of contract',
    formula: 'round(min(gross * 0.10, contract_value * 0.05 - retained_to_date), 2)',
    values: { gross: '2000000', contract_value: '48500000', retained_to_date: '2350000' },
  },
  {
    name: 'Remote site allowance',
    formula: 'if(remote_site and not accommodation_provided, days * 350, 0)',
    values: { remote_site: 'true', accommodation_provided: 'false', days: '22' },
  },
];

const toValue = (v: string): string | boolean => (v === 'true' ? true : v === 'false' ? false : v.trim());

export function Rules() {
  const [formula, setFormula] = useState(EXAMPLES[0]!.formula);
  const [values, setValues] = useState<Record<string, string>>(EXAMPLES[0]!.values);
  const [result, setResult] = useState<FormulaResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Re-evaluate as the user types (the endpoint is pure and cheap).
  useEffect(() => {
    const t = setTimeout(() => {
      const vars = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, toValue(v)]));
      api.evaluateFormula(formula, vars).then(
        (r) => {
          setResult(r);
          setError(null);
          if (r.variables) {
            setValues((prev) => Object.fromEntries(r.variables!.map((v) => [v, prev[v] ?? ''])));
          }
        },
        (e) => setError(errorMessage(e)),
      );
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formula, JSON.stringify(values)]);

  return (
    <section>
      <PageHeader
        title="Commercial rules"
        subtitle="Test client-specific formulas for overtime, retention and allowances. Exact decimal arithmetic, no code execution."
      />
      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <Card>
          <label className="block text-sm font-medium">
            Formula
            <textarea
              rows={3}
              className={`${inputClass} font-mono`}
              value={formula}
              onChange={(e) => setFormula(e.target.value)}
              spellCheck={false}
            />
          </label>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {Object.keys(values).map((v) => (
              <label key={v} className="text-sm font-medium">
                <span className="font-mono">{v}</span>
                <input
                  className={inputClass}
                  value={values[v]}
                  placeholder="number, true or false"
                  onChange={(e) => setValues({ ...values, [v]: e.target.value })}
                />
              </label>
            ))}
          </div>
          <div className="mt-5 rounded-md bg-slate-50 p-4">
            {result?.ok ? (
              <p className="text-2xl font-semibold tabular-nums">{String(result.result)}</p>
            ) : (
              <p className="text-sm text-red-700">{result?.error ?? '…'}</p>
            )}
          </div>
          <ErrorText error={error} />
          <p className="mt-4 text-xs text-slate-500">
            Functions: min, max, round(x, places), floor, ceil, abs, clamp(x, low, high), if(condition, then, else). Operators: + − * / %
            == != &lt; &lt;= &gt; &gt;= and or not.
          </p>
        </Card>
        <Card className="h-fit space-y-2">
          <h2 className="text-sm font-medium">Examples</h2>
          {EXAMPLES.map((ex) => (
            <Button
              key={ex.name}
              variant="secondary"
              className="w-full text-left"
              onClick={() => {
                setFormula(ex.formula);
                setValues(ex.values);
              }}
            >
              {ex.name}
            </Button>
          ))}
        </Card>
      </div>
    </section>
  );
}
