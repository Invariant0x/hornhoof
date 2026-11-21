import { screen, waitFor } from '@testing-library/react';
import { expect } from 'vitest';

/* A screen's own table, once its rows came: while they come, People, Machines and the plans hold a table head of the same
   columns inside a busy room (aria-busy), so a test that waits for any table would find that one first. */
export const shownTable = () => waitFor(() => {
  const table = screen.getByRole('table');
  expect(table.closest('[aria-busy="true"]')).toBeNull();
  return table;
});
