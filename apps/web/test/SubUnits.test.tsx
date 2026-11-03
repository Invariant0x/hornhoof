import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { DeptEmployeeList, DeptSubUnits, employeeGroups } from '../src/ui/SubUnits';
import { DEV_ORG, mockApi } from './api-mock';

const [devBase] = DEV_ORG.departments;
const urgent = { id: 'u1', name: 'Urgent fixes', about: '', stage: 0, gate: false };
const [dana, bruno] = devBase!.employees;
const simon = { ...bruno!, id: 'b2', name: 'Simon', teamId: 'u1' };
const loose = { ...bruno!, id: 'b3', name: 'Leo', roleId: 'UNKNOWN-ROLE' };
const dept = { ...devBase!, teams: [urgent], employees: [dana!, bruno!, simon, loose] };

describe('SubUnits', () => {
  it('groups employees by sub-unit first, then pipeline roles, then others in both languages', () => {
    expect(employeeGroups(dept, 'en', 'Others').map(g => [g.key, g.title, g.members.map(m => m.name)])).toEqual([
      ['team:u1', 'Urgent fixes', ['Simon']],
      ['DEV-BE', 'Backend engineer', ['Bruno']],
      ['others', 'Others', ['Leo']],
    ]);
    expect(employeeGroups({ ...devBase!, employees: [dana!] }, 'ru', 'Другие')).toEqual([]);
  });

  it('shows an alert when moving an employee, renaming, deleting, or creating a sub-unit fails, and clears it on success', async () => {
    const user = userEvent.setup();
    let fail = true;
    const calls = mockApi({
      'PATCH /api/agents/b1': () => (fail ? [400, { error: { code: 'validation', message: 'Cannot move Bruno.', reason: 'unknown_place' } }] : [200, {}]),
      'PATCH /api/agents/b2': () => [200, {}],
      'PATCH /api/departments/d2/teams/u1': () => (fail ? [404, { error: { code: 'not_found', message: 'Sub-unit missing.', reason: 'unknown_place' } }] : [200, { team: { ...urgent, name: 'Fast lane' } }]),
      'DELETE /api/departments/d2/teams/u1': () => (fail ? [404, { error: { code: 'not_found', message: 'Sub-unit gone.', reason: 'unknown_place' } }] : [204]),
      'POST /api/departments/d2/teams': () => (fail ? [400, { error: { code: 'validation', message: 'Invalid sub-unit.', reason: 'department_unknown' } }] : [201, { team: urgent }]),
    });

    const empty = render(
      <LanguageProvider>
        <DeptEmployeeList department={{ ...devBase!, employees: [dana!] }} company />
        <DeptSubUnits department={devBase!} company={false} />
        <DeptSubUnits department={devBase!} company />
      </LanguageProvider>,
    );
    expect(screen.getByText('No sub-units yet.')).toBeInTheDocument();
    empty.unmount();

    render(
      <LanguageProvider>
        <DeptEmployeeList department={dept} company />
        <DeptSubUnits department={dept} company />
      </LanguageProvider>,
    );

    const members = screen.getByRole('region', { name: 'Members' });
    await user.selectOptions(within(members).getByLabelText('Sub-unit for Bruno'), 'u1');
    expect(await within(members).findByRole('alert')).toHaveTextContent('This department or team no longer exists. Reload the page and pick again.');

    await user.selectOptions(within(members).getByLabelText('Sub-unit for Simon'), '');
    expect(within(members).queryByRole('alert')).not.toBeInTheDocument();
    expect(calls.find(c => c.path === '/api/agents/b2')?.body).toEqual({ team: null });

    const subUnits = screen.getByRole('region', { name: 'Sub-units' });
    await user.click(within(subUnits).getByRole('button', { name: 'Delete sub-unit' }));
    expect(await within(subUnits).findByRole('alert')).toHaveTextContent('This department or team no longer exists. Reload the page and pick again.');

    await user.click(within(subUnits).getByRole('button', { name: 'Rename' }));
    const renameInput = within(subUnits).getByLabelText('Sub-unit name');
    await user.clear(renameInput);
    await user.type(renameInput, 'Fast lane');
    await user.click(within(subUnits).getByRole('button', { name: 'Save' }));
    expect(await within(subUnits).findByRole('alert')).toHaveTextContent('This department or team no longer exists. Reload the page and pick again.');
    expect(within(subUnits).getByLabelText('Sub-unit name')).toHaveValue('Fast lane');

    fail = false;
    await user.click(within(subUnits).getByRole('button', { name: 'Save' }));
    expect(within(subUnits).queryByRole('alert')).not.toBeInTheDocument();
    expect(within(subUnits).queryByLabelText('Sub-unit name')).not.toBeInTheDocument();

    fail = true;
    await user.click(within(subUnits).getByRole('button', { name: 'New sub-unit' }));
    await user.type(within(subUnits).getByLabelText('Sub-unit name'), 'Hotfixes');
    await user.click(within(subUnits).getByRole('button', { name: 'Add sub-unit' }));
    expect(await within(subUnits).findByRole('alert')).toHaveTextContent('This department no longer exists. Reload the page.');
    expect(within(subUnits).getByLabelText('Sub-unit name')).toHaveValue('Hotfixes');

    fail = false;
    await user.click(within(subUnits).getByRole('button', { name: 'Add sub-unit' }));
    expect(within(subUnits).queryByRole('alert')).not.toBeInTheDocument();
    expect(within(subUnits).queryByLabelText('Sub-unit name')).not.toBeInTheDocument();
  });
});
