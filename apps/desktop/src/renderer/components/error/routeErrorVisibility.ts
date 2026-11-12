import { useSyncExternalStore } from 'react';

/**
 * 「路由级全屏错误正在显示」的最小外部状态。
 *
 * 为什么需要它:SplashScreen(z-9999)与 LoginBrandStage(z-9980)都挂在 RouterProvider **外面**
 * (App.tsx),而路由错误把整棵路由树(含启动门闸 LocalDbGate)换成兜底页,门闸再也收不到就绪
 * 信号,两层遮罩就把兜底页永久盖住 —— 用户看到的是永远转圈的「唤醒 Cindy 中…」。
 *
 * 这里只有一条事实:「当前是否正在显示全屏路由错误」。由 RouteErrorFallback 挂载/卸载时写入,
 * 启动遮罩据此让位。它不猜 URL 形状、不做超时兜底,正常启动时始终为 false,
 * 因此原启动路径的渲染结果逐字节不变。
 */
let visible = false;
const listeners = new Set<() => void>();

export function setRouteErrorVisible(next: boolean): void {
  if (visible === next) return;
  visible = next;
  for (const listener of listeners) listener();
}

export function isRouteErrorVisible(): boolean {
  return visible;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useRouteErrorVisible(): boolean {
  return useSyncExternalStore(subscribe, isRouteErrorVisible, isRouteErrorVisible);
}

/** Tests only: forget the flag between cases. */
export function resetRouteErrorVisibilityForTests(): void {
  visible = false;
  for (const listener of listeners) listener();
}
