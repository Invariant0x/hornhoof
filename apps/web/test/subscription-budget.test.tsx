import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { BudgetControl } from '../src/ui/BudgetControl';
import { mockApi } from './api-mock';

function control(props: Partial<Parameters<typeof BudgetControl>[0]> = {}) {
  return (
    <LanguageProvider>
      <BudgetControl subscriptionId="s-claude" canManage onConfirmed={() => {}} {...props} />
    </LanguageProvider>
  );
}

afterEach(() => localStorage.clear());

describe('subscription budget control', () => {
  it('defaults to 100 and saves a confirmed zero with the keyboard', async () => {
    const calls = mockApi({ 'PATCH /api/subscriptions/s-claude/budget': [200, { subscription: { budgetPercent: 0 } }] });
    const user = userEvent.setup();
    render(control());
    const slider = screen.getByRole('slider', { name: 'Subscription budget' });
    expect(slider).toHaveValue('100');
    expect(slider).toHaveAttribute('min', '0');
    expect(slider).toHaveAttribute('max', '100');
    expect(slider).toHaveAttribute('step', '1');
    expect(screen.getByText('Server value: 100%')).toBeInTheDocument();
    fireEvent.change(slider, { target: { value: '0' } });
    slider.focus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Save budget' })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(await screen.findByText('Server value: 0%')).toBeInTheDocument();
    expect(slider).toHaveValue('0');
    expect(calls).toEqual([{ method: 'PATCH', path: '/api/subscriptions/s-claude/budget', body: { budgetPercent: 0 } }]);
  });

  it('shows the value confirmed by the server rather than the requested draft', async () => {
    mockApi({ 'PATCH /api/subscriptions/s-claude/budget': [200, { subscription: { budgetPercent: 90 } }] });
    const onConfirmed = vi.fn();
    const user = userEvent.setup();
    render(control({ onConfirmed }));
    const slider = screen.getByRole('slider', { name: 'Subscription budget' });
    fireEvent.change(slider, { target: { value: '91' } });
    expect(screen.getByText('Server value: 100%')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save budget' }));
    expect(await screen.findByText('Server value: 90%')).toBeInTheDocument();
    expect(slider).toHaveValue('90');
    expect(onConfirmed).toHaveBeenCalledWith(90);
  });

  it('restores the confirmed value and shows a safe error after a failed save', async () => {
    mockApi({ 'PATCH /api/subscriptions/s-claude/budget': [403, { error: { code: 'forbidden', reason: 'not_owner', message: 'Only the owner can do this.' } }] });
    const onConfirmed = vi.fn();
    const user = userEvent.setup();
    render(control({ budgetPercent: 90, onConfirmed }));
    const slider = screen.getByRole('slider', { name: 'Subscription budget' });
    fireEvent.change(slider, { target: { value: '0' } });
    await user.click(screen.getByRole('button', { name: 'Save budget' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Only the owner can do this.');
    expect(slider).toHaveValue('90');
    expect(screen.getByText('Server value: 90%')).toBeInTheDocument();
    expect(screen.queryByText('Server value: 0%')).not.toBeInTheDocument();
    expect(onConfirmed).not.toHaveBeenCalled();
  });

  it('uses a newly confirmed prop after a reload without writing anything', () => {
    const calls = mockApi({});
    const { rerender } = render(control({ budgetPercent: 100 }));
    rerender(control({ budgetPercent: 90 }));
    expect(screen.getByRole('slider', { name: 'Subscription budget' })).toHaveValue('90');
    expect(screen.getByText('Server value: 90%')).toBeInTheDocument();
    expect(calls).toEqual([]);
  });

  it('changes only the selected subscription', async () => {
    const calls = mockApi({ 'PATCH /api/subscriptions/s-a/budget': [200, { subscription: { budgetPercent: 0 } }] });
    const user = userEvent.setup();
    render(
      <LanguageProvider>
        <BudgetControl subscriptionId="s-a" canManage onConfirmed={() => {}} />
        <BudgetControl subscriptionId="s-b" budgetPercent={90} canManage onConfirmed={() => {}} />
      </LanguageProvider>,
    );
    const sliders = screen.getAllByRole('slider', { name: 'Subscription budget' });
    fireEvent.change(sliders[0]!, { target: { value: '0' } });
    await user.click(screen.getAllByRole('button', { name: 'Save budget' })[0]!);
    expect(await screen.findByText('Server value: 0%')).toBeInTheDocument();
    expect(sliders[0]).toHaveValue('0');
    expect(sliders[1]).toHaveValue('90');
    expect(screen.getByText('Server value: 90%')).toBeInTheDocument();
    expect(calls).toEqual([{ method: 'PATCH', path: '/api/subscriptions/s-a/budget', body: { budgetPercent: 0 } }]);
  });

  it('is read-only without management rights and never writes', async () => {
    const calls = mockApi({});
    const user = userEvent.setup();
    render(control({ budgetPercent: 90, canManage: false }));
    const slider = screen.getByRole('slider', { name: 'Subscription budget' });
    expect(slider).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save budget' })).not.toBeInTheDocument();
    await user.click(slider);
    await user.keyboard('{Enter}');
    expect(slider).toHaveValue('90');
    expect(calls).toEqual([]);
  });

  it('uses Russian labels and a localized server error', async () => {
    localStorage.setItem('hh-lang', 'ru');
    mockApi({ 'PATCH /api/subscriptions/s-claude/budget': [400, { error: { code: 'validation', reason: 'budget_invalid', message: 'Choose a whole percentage from 0 to 100.' } }] });
    const user = userEvent.setup();
    render(control());
    const slider = screen.getByRole('slider', { name: 'Бюджет подписки' });
    expect(screen.getByText('Сохранено на сервере: 100%')).toBeInTheDocument();
    fireEvent.change(slider, { target: { value: '90' } });
    await user.click(screen.getByRole('button', { name: 'Сохранить бюджет' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Выберите целое число процентов от 0 до 100.');
    expect(screen.queryByText('Choose a whole percentage from 0 to 100.')).not.toBeInTheDocument();
    expect(slider).toHaveValue('100');
  });
});
