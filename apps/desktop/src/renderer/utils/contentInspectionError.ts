/**
 * 内容审核拒绝类错误识别（renderer 侧）— 判断错误 message 是不是「上游对请求内容做了
 * 安全审核并确定性拒绝」，ErrorBanner 用它把原始英文报错换成友好文案 + 可操作恢复入口，
 * 并隐藏必败的 Retry。
 *
 * 判定与 maker-core 的 `packages/maker-core/src/agents/shared/content-inspection-error.ts`
 * **语义一致**（不跨 bundle 共享代码，与 overload / network / streamInterrupt 的
 * 两端一致性同款惯例）。修改 pattern 时两处同步。
 *
 * **与其余三类的分工**：network 管「网络到不了上游」，overload 管「上游没容量」，
 * streamInterrupt 管「流中途断了」——三者都可能自愈。本类管「内容被策略确定性拒绝」：
 * 载荷留在会话历史里每轮重发，**重试必然再撞**，唯一出路是把那段内容从历史去掉
 * （回退本轮 / 用可读历史新建任务）或换一条不做该审核的链路。把这类说成「稍后重试」
 * 会让用户在一个已经自锁的会话里反复空转。
 *
 * 只认稳定错误码与整句官方措辞，每条都有真实错误体为证（详见 maker-core 那份的注释）。
 * 故意不收裸 `inappropriate content` / `敏感词`：它们会出现在工具输出与被审查的网页
 * 正文里，放宽会把无关失败误判成策略拒绝。
 */

/** 与 maker-core `CONTENT_INSPECTION_REASON` 同源，改一处两处同步。 */
export const CONTENT_INSPECTION_REASON = 'content-inspection-rejected';

const CONTENT_INSPECTION_RE =
  /data_inspection_failed|sensitive_words_detected|input text data may contain inappropriate content/i;

export function isContentInspectionErrorText(text: string | null | undefined): boolean {
  if (!text) return false;
  return CONTENT_INSPECTION_RE.test(text.slice(0, 4096));
}

/**
 * `reason` 优先（活着的 ErrorBanner），文本匹配兜底（历史持久化的 ErrorMessageCard
 * 只剩文案可用）。与 overload / streamInterrupt 的签名同款。
 */
export function isContentInspectionErrorMessage(
  message: string | null | undefined,
  reason?: string | null,
): boolean {
  if (reason === CONTENT_INSPECTION_REASON) return true;
  return isContentInspectionErrorText(message);
}
