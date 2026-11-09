# 材料消费前宿主校验 hook：独立交接

本片只提供 Session 内部消费边界，尚未接入 Desktop main、材料选择器或 used 持久记录。基线为 `1b18485d193812fa0a91a59939b0ab2aa2149707`；修改前 `packages/maker-core/src/session.ts` SHA256 为 `466ABBDA4A4DC1CBE85450D7DFA281A25402E13F7D747340EF64C7C1BC8EA15F`。revision-2 与 PDF 工作树保持冻结。

## 接口与时序

```ts
interface SessionSendOptions extends SendOptions {
  beforeInputConsumption?: (stage: 'vision' | 'provider') => Promise<void>;
}
// Session.steer 的 opts 同时支持两个私有宿主 hook：
type SteerOptions = SendOptions & Pick<SessionSendOptions,
  'beforeProviderStart' | 'beforeInputConsumption'>;
```

| 入口 | 实际顺序 |
| --- | --- |
| send | 原预检及 reservation → 原 beforeProviderStart → onAccepted（含宿主 Git 等准备）→ 新 vision hook → 视觉桥 → resolveAutoReviewUserIntent → 新 provider hook → 同步 onDispatching / observer → handle.send |
| steer | 记录原 turn generation → 新 vision hook → 视觉桥 → 原 beforeProviderStart → 新 provider hook → 原 generation / running 守卫及事件 bookkeeping → handle.steer |

hook 仅在提供时 await；没有 hook 的路径保留原回调次数与顺序。原 beforeProviderStart 的语义、次数不变。新 hook 在视觉桥的降级 catch 外执行：拒绝直接阻止对应消费，不把权限拒绝当作视觉服务失败后改发原文。原视觉服务故障降级保持原样。auto-review 意图仍使用原解析结果。

每次新增 await 返回后，send 复查原 reservation 取消状态和 Session active 状态；steer 复查 active、signal、原 generation 与 running 状态。取消、拆离或原 turn 结束后开启新 turn，旧输入均不能串投。原 reservation、origin 和事件 generation 清理仍由既有路径处理。新 provider hook 之后，最终同步 onDispatching 到 handle.send 之间不增加 await。

两个宿主 hook 均从 vendor options 中剥离；新字段没有加入底层 Agent SendOptions、公共 IPC 或 renderer 参数。stage 表示校验点，提供 hook 时即使没有图片也会经过 vision 点；通过不代表视觉服务或模型实际使用过材料。

## 唯一集成者的最小接线

在可信 main 已捕获 actor、client、owner/source 代次，并准备出固定 context/version/hash 内容的现有正式发送路径中，构造 `Session.send` / `Session.steer` 的私有选项：

```ts
beforeInputConsumption: async (_stage) => {
  await prepared.revalidate();
}
```

此处的 `prepared` 必须由可信宿主持有；沿 revision-2 / PDF 约定保留最终单 SQL 一致读取边界和随后同步 owner/client/source 检查。不得从 raw/renderer 参数展开或反序列化函数，也不得将 renderer actor 当作可信身份。已有 onAccepted、Git、队列、同步租约及 onDispatching 防护继续保留。本片不修改这些调用方，需由唯一集成者在真实 main 路径补测。

准备、hook 通过与实际使用是不同回执：本片不记录 used。实际参考的 context/version/hash、重试幂等、provider 接收回执与持久记录仍需正式发送集成完成。最终读取快照并不与未来 provider 网络派发原子；不得据此声称撤权与远端消费完全原子。hook 拒绝向调用方抛出原错误，main 公共错误投影仍需沿既有脱敏规则处理。新接口没有新增超时或 abort 竞速；宿主异步校验应能正常结束，取消在该 await 返回后检查。

## 验证与边界

专用测试 `packages/maker-core/src/session.input-consumption.test.ts` 使用真实 Session 生命周期与受控 vision/provider，覆盖 accepted、vision、intent 期间撤权，send / steer 两个边界拒绝，取消 / 拆离 / 实际旧 turn 完成后新 turn 的隔离，origin / generation 清理，错误后的合法输入，hook 不进入 vendor options，意图保留，无 hook 的旧行为及最终同步 dispatch 边界。无真实模型、账号、数据库或文件读取；这些测试不证明材料 ACL 查询、main 身份、网络或 provider 接收。

实跑结果与日志位于 `artifacts/material-consumption-guard/`：

- `pnpm exec vitest run src/session.input-consumption.test.ts`：15/15，885ms（用例 20ms）。
- `pnpm exec vitest run src/session.input-consumption.test.ts src/session.vision-bridge.test.ts src/session.origin.test.ts`：113/113，4.95s；包括已有视觉降级及来源生命周期回归。
- `pnpm --filter @cindy/maker-core build`：`tsc --noEmit` 通过。
- `pnpm check:dev-docs`：10/10；`pnpm check:test-hygiene`：PASS（355 files within baseline）；`git diff --check`：通过。

maker-core 行为自查：本片没有更改 system/user prompt、tool 集合、模型路由或用量逻辑；受控测试验证意图不变与来源事件 generation。新增等待只发生在宿主显式提供 hook 时，每次发送最多两个阶段校验；真实首 token 延迟、prompt cache 命中率、token 用量及模型行为未实测，不以单测耗时替代这些指标。无 hook 的顺序/次数已回归验证。

最终 manifest 记录三个产物 hash、原文件 hash、patch hash 与门禁结果。作者自查不等于独立验收。未提交、推送、合并，未触碰真实用户数据或发送模型消息。
