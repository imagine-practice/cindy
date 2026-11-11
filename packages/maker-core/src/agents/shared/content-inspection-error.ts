/**
 * 内容审核拒绝类错误识别 — 判断报错是不是「上游对**请求内容**做了安全审核并确定性拒绝」。
 *
 * **与 overload-error.ts / network-error.ts / context-overflow-error.ts 的分工**：
 * 那三份分别管「上游没容量」「网络到不了上游」「请求太大被拒」；本份管「请求内容被
 * 供应商策略拒绝」——它同样**重试必然再撞**，但恢复动作与前三份都不同：不是等一会、
 * 不是查网络、也不是压缩体积，而是**把触发审核的那段内容从历史里去掉**（回退本轮 /
 * 用可读历史新建任务）或换一条不做该审核的链路。四类文案与动作完全不同，所以刻意
 * 不合并判定。
 *
 * 已知措辞形态（每条都有真实错误体为证，不凭推测加）：
 *  - 阿里云百炼 / DashScope（经 Cindy CN 网关透传，Pi harness，2026-11-11 实踩）:
 *    `{"error":{"code":"data_inspection_failed","type":"data_inspection_failed",
 *    "message":"Input text data may contain inappropriate content."}}`
 *    —— HTTP 400，且内层被包在 `data: ` 里，是**流式响应的 SSE 错误帧**而非头部拒绝。
 *  - 同类供应商（#2792 实踩）: `sensitive_words_detected` —— HTTP **500** 形态。
 *    同一条产品结论：确定性策略拒绝不应按可重试的 5xx 服务端故障呈现。
 *
 * **未收录**（无本仓库真实错误体为证，取得样本后再加，与 desktop `providerErrors.ts`
 * 同步说明）: OpenAI / Azure 的 `content_filter`、各家网关自造的 `content policy` 措辞。
 *
 * **故意不收**裸 `inappropriate content` / `敏感词` / `content policy` 这类宽措辞：它们
 * 会出现在工具输出、被审查的网页正文与用户粘贴的文本里，而本判定的输入是 redact 后的
 * 错误 envelope 文本，放宽只会把无关失败误判成策略拒绝、进而隐藏本该有用的 Retry。只认
 * 稳定错误码与整句官方措辞。
 *
 * 为什么会走到这一步（本次事故链，2026-11-11）：Agent 排查登录问题时用 `bash` 读了凭据
 * 文件的 hexdump，3 行 `00000000: 646a 4577 …` 进入 `tool_result`；**1 ms 后**下一轮请求
 * 即被上游审核拒绝。Pi 的会话转录永久保留该 `tool_result` 并**每轮重发**，于是原会话此后
 * 每一轮都命中同一拒绝——重试不自愈，用户只能回退或新建任务。在此之前用户看到的只有
 * 「回复未完成」加一坨原始 JSON，没有任何出路提示。本模块的 reason key 就是这条链的
 * 解锁点：translator 终态识别 → renderer 本地化文案 + 隐藏必败的 Retry。
 *
 * 消费方：
 *  - pi translator：终态 error 事件附带 `CONTENT_INSPECTION_REASON`（本份 pattern 优先于
 *    context-overflow / unsupported-request-option 判定，因为它同样带 `invalid_request_error`
 *    外壳，晚一步就会被更宽的分支吃掉）。
 *  - renderer ErrorBanner：按 reason 取本地化文案并 hideRetry；历史持久化错误行只有文案
 *    可用，故 renderer 另有一份**语义一致**的同名判定（见
 *    `apps/desktop/src/renderer/utils/contentInspectionError.ts`），改 pattern 两处同步。
 *  - desktop main 的 `providerErrors.ts` 是第三份同语义 pattern（供应商上游错误分类，
 *    作用域是 proxy 层响应体而非 turn error），与 overload / network / context-overflow
 *    的三处同步惯例同款。
 */

/**
 * 内容审核拒绝 error 事件上带的**稳定 reason key**。
 *
 * 走 `reason` 这个既有通道而不是新增字段：`reason` 本就是「maker-core 用稳定 key 告诉
 * renderer 这是什么错误」的现成语义（`context-overflow` / `upstream-overload` 同款）。
 * renderer 隔着 IPC 投影拿不到结构化的 provider 分类，靠这个 key 驱动 ErrorBanner 的
 * 本地化文案、hideRetry 与恢复动作。
 */
export const CONTENT_INSPECTION_REASON = 'content-inspection-rejected';

/**
 * Pattern 与 desktop `providerErrors.ts` 的 `CONTENT_INSPECTION_RE` 同源。
 * 大小写不敏感；判定对象是 redact 后的 API 错误 envelope 文本，不是工具输出。
 */
const CONTENT_INSPECTION_RE =
  /data_inspection_failed|sensitive_words_detected|input text data may contain inappropriate content/i;

/** 只认稳定错误码与整句官方措辞；命中即归本类。 */
export function isContentInspectionErrorText(text: string | null | undefined): boolean {
  if (!text) return false;
  return CONTENT_INSPECTION_RE.test(text.slice(0, 4096));
}

/**
 * 终态 error 的判定入口：`reason` 优先（新数据），文本匹配兜底（老 daemon 与
 * 历史持久化错误行——那里只剩文案）。
 */
export function isContentInspectionErrorMessage(
  message: string | null | undefined,
  reason?: string | null,
): boolean {
  if (reason === CONTENT_INSPECTION_REASON) return true;
  return isContentInspectionErrorText(message);
}
