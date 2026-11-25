/**
 * Aervox｜思隅 @aervox/core — InboxPort 共享契约套件
 *
 * 与 `execution-store-contract.ts` 同一动机：`InboxPort` 有两份独立实现——内核的
 * `InMemoryInbox` 与生产仓储 `SqliteAgentInboxRepository`——它们的 claim/ack 语义
 * 必须一致，否则「崩溃后安全重放」这个承诺只在其中一边成立。
 *
 * 框架无关（ADR-021：`src/` 不能引入 vitest）。用例只声明「做什么 + 断言什么」，
 * 宿主用自选框架执行，见 `test/inbox-contract.test.ts` 的 vitest 适配。
 *
 * 本套件编写时即发现一处真实分歧：内存实现的 `ack` 接受 `pending` 状态，而契约
 * 与生产仓储都只接受 `claimed`。允许 ack 未经 claim 的项会让消费方跳过 claim
 * 直接吞掉待消费项，崩溃重放语义随之失效。
 */
import type { AgentInboxCommand, AgentInboxItem, InboxPort } from "./ports.js";
import type { StoreContractAssert } from "./execution-store-contract.js";

/** 一个可直接断言的契约用例。`run` 抛出即失败。 */
export interface InboxContractCase {
  readonly name: string;
  run(inbox: InboxPort, helpers: InboxContractHelpers): Promise<void>;
}

export interface InboxContractHelpers {
  assert: StoreContractAssert;
}

/**
 * 默认用 `followup`：它推导出的 consumeBoundary 是 `next-turn`，与多数用例的
 * claim 边界一致。`steer`/`inject` 推导 `next-step`，需要显式 override 并带
 * attemptId——用错会让 claim 拿不到项，掩盖真正的语义分歧。
 */
const command = (overrides: Partial<AgentInboxCommand> = {}): AgentInboxCommand => ({
  idempotencyKey: "idem_default",
  sessionId: "s_inbox",
  type: "followup",
  sourceActor: "user",
  payload: { text: "hello" },
  ...overrides,
});

