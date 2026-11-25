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
});
