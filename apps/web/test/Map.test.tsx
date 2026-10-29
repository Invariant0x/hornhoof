import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MapScreen } from '../src/screens/Map';
import { mockApi, ORG, ORG_WITH_TEAMS } from './api-mock';

describe('Map', () => {
  it('shows the chief, the company people and the empty state on first run', async () => {
    mockApi({ 'GET /api/org': [200, ORG] });
    render(<MapScreen />);
    expect(await screen.findByText('No departments yet. Ask the chief to create the first one.')).toBeInTheDocument();
    expect(screen.getByText('0/1')).toBeInTheDocument();
    expect(screen.getByText('agents working')).toBeInTheDocument();
    expect(screen.getByText('Ivan')).toBeInTheDocument();
    expect(screen.getByText('Maria')).toBeInTheDocument();
    expect(screen.getByText('Runs on Anthropic key ending 9f3a')).toBeInTheDocument();
  });

  it('places departments around the chief', async () => {
    mockApi({ 'GET /api/org': [200, ORG_WITH_TEAMS] });
    render(<MapScreen />);
    expect(await screen.findByText('Marketing')).toBeInTheDocument();
    expect(screen.getByText('Development')).toBeInTheDocument();
    expect(screen.getByText('2 teams')).toBeInTheDocument();
    expect(screen.queryByText(/No departments yet/)).not.toBeInTheDocument();
  });

  it('tells when the chief has no subscription', async () => {
    mockApi({ 'GET /api/org': [200, { ...ORG, chief: { ...ORG.chief, subscription: null } }] });
    render(<MapScreen />);
    expect(await screen.findByText('Needs a subscription to start')).toBeInTheDocument();
  });
});
