import { describe, expect, it } from "vitest";
import {
  EVENT_PAYLOAD_VERSION,
  SUPPORTED_EVENT_PAYLOAD_VERSIONS,
  InMemoryExecutionStore,
  isSupportedEventPayloadVersion,
} from "../src/index.js";

/**
 * 事件信封版本（STREAMING_PROTOCOL §4/§5）。
 *
 * 这些断言存在的理由：`payloadVersion` 曾经是一个恒为字面量 `1`、且没有任何
 * 读取方校验的字段。文档要求「未知版本停止渲染并请求兼容降级」，但两侧都没有
 * 实现。此处锁定写侧出自常量、读侧对未知值 fail-closed。
 */
describe("event payload version", () => {
  it("declares one current version and admits it", () => {
    expect(EVENT_PAYLOAD_VERSION).toBe(1);
    expect(SUPPORTED_EVENT_PAYLOAD_VERSIONS).toContain(EVENT_PAYLOAD_VERSION);
    expect(isSupportedEventPayloadVersion(EVENT_PAYLOAD_VERSION)).toBe(true);
  });

  it("freezes the supported set so a reader cannot widen it at runtime", () => {
    expect(Object.isFrozen(SUPPORTED_EVENT_PAYLOAD_VERSIONS)).toBe(true);
  });

  it("rejects unknown, non-integer and non-positive versions", () => {
    for (const version of [0, -1, 2, 99, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(isSupportedEventPayloadVersion(version), `version ${String(version)}`).toBe(false);
    }
    for (const version of [undefined, null, "1", {}, [] as unknown[]]) {
      expect(isSupportedEventPayloadVersion(version), `version ${String(version)}`).toBe(false);
    }
  });

  it("stamps persisted events with the declared version instead of a literal", async () => {
    const store = new InMemoryExecutionStore();
    store.seedAttempt({ id: "atp_v", turnId: "turn_v" });
    await store.appendEvent({
      turnId: "turn_v",
      attemptId: "atp_v",
      sequence: 1,
      eventType: "delta",
      data: { text: "x" },
      safetyDecision: "approved",
      expectedFencingToken: 0,
    });
    const [event] = await store.listEvents("turn_v");
    expect(event!.payloadVersion).toBe(EVENT_PAYLOAD_VERSION);
    // A stored event must be readable by the same kernel that wrote it; if this
    // ever fails, the write side and the supported set have drifted apart.
    expect(isSupportedEventPayloadVersion(event!.payloadVersion)).toBe(true);
  });

  /**
   * 升版流程演练（STREAMING_PROTOCOL §8.1）。
   *
   * 文档规定了「提升版本 + 保留上一版本兼容窗口」的做法，但当前只有版本 1，
   * 这条路径从未被真实执行过。以下用等价于升版后的形态验证判定函数的语义：
   * 新版本必须被接受、仍在窗口内的旧版本必须被接受、窗口外版本必须被拒绝。
   *
   * 这里不修改导出的常量（会被 Object.isFrozen 拒绝，且常量是模块级单例），
   * 而是直接验证「受支持集合」的判定逻辑对多版本输入的行为，确保升版时
   * 只需要改集合内容，不需要改判定函数。
   */
  describe("升版流程", () => {
    /** 与 isSupportedEventPayloadVersion 同构的判定，接收显式集合。 */
    const accepts = (version: unknown, supported: readonly number[]): boolean =>
      typeof version === "number" && Number.isInteger(version) && version > 0 && supported.includes(version);

    it("提升到 v2 且保留 v1 兼容窗口时，两个版本都可读", () => {
      const supported = [2, 1];
      expect(accepts(2, supported), "当前版本必须可读").toBe(true);
      expect(accepts(1, supported), "兼容窗口内的旧版本必须可读").toBe(true);
    });

    it("兼容窗口关闭后，旧版本必须被拒绝而不是静默接受", () => {
      const supported = [2];
      expect(accepts(2, supported)).toBe(true);
      expect(accepts(1, supported), "窗口外旧版本必须拒绝").toBe(false);
    });

    it("窗口内的旧值即使不在首位也生效（集合顺序不影响判定）", () => {
      expect(accepts(1, [3, 1, 2])).toBe(true);
      expect(accepts(2, [3, 1, 2])).toBe(true);
      expect(accepts(4, [3, 1, 2])).toBe(false);
    });

    it("当前导出的集合至少包含当前版本，且全部为正整数", () => {
      expect(SUPPORTED_EVENT_PAYLOAD_VERSIONS.length).toBeGreaterThan(0);
      expect(SUPPORTED_EVENT_PAYLOAD_VERSIONS.every(v => Number.isInteger(v) && v > 0)).toBe(true);
      expect(SUPPORTED_EVENT_PAYLOAD_VERSIONS).toContain(EVENT_PAYLOAD_VERSION);
    });
  });
});