/** 声明全部跨实现必须一致的 InboxPort 语义。 */
export function inboxContract(): readonly InboxContractCase[] {
  return Object.freeze([
    {
      name: "enqueue 幂等：同一 idempotencyKey 重复提交返回同一项",
      async run(inbox, { assert }) {
        const cmd = command({ idempotencyKey: "idem_dup", sessionId: "s_idem" });
        const first = await inbox.enqueue(cmd);
        const second = await inbox.enqueue(cmd);
        assert.equal(second.id, first.id, "重复提交必须返回既有项，不得新建");
        assert.equal(second.status, "pending", "既有项状态不得被重复提交改变");
      },
    },
    {
      name: "不同 idempotencyKey 生成不同项",
      async run(inbox, { assert }) {
        const a = await inbox.enqueue(command({ idempotencyKey: "idem_a", sessionId: "s_distinct" }));
        const b = await inbox.enqueue(command({ idempotencyKey: "idem_b", sessionId: "s_distinct" }));
        assert.ok(a.id !== b.id, "不同幂等键必须是不同项");
      },
    },
    {
      name: "claim 只返回 pending 项，且按 orderingSeq 升序",
      async run(inbox, { assert }) {
        const sessionId = "s_claim";
        const first = await inbox.enqueue(command({ idempotencyKey: "idem_c1", sessionId }));
        const second = await inbox.enqueue(command({ idempotencyKey: "idem_c2", sessionId }));
        const claimed = await inbox.claimForConsumption({ sessionId, type: "next-turn" });
        assert.equal(claimed.length, 2, "两条待消费项都应被 claim");
        // 顺序由 orderingSeq 决定；不断言 id 的字面顺序，避免绑定 id 生成格式。
        const seqs = claimed.map(i => i.orderingSeq);
        const sorted = [...seqs].sort((a, b) => a - b);
        assert.equal(seqs.join(","), sorted.join(","), "claim 结果必须按 orderingSeq 升序");
        assert.ok(claimed.every(i => i.status === "claimed"), "claim 后状态必须是 claimed");
      },
    },
    {
      name: "已 claim 未 ack 的项不会被重复返回（崩溃安全重放）",
      async run(inbox, { assert }) {
        const sessionId = "s_replay";
        await inbox.enqueue(command({ idempotencyKey: "idem_r1", sessionId }));
        const firstClaim = await inbox.claimForConsumption({ sessionId, type: "next-turn" });
        assert.equal(firstClaim.length, 1, "首次应 claim 到一条");
        const secondClaim = await inbox.claimForConsumption({ sessionId, type: "next-turn" });
        assert.equal(secondClaim.length, 0, "已 claim 未 ack 的项不得重复返回");
      },
    },
    {
      name: "ack 后项不再被 claim",
      async run(inbox, { assert }) {
        const sessionId = "s_ack";
        await inbox.enqueue(command({ idempotencyKey: "idem_ack", sessionId }));
        const claimed = await inbox.claimForConsumption({ sessionId, type: "next-turn" });
        assert.equal(claimed.length, 1);
        await inbox.ack({ itemIds: [claimed[0]!.id] });
        const after = await inbox.claimForConsumption({ sessionId, type: "next-turn" });
        assert.equal(after.length, 0, "acknowledged 项不得再被 claim");
      },
    },
    {
      name: "ack 只接受此前 claim 的项（pending 不得被直接 ack）",
      async run(inbox, { assert }) {
        const sessionId = "s_ack_gate";
        const pending = await inbox.enqueue(command({ idempotencyKey: "idem_gate", sessionId }));
        // 未经 claim 直接 ack 必须无效：否则消费方可以跳过 claim 吞掉待消费项，
        // 崩溃重放语义随之失效。契约原文：「只接受此前 claim 的项」。
        await inbox.ack({ itemIds: [pending.id] });
        const claimed = await inbox.claimForConsumption({ sessionId, type: "next-turn" });
        assert.equal(claimed.length, 1, "被误 ack 的 pending 项仍应可被正常 claim");
        if (claimed[0]) {
          assert.equal(claimed[0].status, "claimed", "该项状态必须是 claimed 而非 acknowledged");
        }
      },
    },
    {
      name: "next-step 按 attemptId 过滤；next-turn 忽略 attemptId",
      async run(inbox, { assert }) {
        const sessionId = "s_boundary";
        await inbox.enqueue(command({ idempotencyKey: "idem_s1", sessionId, type: "steer", attemptId: "a1", consumeBoundary: "next-step" }));
        await inbox.enqueue(command({ idempotencyKey: "idem_s2", sessionId, type: "steer", attemptId: "a2", consumeBoundary: "next-step" }));
        const forA1 = await inbox.claimForConsumption({ sessionId, attemptId: "a1", type: "next-step" });
        assert.equal(forA1.length, 1, "next-step 只能拿到本 attempt 的项");
        assert.equal(forA1[0]!.attemptId, "a1");
        const forTurn = await inbox.claimForConsumption({ sessionId, type: "next-turn" });
        assert.equal(forTurn.length, 0, "next-turn 不得拿到属于 next-step 的项");
      },
    },
    {
      name: "limit 限制单次 claim 数量",
      async run(inbox, { assert }) {
        const sessionId = "s_limit";
        for (let i = 0; i < 3; i++) {
          await inbox.enqueue(command({ idempotencyKey: `idem_l${i}`, sessionId }));
        }
        const claimed = await inbox.claimForConsumption({ sessionId, type: "next-turn", limit: 2 });
        assert.equal(claimed.length, 2, "limit 必须生效");
      },
    },
    {
      name: "已过期的项不被 claim（expiresAt 由调用方给定，无需推进时钟）",
      async run(inbox, { assert }) {
        const sessionId = "s_expiry";
        // 过期时间由 enqueue 调用方提供，因此可以直接用一个已过去的时间戳断言，
        // 不需要让测试真的等待——先前误以为该语义"无法公平断言"是错的。
        await inbox.enqueue(command({
          idempotencyKey: "idem_expired",
          sessionId,
          expiresAt: new Date(Date.now() - 60_000).toISOString(),
        }));
        await inbox.enqueue(command({ idempotencyKey: "idem_live", sessionId }));
        const claimed = await inbox.claimForConsumption({ sessionId, type: "next-turn" });
        assert.equal(claimed.length, 1, "只有未过期项可被 claim");
        assert.equal(claimed[0]!.idempotencyKey, "idem_live", "被 claim 的必须是未过期的那条");
      },
    },
    {
      name: "跨会话隔离：claim 不返回其他 session 的项",
      async run(inbox, { assert }) {
        await inbox.enqueue(command({ idempotencyKey: "idem_iso_a", sessionId: "s_iso_a" }));
        await inbox.enqueue(command({ idempotencyKey: "idem_iso_b", sessionId: "s_iso_b" }));
        const claimed = await inbox.claimForConsumption({ sessionId: "s_iso_a", type: "next-turn" });
        assert.equal(claimed.length, 1, "只应拿到本会话的项");
        assert.equal(claimed[0]!.sessionId, "s_iso_a");
      },
    },
  ]);
}

/** 便于宿主适配：把任意实现包装成断言接口的最小要求。 */
export type InboxItemShape = Pick<AgentInboxItem, "id" | "status" | "sessionId" | "orderingSeq">;
