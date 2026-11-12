import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Alert, Button, Dialog, Input, errorMessage } from './ui';

/** A dialog around a form: shows its own busy state and error, closes on success. */
export function FormDialog({
  open,
  onClose,
  title,
  description,
  submitLabel,
  onSubmit,
  children,
  wide,
  danger,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  submitLabel: string;
  onSubmit: () => Promise<unknown>;
  children: ReactNode;
  wide?: boolean;
  danger?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) setError(null);
  }, [open]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSubmit();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onClose={onClose} title={title} description={description} wide={wide}>
      <form onSubmit={submit} className="space-y-4">
        {children}
        {error && <Alert>{error}</Alert>}
        <div className="flex justify-end gap-2 border-t border-line pt-4">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant={danger ? 'danger' : 'primary'} loading={busy}>{submitLabel}</Button>
        </div>
      </form>
    </Dialog>
  );
}

/** A form dialog that owns its field state, reset to `fields` each time it opens. */
export function FormPanel<F extends Record<string, string>>({
  open,
  title,
  description,
  fields,
  onClose,
  submit,
  render,
  danger,
  wide,
  submitLabel = 'Save',
}: {
  open: boolean;
  title: string;
  description?: string;
  fields: F;
  onClose: () => void;
  submit: (f: F) => Promise<unknown>;
  render: (f: F, set: (patch: Partial<F>) => void) => ReactNode;
  danger?: boolean;
  wide?: boolean;
  submitLabel?: string;
}) {
  const [f, setF] = useState(fields);
  useEffect(() => {
    if (open) setF(fields);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <FormDialog open={open} onClose={onClose} title={title} description={description} submitLabel={submitLabel} danger={danger} wide={wide} onSubmit={() => submit(f)}>
      {render(f, (patch) => setF((cur) => ({ ...cur, ...patch })))}
    </FormDialog>
  );
}

/** Rand amount input: keeps the value a decimal string, strips spaces, commas and "R". */
export function AmountInput({
  value,
  onChange,
  allowNegative,
  required,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  allowNegative?: boolean;
  required?: boolean;
  className?: string;
}) {
  return (
    <Input
      inputMode="decimal"
      value={value}
      required={required}
      className={className}
      pattern={allowNegative ? '-?\\d{1,16}(\\.\\d{1,2})?' : '\\d{1,16}(\\.\\d{1,2})?'}
      title={allowNegative ? 'Rands, e.g. 12500.00 or -12500.00' : 'Rands, e.g. 12500.00'}
      placeholder="0.00"
      onChange={(e) => onChange(e.target.value.replace(/[\sR,]/g, ''))}
    />
  );
}

/** Run an action and surface its error, for buttons outside a dialog. */
export function useAction() {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return { error, setError, busy, run };
}
