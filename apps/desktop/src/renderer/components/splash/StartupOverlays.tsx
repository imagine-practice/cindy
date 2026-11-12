import { LoginBrandStage } from '@/components/login/LoginBrandStage';
import { useRouteErrorVisible } from '@/components/error/routeErrorVisibility';
import { SplashScreen } from './SplashScreen';

/**
 * 启动遮罩的两层(品牌画 z-9980 + 遮罩卡 z-9999),只在主窗口挂载。
 *
 * 全屏路由错误(RouteErrorFallback variant="fullscreen")会把整棵路由树换成兜底页,启动门闸
 * 随之消失、再也等不到就绪信号;此时继续画遮罩只会把错误页永久盖住。路由错误本身是真实状态
 * (RouteErrorFallback 挂载/卸载),不是 URL 形状猜测,也不靠超时兜底:正常启动时该状态恒为
 * false,两层渲染结果与拆分前完全一致。
 */
export function StartupOverlays({ enabled }: { enabled: boolean }): React.ReactElement | null {
  const routeErrorVisible = useRouteErrorVisible();
  if (!enabled || routeErrorVisible) return null;
  return (
    <>
      <LoginBrandStage />
      <SplashScreen />
    </>
  );
}
