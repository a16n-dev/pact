import type { PropsWithChildren } from 'hono/jsx';
import { X } from 'lucide';
import { Icon } from '../ui/Icon';

export type DialogProps = PropsWithChildren<{
  id: string;
  title: string;
  description?: string;
  action: string;
  submitLabel: string;
  submitClass?: 'btn-primary' | 'btn-danger' | 'btn-danger-filled';
  open?: boolean;
  closable?: boolean;
  wide?: boolean;
}>;

// `open` marks the dialog for the page script to show on load, so a failed submit lands back on
// the page with the dialog and its error in place.
export function Dialog({
  id,
  title,
  description,
  action,
  submitLabel,
  submitClass = 'btn-primary',
  open,
  closable = true,
  wide,
  children,
}: DialogProps) {
  return (
    <dialog id={id} class={wide ? 'wide' : undefined} data-autoopen={open ? '' : undefined}>
      <form method='post' action={action}>
        <div class='dialog-head'>
          <div class='stack' style='gap: 6px'>
            <h2>{title}</h2>
            {description ? <p class='muted small'>{description}</p> : null}
          </div>
          {closable ? (
            <button type='button' class='btn btn-ghost close' aria-label='Close' data-closes>
              <Icon icon={X} size={16} />
            </button>
          ) : null}
        </div>
        {children}
        <div class='dialog-actions'>
          <button type='button' class='btn' data-closes>
            Cancel
          </button>
          <button type='submit' class={`btn ${submitClass}`}>
            {submitLabel}
          </button>
        </div>
      </form>
    </dialog>
  );
}
