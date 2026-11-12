// @vitest-environment jsdom
/**
 * RouteErrorFallback 回归测试(2026-07-09 React #130 事故)。
 *
 * 验证:路由子树渲染抛错时,errorElement 渲染出产品自己的可恢复错误页
 * (标题 / 重新加载 / 回主界面 / 错误详情),而不是 react-router 的
 * 开发者默认错误页,也不会把错误继续往上抛炸掉整个应用。
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';

// 仓库同款 i18n mock:t 返回 key 本身,断言直接用 key。
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { RouteErrorFallback } from '../RouteErrorFallback';
import { isRouteErrorVisible, resetRouteErrorVisibilityForTests } from '../routeErrorVisibility';

function Bomb(): never {
  // 模拟事故场景:组件渲染期抛错(真实事故是渲染 <undefined/> 抛 React #130)
  throw new Error('boom: element type is invalid');
}

function renderWithError(variant?: 'fullscreen' | 'section') {
  const router = createMemoryRouter([
    {
      path: '/',
      errorElement: <RouteErrorFallback variant={variant} />,
      element: <Bomb />,
    },
  ]);
  return render(<RouterProvider router={router} />);
}

afterEach(() => { cleanup(); resetRouteErrorVisibilityForTests(); });

describe('RouteErrorFallback', () => {
  it('子树渲染抛错时展示可恢复错误页(标题 + 两个动作 + 详情折叠)', () => {
    // React 会把渲染期错误重复打到 console.error,静音以免测试输出刷屏
    const silence = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      renderWithError();
      expect(screen.getByText('appError.title')).toBeTruthy();
      expect(screen.getByText('appError.reload')).toBeTruthy();
      expect(screen.getByText('appError.backHome')).toBeTruthy();
      expect(screen.queryByText(/boom: element type is invalid/)).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'chat.errorBanner.networkShowRaw' }));
      // 错误详情里能看到原始 message(给用户复制反馈用)
      expect(screen.getByText(/boom: element type is invalid/)).toBeTruthy();
    } finally {
      silence.mockRestore();
    }
  });

  // 404/未知路由会把整棵路由树(含启动门闸)换成兜底页;启动遮罩必须据此让位,
  // 否则用户只看到永远转圈的「唤醒 Cindy 中…」。判定来自真实路由错误,不是 URL 形状。
  it('全屏路由错误(404)时告诉启动遮罩让位,卸载后恢复', () => {
    const router = createMemoryRouter(
      [{ path: '/', element: <div>home</div>, errorElement: <RouteErrorFallback /> }],
      { initialEntries: ['/nope'] },
    );
    const view = render(<RouterProvider router={router} />);
    expect(screen.getByText('appError.title')).toBeTruthy();
    expect(screen.getByText('appError.backHome')).toBeTruthy();
    expect(isRouteErrorVisible()).toBe(true);
    view.unmount();
    expect(isRouteErrorVisible()).toBe(false);
  });

  it('section 变体(内容区崩溃、外壳与启动门闸仍在)不触碰启动遮罩状态', () => {
    const silence = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      renderWithError('section');
      expect(screen.getByText('appError.title')).toBeTruthy();
      expect(isRouteErrorVisible()).toBe(false);
    } finally {
      silence.mockRestore();
    }
  });

  it('section 变体同样渲染完整动作(挂在 MainLayout 内容区的场景)', () => {
    const silence = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      renderWithError('section');
      expect(screen.getByText('appError.title')).toBeTruthy();
      expect(screen.getByText('appError.reload')).toBeTruthy();
    } finally {
      silence.mockRestore();
    }
  });
});
