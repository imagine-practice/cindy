// @vitest-environment jsdom
/**
 * 启动遮罩让位契约:全屏路由错误(404/未知路由)时,SplashScreen 与 LoginBrandStage 都不渲染,
 * 兜底页可见可点;错误解除后两层按原样回来。正常启动路径(无路由错误)的渲染结果不变。
 *
 * Minimal failures: 404 时遮罩仍在最上层(用户看到永远转圈);或为了修它而让正常启动也不显示
 * 遮罩/不按原条件退出。
 * Tier: unit(真实 StartupOverlays + 真实路由错误信号;两层组件用替身,它们自身由各自测试覆盖)。
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('@/components/login/LoginBrandStage', () => ({ LoginBrandStage: () => <div data-testid="brand-stage" /> }));
vi.mock('../SplashScreen', () => ({ SplashScreen: () => <div data-testid="splash" /> }));

import { StartupOverlays } from '../StartupOverlays';
import { resetRouteErrorVisibilityForTests, setRouteErrorVisible } from '@/components/error/routeErrorVisibility';

afterEach(() => { cleanup(); resetRouteErrorVisibilityForTests(); });

it('renders both startup layers normally while no route error is showing', () => {
  render(<StartupOverlays enabled />);
  expect(screen.getByTestId('brand-stage')).toBeTruthy();
  expect(screen.getByTestId('splash')).toBeTruthy();
});

it('steps aside while a fullscreen route error is visible, then comes back when it clears', () => {
  render(<StartupOverlays enabled />);
  act(() => setRouteErrorVisible(true));
  expect(screen.queryByTestId('splash')).toBeNull();
  expect(screen.queryByTestId('brand-stage')).toBeNull();
  act(() => setRouteErrorVisible(false));
  expect(screen.getByTestId('splash')).toBeTruthy();
  expect(screen.getByTestId('brand-stage')).toBeTruthy();
});

it('still renders nothing in secondary or sidebar windows', () => {
  render(<StartupOverlays enabled={false} />);
  expect(screen.queryByTestId('splash')).toBeNull();
  expect(screen.queryByTestId('brand-stage')).toBeNull();
});
