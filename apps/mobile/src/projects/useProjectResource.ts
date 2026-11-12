/**
 * 项目详情的一次读取 + 写动作提交状态。
 *
 * 契约 §6 只选一种刷新路径:**控制器重读**。写成功后由页面调用 `reload()` 重读详情,
 * invoke 返回体里的 `resource`/`result` 一律不消费(不做本地覆盖)。宿主写后推送的
 * REMOTE_RESOURCE_CHANGED 由 `DeviceLinkContext` 既有分发交给 `onRemoteResourceChanged`,
 * 与写后重读走同一个 `load()`,在途时合并,所以两者同时到达也只发一次请求。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { useTranslation } from 'react-i18next';
import type { RemoteResource } from '@cindy/device-link';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import { getRemoteResource, type RemoteResourceHostTarget } from '@/device-link/remoteResources';
import { humanizeRemoteError } from '@/device-link/remoteStatus';
import { projectActionErrorText } from './projectErrors';
import { PROJECT_COLLECTION_ID, PROJECT_PRIMITIVES } from './projectModel';
import type { ProjectActionRunner } from './projectActions';

export interface ProjectResourceState {
  resource: RemoteResource | null;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
}

const EMPTY: ProjectResourceState = { resource: null, loading: true, refreshing: false, error: null };

export function useProjectResource(host: RemoteResourceHostTarget, projectId: string) {
  const { invoke, openLink, onRemoteResourceChanged } = useDeviceLink();
  const { i18n } = useTranslation();
  const [state, setState] = useState<ProjectResourceState>(EMPTY);
  const binding = `${host.deviceId}:${projectId}`;
  const bindingRef = useRef(binding);
  bindingRef.current = binding;
  const generation = useRef(0);
  const loadedOnce = useRef(false);
  // 写成功后的重读与宿主推送的重读走同一个 load:同一时刻只保留一次在途请求。
  const pending = useRef<Promise<void> | null>(null);

  const read = useCallback(async (visible: boolean): Promise<void> => {
    if (!projectId) return;
    const expected = ++generation.current;
    const current = () => generation.current === expected && bindingRef.current === binding;
    setState((previous) => ({
      ...previous,
      loading: previous.resource === null,
      refreshing: visible && previous.resource !== null,
    }));
    try {
      await openLink(host.deviceId);
      if (!current()) return;
      const resource = await getRemoteResource(
        invoke,
        host,
        { collectionId: PROJECT_COLLECTION_ID, kind: 'project', id: projectId },
        i18n.language,
        [...PROJECT_PRIMITIVES],
      );
      if (!current()) return;
      setState({ resource, loading: false, refreshing: false, error: null });
    } catch (cause) {
      if (!current()) return;
      // 失败时保留已读到的内容,只把原因显示出来。
      setState((previous) => ({ ...previous, loading: false, refreshing: false, error: humanizeRemoteError(cause) }));
    }
  }, [binding, host, i18n.language, invoke, openLink, projectId]);

  /**
   * 写成功后的重读、宿主的 REMOTE_RESOURCE_CHANGED、回前台补读都走这里。
   * 静默读在途时直接复用同一个请求(写后重读与推送同时到达只发一次);下拉刷新总是重新读。
   */
  const load = useCallback((visible: boolean): Promise<void> => {
    if (!visible && pending.current) return pending.current;
    let tracked: Promise<void>;
    tracked = read(visible).finally(() => { if (pending.current === tracked) pending.current = null; });
    pending.current = tracked;
    return tracked;
  }, [read]);

  useEffect(() => {
    void load(false);
  }, [load]);

  useEffect(() => {
    if (state.resource && !loadedOnce.current) loadedOnce.current = true;
  }, [state.resource]);

  useFocusEffect(useCallback(() => {
    // 首次进入由上面的 effect 读取;回到前台/从别的页面返回时补一次。
    if (loadedOnce.current) void load(false);
  }, [load]));

  useEffect(() => onRemoteResourceChanged((deviceId, payload) => {
    if (deviceId !== host.deviceId || payload.collectionId !== PROJECT_COLLECTION_ID) return;
    if (payload.resourceRefs && !payload.resourceRefs.some((ref) => ref.id === projectId)) return;
    void load(false);
  }), [host.deviceId, load, onRemoteResourceChanged, projectId]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') void load(false);
    });
    return () => subscription.remove();
  }, [load]);

  const refresh = useCallback(() => { void load(true); }, [load]);
  return { ...state, refresh, reload: load };
}

export function useProjectSubmit(runner: ProjectActionRunner) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  const clearError = useCallback(() => setError(null), []);
  const submit = useCallback(async (actionId: string, input: Record<string, unknown>) => {
    if (inFlight.current) return false;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const outcome = await runner.submit(actionId, input);
      if (outcome.ok) return true;
      if (alive.current) setError(projectActionErrorText(t, outcome.error));
      return false;
    } finally {
      inFlight.current = false;
      if (alive.current) setBusy(false);
    }
  }, [runner, t]);
  return { busy, error, submit, clearError };
}
