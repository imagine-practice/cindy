/**
 * projectsStore — 实体项目列表的模块级单例 store。
 *
 * 与 `recentWorkdirsStore` 同源：一个 cache 数组 + subscribe + ensure + forceRefresh，
 * 自订阅 main 的 `projects:changed` 广播。所有读写都按 data owner generation 设栅栏，
 * 切账号后旧请求的回包不许落进新账号的缓存。
 *
 * 本 store 只持「项目快照」（名称/负责人/成员/任务数）。任务列表与成员操作在
 * 项目详情页按需读 `projects.detail`，避免把每个项目的全部工作项常驻内存。
 */

import {
  getDataOwnerGeneration,
  isDataOwnerPushCurrent,
  type DataOwnerGeneration,
} from '@/contexts/dataOwnerGeneration';
import type { ProjectRecord } from '../../../shared/projects';
import type { EntityProjectOption } from '../cc-agent/lib/projectGrouping';
import { listProjects } from './projectService';

let cache: ProjectRecord[] | null = null;
let derivedIndex: EntityProjectOption[] = [];
let derivedFrom: ProjectRecord[] | null | undefined;
let activeOwner: DataOwnerGeneration = getDataOwnerGeneration();
let requestGeneration = 0;
let inflight: { generation: number; promise: Promise<ProjectRecord[]> } | null = null;
const subs = new Set<() => void>();

function notify(): void {
  subs.forEach((fn) => fn());
}

/** 数据 owner 变了：丢掉旧账号的快照（签名与 recentWorkdirsStore 一致）。 */
function syncOwner(): void {
  const current = getDataOwnerGeneration();
  if (current !== activeOwner) {
    activeOwner = current;
    requestGeneration += 1;
    cache = null;
    inflight = null;
    notify();
  }
}

async function fetchList(): Promise<ProjectRecord[]> {
  if (typeof window === 'undefined' || !window.electronAPI?.localDb?.projects) return [];
  return listProjects();
}

export const projectsStore = {
  subscribe(fn: () => void): () => void {
    subs.add(fn);
    return () => {
      subs.delete(fn);
    };
  },

  get(): ProjectRecord[] | null {
    syncOwner();
    return cache;
  },

  /**
   * 分组输入用的稳定快照。`useSyncExternalStore` 要求未变更时返回同一引用，
   * 所以只在 cache 换了之后重建（同步的，保证同一次 render 内引用稳定）。
   */
  getIndex(): EntityProjectOption[] {
    syncOwner();
    if (derivedFrom !== cache) {
      derivedFrom = cache;
      derivedIndex = (cache ?? []).map((project) => ({
        id: project.id,
        name: project.name,
        updatedAt: project.updatedAt,
        // 认领的目录随项目快照一起进分组：目录里的历史任务并到项目行，侧栏只留一行。
        dirs: project.dirs.map((dir) => dir.dirKey),
      }));
    }
    return derivedIndex;
  },

  async ensure(): Promise<void> {
    syncOwner();
    if (cache !== null) return;
    if (!inflight) {
      const generation = requestGeneration;
      const promise = fetchList()
        .then((data) => {
          if (generation !== requestGeneration) return data;
          cache = data;
          if (inflight?.generation === generation) inflight = null;
          notify();
          return data;
        })
        .catch((error: unknown) => {
          if (inflight?.generation === generation) inflight = null;
          throw error;
        });
      inflight = { generation, promise };
    }
    await inflight.promise;
  },

  async forceRefresh(): Promise<ProjectRecord[]> {
    syncOwner();
    requestGeneration += 1;
    const generation = requestGeneration;
    const data = await fetchList();
    if (generation !== requestGeneration) return cache ?? data;
    cache = data;
    inflight = null;
    notify();
    return data;
  },

  /** 仅供测试 / 登出清理。 */
  reset(): void {
    requestGeneration += 1;
    cache = null;
    inflight = null;
    notify();
  },
};

if (typeof window !== 'undefined') {
  const api = window.electronAPI?.localDb?.projects;
  if (api?.onChanged) {
    api.onChanged((_payload, ownerStamp) => {
      if (!isDataOwnerPushCurrent(ownerStamp)) return;
      void projectsStore.forceRefresh().catch(() => {
        /* 静默：下次 ensure / 用户操作会再试 */
      });
    });
  }
}
