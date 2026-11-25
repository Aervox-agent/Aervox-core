import { describe, expect, it } from "vitest";
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
