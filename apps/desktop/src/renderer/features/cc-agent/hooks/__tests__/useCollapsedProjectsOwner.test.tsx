// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { sidebarOwnerStorageKey } from '@/lib/sidebarOwnerStorage';
import { useCollapsedProjects } from '../useCollapsedProjects';
import { entityProjectKey } from '../../lib/projectGrouping';

const PROJECT = 'local:/workspace/a';
const PROJECT_B = 'local:/workspace/b';
const STORAGE_KEY = 'cc-agent.sidebar.collapsedProjects';

beforeEach(() => {
  window.localStorage.clear();
});

describe('collapsed project owner state', () => {
  // Entity IDs must keep the same owner isolation/reload contract as folder keys.
  it.each([PROJECT, entityProjectKey('owner-project')])('isolates and reloads owner state for %s', (projectKey) => {
    const ownerA = renderHook(() => useCollapsedProjects([projectKey], 'owner-a'));
    act(() => ownerA.result.current.toggle(projectKey));
    expect(ownerA.result.current.collapsed.has(projectKey)).toBe(true);
    ownerA.unmount();

    const ownerB = renderHook(() => useCollapsedProjects([projectKey], 'owner-b'));
    expect(ownerB.result.current.collapsed.has(projectKey)).toBe(false);
    ownerB.unmount();

    const ownerAReloaded = renderHook(() => useCollapsedProjects([projectKey], 'owner-a'));
    expect(ownerAReloaded.result.current.collapsed.has(projectKey)).toBe(true);
  });

  // Unit: production state/storage APIs; entity IDs must not alias relative folder paths.
  it('keeps entity and folder identities separate through individual and bulk folding', () => {
    const entity = entityProjectKey('same-id');
    const folder = 'local:project:same-id';
    const hook = renderHook(() => useCollapsedProjects([entity, folder], 'owner-a', 'win32'));
    act(() => hook.result.current.toggle(entity));
    expect(hook.result.current.collapsed).toEqual(new Set([entity]));
    act(() => hook.result.current.setCollapsed(folder, true));
    act(() => hook.result.current.expand(entity));
    expect(hook.result.current.collapsed).toEqual(new Set([folder]));
    act(() => hook.result.current.collapseAll());
    expect(hook.result.current.isAllCollapsed).toBe(true);
    expect(hook.result.current.collapsed).toEqual(new Set([entity, folder]));
    act(() => hook.result.current.expandAll());
    expect(hook.result.current.collapsed.size).toBe(0);
  });

  it('moves a legacy collapse value only into the first owner namespace', () => {
    window.localStorage.setItem(
      'cc-agent.sidebar.collapsedProjects',
      JSON.stringify({
        [PROJECT]: { collapsed: true, lastSeenAt: new Date().toISOString() },
      }),
    );

    const ownerA = renderHook(() => useCollapsedProjects([PROJECT], 'owner-a'));
    expect(ownerA.result.current.collapsed.has(PROJECT)).toBe(true);
    ownerA.unmount();

    const ownerB = renderHook(() => useCollapsedProjects([PROJECT], 'owner-b'));
    expect(ownerB.result.current.collapsed.has(PROJECT)).toBe(false);
  });

  it('reloads the new owner before GC and keeps mutations in that owner namespace', () => {
    const stale = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    const fresh = new Date().toISOString();
    const ownerAKey = sidebarOwnerStorageKey(STORAGE_KEY, 'owner-a');
    const ownerBKey = sidebarOwnerStorageKey(STORAGE_KEY, 'owner-b');
    const ownerAValue = JSON.stringify({
      [PROJECT]: { collapsed: true, lastSeenAt: stale },
    });
    const ownerBValue = JSON.stringify({
      [PROJECT_B]: { collapsed: true, lastSeenAt: fresh },
    });
    window.localStorage.setItem(ownerAKey, ownerAValue);
    window.localStorage.setItem(ownerBKey, ownerBValue);

    const hook = renderHook(
      ({ active, ownerId }: { active: string[]; ownerId: string }) =>
        useCollapsedProjects(active, ownerId),
      { initialProps: { active: [PROJECT], ownerId: 'owner-a' } },
    );
    expect(hook.result.current.collapsed).toEqual(new Set([PROJECT]));
    const staleOwnerAToggle = hook.result.current.toggle;

    hook.rerender({ active: [PROJECT_B], ownerId: 'owner-b' });
    expect(hook.result.current.collapsed).toEqual(new Set([PROJECT_B]));
    expect(window.localStorage.getItem(ownerAKey)).toBe(ownerAValue);
    expect(window.localStorage.getItem(ownerBKey)).toBe(ownerBValue);

    act(() => staleOwnerAToggle(PROJECT));
    expect(hook.result.current.collapsed).toEqual(new Set([PROJECT_B]));
    expect(window.localStorage.getItem(ownerAKey)).toBe(ownerAValue);
    expect(window.localStorage.getItem(ownerBKey)).toBe(ownerBValue);

    act(() => hook.result.current.toggle(PROJECT_B));
    expect(hook.result.current.collapsed.size).toBe(0);
    expect(window.localStorage.getItem(ownerAKey)).toBe(ownerAValue);
    expect(window.localStorage.getItem(ownerBKey)).toBe('{}');
  });

  it('keeps and expands a stored Windows collapse entry through live casing changes', () => {
    const storedProject = 'local:D:/École/Project-A';
    const liveProject = 'local:d:/école/project-a';
    const ownerKey = sidebarOwnerStorageKey(STORAGE_KEY, 'owner-a');
    window.localStorage.setItem(
      ownerKey,
      JSON.stringify({
        [storedProject]: {
          collapsed: true,
          lastSeenAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString(),
        },
      }),
    );

    const hook = renderHook(() => useCollapsedProjects([liveProject], 'owner-a', 'win32'));
    expect(hook.result.current.collapsed).toEqual(new Set([liveProject]));
    expect(hook.result.current.isAllCollapsed).toBe(true);

    act(() => hook.result.current.toggle(liveProject));
    expect(hook.result.current.collapsed.size).toBe(0);
    expect(window.localStorage.getItem(ownerKey)).toBe('{}');

    act(() => hook.result.current.toggle(liveProject));
    expect(hook.result.current.collapsed).toEqual(new Set([liveProject]));

    act(() => hook.result.current.expand(liveProject));
    expect(hook.result.current.collapsed.size).toBe(0);
    expect(window.localStorage.getItem(ownerKey)).toBe('{}');
  });
});
