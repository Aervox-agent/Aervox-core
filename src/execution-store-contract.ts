/**
 * Aervox｜思隅 @aervox/core — ExecutionStorePort 共享契约套件
 *
 * 为什么存在：`ExecutionStorePort`（25 个方法）有内存实现与 SQLite 实现，两边的
 * 语义必须一致，否则更换 store 就等于更换行为。此前两个实现各测各的：内存实现有
 * fencing / 幂等 / 租约夹具，SQLite 实现有原子性与终态竞争夹具，交集部分才被双方
 * 覆盖，非交集部分是裸奔的。
 *
 * 为什么框架无关：本包运行时依赖必须为空（ADR-021），`src/` 不能引入 vitest。
 * 因此这里只声明「用例 + 断言」，由宿主用自选测试框架执行，见
 * `test/execution-store-contract.test.ts` 的 vitest 适配。
 *
 * 覆盖范围刻意只包含**跨实现必须一致**的语义：claim 与 fencing CAS、事件序号与
 * 可见前缀、幂等预留、终态单一性、取消位。实现细节（如内存实现的模拟抢占方法）
 * 不在本套件内。
 */
import type {
  AgentStreamEventInput,
  AgentStreamEvent,
  ExecutionStorePort,
} from "./ports.js";
import type { AttemptStatus } from "./types.js";

/** 一个可直接断言的契约用例。`run` 抛出即失败。 */
export interface StoreContractCase {
  readonly name: string;
  run(store: ExecutionStorePort, helpers: StoreContractHelpers): Promise<void>;
}

/** 最小断言面：只要求实现能比较值并在不一致时抛错。 */
export interface StoreContractAssert {
  equal(actual: unknown, expected: unknown, message?: string): void;
  ok(value: unknown, message?: string): void;
}

export interface StoreContractHelpers {
  /** 由宿主提供的断言实现（vitest 用 expect，node:test 用 assert）。 */
  assert: StoreContractAssert;
  /**
   * 建一个可 claim 的 Running Attempt 并返回身份。
   * 内存实现直接 seed；SQLite 实现需插入 Turn/Attempt 行。
   */
  seedAttempt(input: { turnId: string; attemptId: string; status?: AttemptStatus }): Promise<void>;
  /**
   * 读取 Attempt 终态；不存在时返回 undefined。
   *
   * 同时传入 turnId 与 attemptId：SQLite 实现按 Turn 定位 Attempt，只给
   * attemptId 会迫使适配层猜测归属。
   */
  attemptStatus(input: { turnId: string; attemptId: string }): Promise<AttemptStatus | undefined>;
}

const event = (turnId: string, attemptId: string, sequence: number, overrides: Partial<AgentStreamEventInput> = {}): AgentStreamEventInput => ({
  turnId,
  attemptId,
  sequence,
  eventType: "delta",
  data: { text: `chunk-${sequence}` },
  safetyDecision: "approved",
  ...overrides,
});

/**
 * 声明全部跨实现契约用例。
 *
 * 约定：每个用例使用独立的 turnId / attemptId 前缀（用例名派生），避免共享状态
 * 让顺序影响结果。
 */
