import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { executionStoreContract } from "../src/execution-store-contract.js";
import { InMemoryExecutionStore } from "../src/in-memory-store.js";

/**
 * 将框架无关的 ExecutionStorePort 契约套件跑在内存实现上。
 *
 * 生产 SQLite 实现在宿主包以同一套件运行（`@aervox/core/test-contract`），
 * 两边共用同一份用例，避免"换 store 等于换行为"。
 */
describe("InMemoryExecutionStore 契约", () => {
  for (const contractCase of executionStoreContract()) {
    it(contractCase.name, async () => {
      const store = new InMemoryExecutionStore();
      await contractCase.run(store, {
        assert: {
          equal(actual, expected, message) {
            expect(actual, message).toBe(expected);
          },
          ok(value, message) {
            expect(value, message).toBeTruthy();
          },
        },
        async seedAttempt({ turnId, attemptId, status }) {
          store.seedAttempt({ id: attemptId, turnId, status });
        },
        async attemptStatus({ attemptId }) {
          return store.attemptStatus(attemptId);
        },
      });
    });
  }
});

/**
 * 套件自身的覆盖自检。
 *
 * 这条测试存在的理由：契约套件曾长期只覆盖 12/18 个方法，而没有任何东西会提示
 * 这个缺口——它是我人工逐条核对才发现的。给 `ExecutionStorePort` 新增方法时，
 * 这里会立刻失败，提醒补一条用例。
 */
describe("契约套件覆盖自检", () => {
  it("ExecutionStorePort 的每个方法都被至少一条用例调用", () => {
    const portsSource = readFileSync(new URL("../src/ports.ts", import.meta.url), "utf8");
    const start = portsSource.indexOf("export interface ExecutionStorePort");
    const end = portsSource.indexOf("export type SessionLedgerPort");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const methods = [...portsSource.slice(start, end).matchAll(/^ {2}([a-zA-Z]+)\??\(/gm)].map(m => m[1]!);
    expect(methods.length).toBeGreaterThan(0);

    const suiteSource = readFileSync(new URL("../src/execution-store-contract.ts", import.meta.url), "utf8");
    const exercised = new Set([...suiteSource.matchAll(/store\.([a-zA-Z]+)/g)].map(m => m[1]!));

    const uncovered = methods.filter(method => !exercised.has(method));
    expect(uncovered, `未覆盖的 ExecutionStorePort 方法: ${uncovered.join(", ")}`).toEqual([]);
  });
});
