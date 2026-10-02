/**
 * vitest 配置。
 *
 * 显式声明 include，避免默认的 `**\/*.test.*` 把仓库里任何同名文件都当成用例
 * （例如本地遗留的备份目录、依赖包自带的测试）。
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.js"],
    environment: "node"
  }
});