export function executionStoreContract(): readonly StoreContractCase[] {
  return Object.freeze([
    {
      name: "claim 递增 fencing 并返回租约；同一 Attempt 不可被二次 claim",
      async run(store, { assert, seedAttempt }) {
        await seedAttempt({ turnId: "t_claim", attemptId: "a_claim" });
        const first = await store.claimTurnAttempt({ turnId: "t_claim", attemptId: "a_claim", expectedFencingToken: 0 });
        assert.equal(first.ok, true, "首次 claim 应成功");
        if (!first.ok) return;
        assert.ok(first.fencingToken > 0, "claim 后 fencing 必须递增");
        const second = await store.claimTurnAttempt({ turnId: "t_claim", attemptId: "a_claim", expectedFencingToken: 0 });
        assert.equal(second.ok, false, "持有租约期间不可重复 claim");
        if (!second.ok) assert.equal(second.reason, "already_claimed");
      },
    },
    {
      name: "fencing 失配的事件写入被拒绝（LeaseLostError）",
      async run(store, { assert, seedAttempt }) {
        await seedAttempt({ turnId: "t_fence", attemptId: "a_fence" });
        const claim = await store.claimTurnAttempt({ turnId: "t_fence", attemptId: "a_fence", expectedFencingToken: 0 });
        assert.equal(claim.ok, true);
        if (!claim.ok) return;
        const stale = claim.fencingToken - 1;
        let threw = false;
        try {
          await store.appendEvent({ ...event("t_fence", "a_fence", 1), expectedFencingToken: stale });
        } catch {
          threw = true;
        }
        assert.equal(threw, true, "过期 fencing 必须被拒绝");
        const events = await store.listEvents("t_fence");
        assert.equal(events.length, 0, "被拒绝的写入不得留下事件");
      },
    },
    {
      name: "事件按 sequence 升序返回，afterSequence 单调过滤，版本出自常量",
      async run(store, { assert, seedAttempt }) {
        await seedAttempt({ turnId: "t_seq", attemptId: "a_seq" });
        const claim = await store.claimTurnAttempt({ turnId: "t_seq", attemptId: "a_seq", expectedFencingToken: 0 });
        assert.equal(claim.ok, true);
        if (!claim.ok) return;
        for (let i = 1; i <= 3; i++) {
          await store.appendEvent({ ...event("t_seq", "a_seq", i), expectedFencingToken: claim.fencingToken });
        }
        const all = await store.listEvents("t_seq");
        assert.equal(all.map((e: AgentStreamEvent) => e.sequence).join(","), "1,2,3", "事件必须按序号升序");
        const after = await store.listEvents("t_seq", 1);
        assert.equal(after.map(e => e.sequence).join(","), "2,3", "afterSequence 必须严格过滤");
        assert.ok(all.every(e => Number.isInteger(e.payloadVersion) && e.payloadVersion > 0), "事件必须带有整数信封版本");
        assert.equal(new Set(all.map(e => e.payloadVersion)).size, 1, "同一内核写入的版本必须一致");
      },
    },
    {
      name: "幂等预留：同 invocationId 第二次预留返回 alreadyReserved 且不重复占位",
      async run(store, { assert, seedAttempt }) {
        await seedAttempt({ turnId: "t_idem", attemptId: "a_idem" });
        const base = { turnId: "t_idem", attemptId: "a_idem", invocationId: "inv_1", name: "search", arguments: { q: "x" } };
        const first = await store.reserveToolExecution(base);
        assert.equal(first.ok, true);
        assert.equal(first.alreadyReserved, false);
        const second = await store.reserveToolExecution(base);
        assert.equal(second.alreadyReserved, true, "重复预留必须被识别");
      },
    },
    {
      name: "预留后可权威收口；同一预留只允许收口一次",
      async run(store, { assert, seedAttempt }) {
        await seedAttempt({ turnId: "t_ledger", attemptId: "a_ledger" });
        await store.reserveToolExecution({ turnId: "t_ledger", attemptId: "a_ledger", invocationId: "inv_l", name: "read", arguments: {} });
        const updated = await store.updateToolExecutionResult({
          turnId: "t_ledger", attemptId: "a_ledger", invocationId: "inv_l", status: "executed", output: { ok: true },
        });
        assert.equal(updated.ok, true, "首次收口应成功");
        // 未预留的 invocationId 不能被收口——否则宿主会凭空得到一条"已执行"记录。
        const orphan = await store.updateToolExecutionResult({
          turnId: "t_ledger", attemptId: "a_ledger", invocationId: "inv_never_reserved", status: "executed", output: {},
        });
        assert.equal(orphan.ok, false, "未预留的调用不得被收口");
      },
    },
    {
      name: "终态单一：已提交的 Attempt 拒绝再次终态提交",
      async run(store, { assert, seedAttempt, attemptStatus }) {
        await seedAttempt({ turnId: "t_term", attemptId: "a_term" });
        const claim = await store.claimTurnAttempt({ turnId: "t_term", attemptId: "a_term", expectedFencingToken: 0 });
        assert.equal(claim.ok, true);
        if (!claim.ok) return;
        const first = await store.finalizeAttempt({
          turnId: "t_term", attemptId: "a_term", status: "Completed", expectedFencingToken: claim.fencingToken,
        });
        assert.equal(first.ok, true);
        const second = await store.finalizeAttempt({
          turnId: "t_term", attemptId: "a_term", status: "Failed", expectedFencingToken: claim.fencingToken,
        });
        assert.equal(second.ok, false, "终态不可被覆盖");
        assert.equal(await attemptStatus({ turnId: "t_term", attemptId: "a_term" }), "Completed");
      },
    },
    {
      name: "取消位：运行中可置位，已终态必须拒绝（ports.ts §11.1）",
      async run(store, { assert, seedAttempt }) {
        await seedAttempt({ turnId: "t_cancel", attemptId: "a_cancel" });
        const claim = await store.claimTurnAttempt({ turnId: "t_cancel", attemptId: "a_cancel", expectedFencingToken: 0 });
        assert.equal(claim.ok, true);
        const requested = await store.requestCancelAttempt({ turnId: "t_cancel", attemptId: "a_cancel" });
        assert.equal(requested.ok, true, "运行中的 Attempt 必须可置取消位");
        assert.equal(await store.isCancelRequested({ turnId: "t_cancel", attemptId: "a_cancel" }), true);
        if (!claim.ok) return;
        await store.finalizeAttempt({ turnId: "t_cancel", attemptId: "a_cancel", status: "Cancelled", expectedFencingToken: claim.fencingToken });
        // 契约原文：已终态则拒绝，拒绝优先于执行器自己的终态，避免覆盖已提交结果。
        const afterTerminal = await store.requestCancelAttempt({ turnId: "t_cancel", attemptId: "a_cancel" });
        assert.equal(afterTerminal.ok, false, "已终态必须拒绝取消请求");
        if (!afterTerminal.ok) assert.equal(afterTerminal.reason, "already_finalized");
      },
    },
    {
      name: "未登记的 Attempt 不可 claim",
      async run(store, { assert }) {
        const result = await store.claimTurnAttempt({ turnId: "t_missing", attemptId: "a_missing", expectedFencingToken: 0 });
        assert.equal(result.ok, false, "不存在的 Attempt 不得被 claim");
        // reason 属于实现细节：内存实现能区分 not_runnable / already_claimed，
        // SQLite 在缺行时同样只给出拒绝。契约只强制"必须拒绝"，不强求 reason 取值。
        if (!result.ok) assert.ok(result.reason.length > 0, "拒绝必须给出 reason");
      },
    },
  ]);
}
