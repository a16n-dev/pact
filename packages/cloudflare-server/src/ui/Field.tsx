import type { PropsWithChildren } from 'hono/jsx';

export type FieldProps = PropsWithChildren<{
  id: string;
  name?: string;
  label: string;
  type?: 'text' | 'password';
  value?: string;
  help?: string;
  error?: string;
  mono?: boolean;
  autocomplete?: string;
  required?: boolean;
}>;

export function Field({
  id,
  name = id,
  label,
  type = 'text',
  value,
  help,
  error,
  mono,
  autocomplete = 'off',
  required = true,
  children,
}: FieldProps) {
  const describedBy = [error ? `${id}-error` : null, help ? `${id}-help` : null]
    .filter(Boolean)
    .join(' ');
  return (
    <div class='field'>
      <label for={id}>{children ?? label}</label>
      <input
        id={id}
        name={name}
        type={type}
        value={value ?? ''}
        class={mono ? 'mono' : undefined}
        autocomplete={autocomplete}
        autocapitalize='none'
        required={required}
        aria-invalid={error ? 'true' : undefined}
        aria-describedby={describedBy || undefined}
      />
      {error ? (
        <span id={`${id}-error`} class='error' role='alert'>
          {error}
        </span>
      ) : null}
      {help ? (
        <span id={`${id}-help`} class='help'>
          {help}
        </span>
      ) : null}
    </div>
  );
}
