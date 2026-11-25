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
 * 版本、可见前缀读写、批次 all-or-none、幂等预留与收口、终态单一性、终态与收尾
 * 事件原子提交、取消位。实现细节（如内存实现的模拟抢占方法）不在本套件内。
 *
 * 本套件已发现两处真实分歧，均以契约为准修正：
 * 1. SQLite 对已 Cancelled 的 Attempt 请求取消失败返回成功（违反 ports.ts §11.1）；
 * 2. 内存实现从未实现 `listCommittedSegments`，读取方会拿到空列表并静默丢失已提交正文。
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
    {
      name: "安全片段写入后可从可见前缀读回（listCommittedSegments）",
      async run(store, { assert, seedAttempt }) {
        await seedAttempt({ turnId: "t_seg", attemptId: "a_seg" });
        const claim = await store.claimTurnAttempt({ turnId: "t_seg", attemptId: "a_seg", expectedFencingToken: 0 });
        assert.equal(claim.ok, true);
        if (!claim.ok) return;
        for (const sequence of [1, 2]) {
          await store.recordSafeSegment({
            turnId: "t_seg",
            attemptId: "a_seg",
            sequence,
            text: `片段${sequence}`,
            eventData: { text: `片段${sequence}`, isFinal: false },
            safetyDecision: "approved",
            expectedFencingToken: claim.fencingToken,
          });
        }
        // ports.ts：可见前缀必须可读回，且按 sequence 升序。宿主未实现该方法时
        // 读取方看到空列表，会静默丢失已提交正文——这是必须一致的核心语义。
        assert.ok(typeof store.listCommittedSegments === "function", "必须实现 listCommittedSegments（ports.ts E2）");
        if (typeof store.listCommittedSegments !== "function") return;
        const segments = await store.listCommittedSegments("t_seg");
        assert.equal(segments.length, 2, "两条安全片段都必须可读回");
        assert.equal(segments.map(s => s.sequence).join(","), "1,2", "可见前缀必须按 sequence 升序");
        assert.equal(segments.map(s => s.text).join(","), "片段1,片段2", "读回的正文必须与写入一致");
      },
    },
    {
      name: "批次内 fencing 失配时整批拒绝，不留半份正文",
      async run(store, { assert, seedAttempt }) {
        await seedAttempt({ turnId: "t_batch", attemptId: "a_batch" });
        const claim = await store.claimTurnAttempt({ turnId: "t_batch", attemptId: "a_batch", expectedFencingToken: 0 });
        assert.equal(claim.ok, true);
        if (!claim.ok) return;
        const stale = claim.fencingToken - 1;
        let threw = false;
        try {
          await store.recordSafeSegments?.([
            { turnId: "t_batch", attemptId: "a_batch", sequence: 1, text: "a", eventData: { text: "a" }, safetyDecision: "approved", expectedFencingToken: stale },
            { turnId: "t_batch", attemptId: "a_batch", sequence: 2, text: "b", eventData: { text: "b" }, safetyDecision: "approved", expectedFencingToken: stale },
          ]);
        } catch {
          threw = true;
        }
        assert.equal(threw, true, "过期 fencing 的批次必须被拒绝");
        // all-or-none：拒绝后不得留下任何片段或事件。
        const events = await store.listEvents("t_batch");
        assert.equal(events.length, 0, "被拒绝的批次不得留下事件");
        if (typeof store.listCommittedSegments === "function") {
          const segments = await store.listCommittedSegments("t_batch");
          assert.equal(segments.length, 0, "被拒绝的批次不得留下可见片段");
        }
      },
    },
    {
      name: "终态与收尾事件原子提交（finalizeAttemptWithEvent）",
      async run(store, { assert, seedAttempt, attemptStatus }) {
        await seedAttempt({ turnId: "t_atomic", attemptId: "a_atomic" });
        const claim = await store.claimTurnAttempt({ turnId: "t_atomic", attemptId: "a_atomic", expectedFencingToken: 0 });
        assert.equal(claim.ok, true);
        if (!claim.ok) return;
        const committed = await store.finalizeAttemptWithEvent({
          turnId: "t_atomic",
          attemptId: "a_atomic",
          status: "Completed",
          expectedFencingToken: claim.fencingToken,
          sequence: 1,
          eventType: "done",
          eventData: { status: "Completed", isComplete: true },
          safetyDecision: "approved",
        });
        assert.equal(committed.ok, true, "终态与 done 事件必须一次提交成功");
        // 终态与事件不能拆散：提交后两者必须同时可见。
        assert.equal(await attemptStatus({ turnId: "t_atomic", attemptId: "a_atomic" }), "Completed");
        const events = await store.listEvents("t_atomic");
        assert.equal(events.length, 1, "done 事件必须与终态一同落地");
        assert.equal(events[0]!.eventType, "done");
      },
    },
    {
      name: "续租：仅持有匹配的 leaseId 与 fencing 时可续，且不改变 fencing",
      async run(store, { assert, seedAttempt }) {
        await seedAttempt({ turnId: "t_renew", attemptId: "a_renew" });
        const claim = await store.claimTurnAttempt({ turnId: "t_renew", attemptId: "a_renew", expectedFencingToken: 0 });
        assert.equal(claim.ok, true);
        if (!claim.ok || !claim.leaseId) { assert.ok(claim.ok && claim.leaseId, "claim 必须返回 leaseId 才能续租"); return; }
        const renewed = await store.renewAttemptLease({
          attemptId: "a_renew",
          leaseId: claim.leaseId,
          expectedFencingToken: claim.fencingToken,
        });
        assert.equal(renewed.ok, true, "持有正确租约时必须可续租");
        // 续租不得递增 fencing：否则执行中的写会全部变成"过期"。
        const stillValid = await store.appendEvent({
          ...event("t_renew", "a_renew", 1),
          expectedFencingToken: claim.fencingToken,
        });
        assert.ok(stillValid, "续租后原 fencing 仍然有效");
        // 错误的 leaseId 必须被拒绝。
        const wrongLease = await store.renewAttemptLease({
          attemptId: "a_renew",
          leaseId: "not-the-lease",
          expectedFencingToken: claim.fencingToken,
        });
        assert.equal(wrongLease.ok, false, "错误 leaseId 不得续租");
      },
    },
    {
      name: "nextSequence 随事件写入单调递增，不与已用序号冲突",
      async run(store, { assert, seedAttempt }) {
        await seedAttempt({ turnId: "t_next", attemptId: "a_next" });
        const claim = await store.claimTurnAttempt({ turnId: "t_next", attemptId: "a_next", expectedFencingToken: 0 });
        assert.equal(claim.ok, true);
        if (!claim.ok) return;
        const first = await store.nextSequence("t_next");
        assert.ok(first >= 1, "首个序号必须从 1 起");
        await store.appendEvent({ ...event("t_next", "a_next", first), expectedFencingToken: claim.fencingToken });
        const second = await store.nextSequence("t_next");
        assert.ok(second > first, "写入后下一个序号必须更大");
        // 复用已占用的序号会让恢复与去重失去依据。
        let conflicted = false;
        try {
          await store.appendEvent({ ...event("t_next", "a_next", first), expectedFencingToken: claim.fencingToken });
        } catch {
          conflicted = true;
        }
        assert.equal(conflicted, true, "重复序号必须被拒绝");
      },
    },
    {
      name: "recordToolOutcome：账本收口与事件原子写入，fencing 失配时两者都不留",
      async run(store, { assert, seedAttempt }) {
        await seedAttempt({ turnId: "t_outcome", attemptId: "a_outcome" });
        const claim = await store.claimTurnAttempt({ turnId: "t_outcome", attemptId: "a_outcome", expectedFencingToken: 0 });
        assert.equal(claim.ok, true);
        if (!claim.ok) return;
        await store.reserveToolExecution({
          turnId: "t_outcome", attemptId: "a_outcome", invocationId: "inv_o", name: "read", arguments: {},
        });
        const committed = await store.recordToolOutcome({
          turnId: "t_outcome",
          attemptId: "a_outcome",
          sequence: 1,
          invocationId: "inv_o",
          name: "read",
          arguments: {},
          status: "executed",
          output: { ok: true },
          startedAt: new Date(0).toISOString(),
          eventData: { name: "read", ok: true },
          safetyDecision: "approved",
          expectedFencingToken: claim.fencingToken,
        });
        assert.equal(committed.ok, true, "权威结果应收口成功");
        const events = await store.listEvents("t_outcome");
        assert.equal(events.length, 1, "账本收口必须同时产生一条事件");
        assert.equal(events[0]!.eventType, "tool_result");

        // fencing 失配：账本与事件都必须保持原样（不得只写一半）。
        const stale = claim.fencingToken - 1;
        let threw = false;
        try {
          await store.recordToolOutcome({
            turnId: "t_outcome",
            attemptId: "a_outcome",
            sequence: 2,
            invocationId: "inv_stale",
            name: "read",
            arguments: {},
            status: "executed",
            output: {},
            startedAt: new Date(0).toISOString(),
            eventData: {},
            safetyDecision: "approved",
            expectedFencingToken: stale,
          });
        } catch {
          threw = true;
        }
        assert.equal(threw, true, "过期 fencing 的收口必须抛错");
        const after = await store.listEvents("t_outcome");
        assert.equal(after.length, 1, "失败的收口不得追加事件");
      },
    },
    {
      name: "recordToolExecution 与观测写入不要求可执行 Attempt（诊断旁路）",
      async run(store, { assert, seedAttempt }) {
        await seedAttempt({ turnId: "t_diag", attemptId: "a_diag" });
        // 可观测副作用（ModelRun / ContextManifest / 工具执行证据）允许在执行已
        // 结束时写入：它们不改变控制流，宿主缺省也可为 no-op。契约要求"不抛错"。
        const at = new Date(0).toISOString();
        await store.recordToolExecution({
          turnId: "t_diag",
          attemptId: "a_diag",
          invocationId: "inv_diag",
          name: "read",
          arguments: {},
          status: "executed",
          startedAt: at,
          finishedAt: at,
        });
        await store.recordModelRun({
          runId: "run_diag",
          turnId: "t_diag",
          sessionId: "s_diag",
          attemptId: "a_diag",
          stepId: 1,
          provider: "test",
          modelId: "test",
          purpose: "diagnostic",
          status: "completed",
        });
        await store.recordContextManifest({
          manifestId: "man_diag",
          turnId: "t_diag",
          sessionId: "s_diag",
          attemptId: "a_diag",
          stepId: 1,
          modelRunId: "run_diag",
          purpose: "diagnostic",
          snapshot: [],
        });
        // 只要不抛错即满足契约；具体落地形式由宿主决定。
        assert.ok(true, "观测性写入不应要求可执行 Attempt");
      },
    },
  ]);
}
