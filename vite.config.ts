import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { host: '127.0.0.1', port: 4177, strictPort: true },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true },
  test: {
    environment: 'jsdom',
    setupFiles: './tests/setup.ts',
    css: true,
    include: ['src/**/*.test.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'lcov'],
      reportsDirectory: 'coverage',
      // 只统计真正承载业务逻辑的前端代码：类型声明、入口和纯展示常量没有可执行分支，
      // 把它们算进来只会稀释覆盖率数字。
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.{ts,tsx}', 'src/**/__tests__/**', 'src/types.ts', 'src/main.tsx', 'src/vite-env.d.ts'],
      // 阈值是“不许回退”的地板（ratchet），按 2026-10-12 实测值向下取整设定，
      // 不是粉饰性的目标值。实测覆盖率偏低的原因是真实的：src/pages 与 src/components
      // 目前没有单元测试（它们由 Playwright E2E 覆盖），只有 services/state/utils 有单测。
      // 这里刻意保留完整的 src/** 分母，不用 exclude 把未覆盖的 UI 藏起来。
      // 提高覆盖率时请同步上调这些数字。
      thresholds: {
        lines: 11,
        functions: 8,
        statements: 9,
        branches: 8,
      },
    },
  },
});
