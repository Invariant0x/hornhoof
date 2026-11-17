import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { parseRoute, routePath, useRoute } from '../src/routes';

describe('workspace addresses', () => {
  it.each([
    ['/', { kind: 'map' }],
    ['/tasks', { kind: 'tasks' }],
    ['/tasks/t12', { kind: 'tasks', id: 't12' }],
    ['/people', { kind: 'people' }],
    ['/people/p2', { kind: 'people', id: 'p2' }],
    ['/departments/d2', { kind: 'department', id: 'd2' }],
    ['/subscriptions', { kind: 'subscriptions' }],
    ['/machines', { kind: 'machines' }],
    ['/machines/m1', { kind: 'machines', id: 'm1' }],
    ['/improvements', { kind: 'improvements' }],
    ['/versions', { kind: 'versions' }],
    ['/settings', { kind: 'settings' }],
    ['/settings/profile', { kind: 'settings', group: 'profile' }],
    ['/settings/integrations', { kind: 'settings', group: 'integrations' }],
    ['/settings/company', { kind: 'settings', group: 'company' }],
    ['/about', { kind: 'about' }],
    ['/invite/abc123', { kind: 'invite', token: 'abc123' }],
    ['/tasks?person=p2', { kind: 'tasks', personId: 'p2' }],
  ] as const)('opens and shares %s', (path, route) => {
    expect(parseRoute(path)).toEqual(route);
    expect(routePath(route)).toBe(path);
  });

  it.each(['/missing', '/tasks/a/b', '/theme', '/departments', '/tasks/%', '/people/%2fsecret', '/machines/%5cevil', '//outside.example', 'https://outside.example/tasks', '/\\outside.example', '/people/%00', '/people/..', '/outbound', '/settings/messaging', '/feedback', '/profile', '/themes', '/settings/appearance', '/settings/company/x'])('rejects unknown or unsafe destination %s', path => {
    expect(parseRoute(path)).toEqual({ kind: 'unavailable' });
  });

  it('does not follow an external return parameter', () => {
    expect(parseRoute('/tasks?next=https://outside.example')).toEqual({ kind: 'tasks' });
    expect(routePath({ kind: 'people', id: '//outside.example' })).toBe('/not-found');
  });

  it('adds one entry on navigation and follows browser history', () => {
    const { result } = renderHook(() => useRoute());
    const length = history.length;
    act(() => result.current.navigate({ kind: 'tasks' }));
    expect(location.pathname).toBe('/tasks');
    expect(result.current.route).toEqual({ kind: 'tasks' });
    act(() => result.current.navigate({ kind: 'tasks' }));
    expect(history.length).toBe(length + 1);
    act(() => {
      history.replaceState(null, '', '/people/p2');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(result.current.route).toEqual({ kind: 'people', id: 'p2' });
  });

  it('ignores an external dialog background in a browser history entry', () => {
    history.replaceState({ hhBackground: 'https://outside.example' }, '', '/about');
    const { result } = renderHook(() => useRoute());
    act(() => result.current.closeOverlay());
    expect(location.pathname).toBe('/');
    expect(location.host).toBe('localhost:3000');
  });

  it('keeps nested return paths local and ignores malformed underlays', () => {
    history.replaceState({ hhBackground: '/tasks/t12', hhUnderlays: ['https://outside.example', 8] }, '', '/about');
    const { result } = renderHook(() => useRoute());
    act(() => result.current.closeOverlay());
    expect(location.pathname).toBe('/tasks/t12');
    act(() => result.current.closeOverlay());
    expect(location.pathname).toBe('/');
    expect(location.host).toBe('localhost:3000');
  });
});
