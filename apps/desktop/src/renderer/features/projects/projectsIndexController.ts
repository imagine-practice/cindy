import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
} from '@/contexts/dataOwnerGeneration';
import { ApiError } from '@/lib/httpClient';
import { extractIpcError } from '@/utils/ipcError';
import type { ProjectRecord, ProjectMember, ProjectSubject } from '../../../shared/projects';
import { projectSubjectKey } from '../../../shared/projects';
import { listProjects, onProjectsChanged } from './projectService';

type Phase = 'loading' | 'ready' | 'error';
export interface ProjectsIndexState {
  phase: Phase;
  records: ProjectRecord[];
  error: string | null;
  canCreate: boolean;
}
function host() {
  return (
    window as unknown as {
      electronAPI?: {
        localDb?: { projects?: { list?: unknown; onChanged?: unknown; mutate?: unknown } };
      };
    }
  ).electronAPI?.localDb?.projects;
}
function bad(): never {
  throw new ApiError('INVALID_RESPONSE', 0, 'Invalid project list response');
}
function object(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return bad();
  return raw as Record<string, unknown>;
}
function string(raw: unknown, empty = false): string {
  if (typeof raw !== 'string' || (!empty && !raw.trim())) return bad();
  return raw;
}
function nullable(raw: unknown): string | null {
  return raw === null ? null : string(raw, true);
}
/** Validate public ProjectRecord data; missing host/malformed replies never become an empty success. */
function recordsOf(raw: unknown): ProjectRecord[] {
  if (!Array.isArray(raw)) return bad();
  const ids = new Set<string>();
  return raw.map((value) => {
    const r = object(value);
    const id = string(r.id);
    if (ids.has(id)) return bad();
    ids.add(id);
    if (r.status !== 'active' && r.status !== 'archived') return bad();
    if (!Number.isSafeInteger(r.taskCount) || Number(r.taskCount) < 0 || !Array.isArray(r.members))
      return bad();
    const members = new Map<string, ProjectMember>();
    for (const value of r.members) {
      const m = object(value);
      const s = object(m.subject);
      if ((s.kind !== 'account' && s.kind !== 'bot') || (m.role !== 'owner' && m.role !== 'member'))
        return bad();
      const subject: ProjectSubject = {
        kind: s.kind,
        id: string(s.id),
        displayName: nullable(s.displayName),
        avatar: nullable(s.avatar),
        avatarColor: nullable(s.avatarColor),
      };
      const key = projectSubjectKey(subject);
      const member: ProjectMember = { subject, role: m.role, addedAt: string(m.addedAt, true) };
      if (members.has(key) && members.get(key)!.role !== member.role) return bad();
      members.set(key, member);
    }
    if ([...members.values()].filter((m) => m.role === 'owner').length !== 1) return bad();
    return {
      id,
      name: string(r.name),
      goal: nullable(r.goal),
      ownerId: string(r.ownerId),
      status: r.status,
      members: [...members.values()],
      taskCount: r.taskCount as number,
      createdAt: string(r.createdAt, true),
      updatedAt: string(r.updatedAt, true),
    };
  });
}
function errorKind(error: unknown): string {
  const direct = (error as { code?: unknown } | null)?.code ?? extractIpcError(error)?.code;
  // M1's fixed error enum may not yet know M3 project access codes; only classify failures.
  const code =
    direct && direct !== 'UNKNOWN'
      ? direct
      : error instanceof Error
        ? /(?:^|: Error: )\[([A-Z0-9_]+)\]/.exec(error.message)?.[1]
        : direct;
  if (
    code === 'FORBIDDEN' ||
    code === 'UNAUTHORIZED' ||
    code === 'AUTH_REQUIRED' ||
    code === 'NOT_PROJECT_MEMBER' ||
    code === 'NOT_PROJECT_OWNER' ||
    code === 'ACCOUNT_REAUTH_REQUIRED'
  )
    return 'forbidden';
  if (code === 'HOST_UNAVAILABLE') return 'hostUnavailable';
  if (code === 'INVALID_RESPONSE') return 'invalidResponse';
  return 'loadFailed';
}
/** One owner epoch per mounted controller. Notifications clear prior data before the authority reread. */
export function useProjectsIndex() {
  const [state, setState] = useState<ProjectsIndexState>({
    phase: 'loading',
    records: [],
    error: null,
    canCreate: false,
  });
  const mounted = useRef(false);
  const subscribed = useRef(false);
  const sequence = useRef(0);
  const owner = useRef(getDataOwnerGeneration());
  const live = useCallback(
    () => mounted.current && isDataOwnerGenerationCurrent(owner.current),
    [],
  );
  const reload = useCallback(async () => {
    if (!live()) return;
    const ticket = ++sequence.current;
    const valid = () => live() && sequence.current === ticket;
    setState({ phase: 'loading', records: [], error: null, canCreate: false });
    try {
      const bridge = host();
      if (!subscribed.current || typeof bridge?.list !== 'function')
        throw new ApiError('HOST_UNAVAILABLE', 0, 'Project list host is unavailable');
      const records = recordsOf(await listProjects());
      if (!valid()) return;
      if (bridge.list !== host()?.list || bridge.onChanged !== host()?.onChanged)
        throw new ApiError('HOST_UNAVAILABLE', 0, 'Project host changed');
      setState({
        phase: 'ready',
        records,
        error: null,
        canCreate: typeof bridge.mutate === 'function',
      });
    } catch (error: unknown) {
      if (valid())
        setState({ phase: 'error', records: [], error: errorKind(error), canCreate: false });
    }
  }, [live]);
  useEffect(() => {
    mounted.current = true;
    let unsubscribe: (() => void) | undefined;
    try {
      if (typeof host()?.onChanged !== 'function')
        throw new ApiError('HOST_UNAVAILABLE', 0, 'Project subscription is unavailable');
      unsubscribe = onProjectsChanged(() => {
        if (live()) void reload();
      });
      if (typeof unsubscribe !== 'function')
        throw new ApiError('HOST_UNAVAILABLE', 0, 'Project subscription is unavailable');
      subscribed.current = true;
      void reload();
    } catch (error: unknown) {
      setState({ phase: 'error', records: [], error: errorKind(error), canCreate: false });
    }
    return () => {
      mounted.current = false;
      subscribed.current = false;
      sequence.current++;
      unsubscribe?.();
    };
  }, [live, reload]);
  return { state, reload, live };
}
