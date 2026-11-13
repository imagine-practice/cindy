import type { Config } from 'drizzle-kit';

/**
 * chat-data-localization F1：drizzle-kit 配置。
 *
 * - schema 入口：`src/main/localDb/schema.ts`
 * - 输出目录：`migration-development/custom/`（完整组合基线，仅开发生成输入，不随包执行）
 * - dialect：sqlite（main 进程独占 better-sqlite3）
 *
 * canonical 生成：`pnpm db:generate -- --namespace=custom --name=<name>`；校验：`pnpm db:validate`
 */
export default {
  schema: './src/main/localDb/schema.ts',
  // Full combined schema must never generate into the immutable upstream chain.
  // The canonical db:generate wrapper also validates the catalog baseline binding.
  out: './migration-development/custom',
  dialect: 'sqlite',
} satisfies Config;
