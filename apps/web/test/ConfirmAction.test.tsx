import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ApiFailure } from '../src/api';
import { LanguageProvider } from '../src/i18n';
import { ConfirmAction, type ConfirmActionProps } from '../src/ui/ConfirmAction';
import { useDialogClose } from '../src/ui/use-dialog-close';

type Shown = Partial<ConfirmActionProps>;

/* A button that opens the question, and a window under it with its own Escape, as the people form has. */
function Opener({ props, under }: { props: Shown; under?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <LanguageProvider>
      {under && <Under onClose={under} />}
      <button type="button" onClick={() => setOpen(true)}>Open</button>
      {open && (
        <ConfirmAction
          title="Do you really want to remove this employee?"
          effect={<>Hana will be removed from <bdi>Development</bdi>.</>}
          yes="Remove"
          danger
          onYes={() => {}}
          {...props}
          onClose={() => {
            props.onClose?.();
            setOpen(false);
          }}
        />
      )}
    </LanguageProvider>
  );
}

function Under({ onClose }: { onClose: () => void }) {
  const box = useDialogClose(onClose);
  return <div ref={box} tabIndex={-1}>The form under it</div>;
}

async function open(props: Shown = {}, under?: () => void) {
  const user = userEvent.setup();
  render(<Opener props={props} under={under} />);
  const opener = screen.getByRole('button', { name: 'Open' });
  opener.focus();
  await user.click(opener);
  return { user, opener, dialog: screen.getByRole('alertdialog', { name: 'Do you really want to remove this employee?' }) };
}

describe('the confirmation of a critical action', () => {
  it('names the action, says what happens and that it cannot be undone', async () => {
    const { dialog } = await open({ final: true, warnings: ['It holds the last copy of the data.'] });
    expect(dialog).toHaveAccessibleDescription('Hana will be removed from Development.');
    expect(dialog).toHaveTextContent('It holds the last copy of the data.');
    expect(dialog).toHaveTextContent('This cannot be undone.');
    expect(screen.getByRole('button', { name: 'Remove' })).toHaveClass('btn', 'danger');
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveClass('btn', 'ghost');
  });

  it('opens on Cancel for a dangerous action and on the action otherwise', async () => {
    await open();
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    screen.getByRole('button', { name: 'Cancel' }).click();
    await open({ danger: false, yes: 'Rename' });
    expect(screen.getAllByRole('button', { name: 'Rename' }).at(-1)).toHaveFocus();
    expect(screen.getAllByRole('button', { name: 'Rename' }).at(-1)).not.toHaveClass('danger');
  });

  it('changes nothing on Cancel, Escape or a click outside, and gives the focus back to its button', async () => {
    const onYes = vi.fn();
    const onClose = vi.fn();
    const { user, opener } = await open({ onYes, onClose });
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(opener).toHaveFocus();

    await user.click(opener);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(opener).toHaveFocus();

    await user.click(opener);
    fireEvent.pointerDown(document.querySelector('.dialog-back')!);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
    expect(onYes).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('takes Escape before a window under it', async () => {
    const under = vi.fn();
    const { user } = await open({}, under);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(under).not.toHaveBeenCalled();
    expect(screen.getByText('The form under it')).toBeInTheDocument();
  });

  it('keeps the focus inside', async () => {
    const { user } = await open();
    const action = screen.getByRole('button', { name: 'Remove' });
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    await user.tab();
    expect(action).toHaveFocus();
    await user.tab({ shift: true });
    expect(cancel).toHaveFocus();
    await user.tab({ shift: true });
    expect(action).toHaveFocus();
  });

  it('runs the action once, waits for it and closes on success', async () => {
    let finish = () => {};
    const onYes = vi.fn(() => new Promise<void>(resolve => (finish = resolve)));
    const { user, dialog } = await open({ onYes, working: 'Removing…' });
    const action = screen.getByRole('button', { name: 'Remove' });
    await user.click(action);
    await user.click(action);
    expect(onYes).toHaveBeenCalledTimes(1);
    expect(action).toBeDisabled();
    expect(action).toHaveAttribute('aria-busy', 'true');
    expect(action).toHaveAccessibleName('Removing…');
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    await user.keyboard('{Escape}');
    expect(dialog).toBeInTheDocument();
    finish();
    await vi.waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  });

  it('keeps a failure in the window with the buttons back', async () => {
    const onYes = vi.fn().mockRejectedValueOnce(new ApiFailure(403, 'forbidden', 'Only the CEO removes employees.'));
    const { user, dialog } = await open({ onYes });
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Only the CEO removes employees.');
    expect(dialog).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();
  });
});
