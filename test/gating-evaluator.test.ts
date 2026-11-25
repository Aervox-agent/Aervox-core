import { describe, expect, it } from "vitest";
import {
  defaultGatingEvaluator,
  gatingAllows,
  resolveGatingField,
} from "../src/tool/gating-evaluator.js";

/**
 * 门控求值从 host-tool-runtime.ts 拆出后单独覆盖。
 *
 * 这是安全相关判定：它决定一个工具能否对当前上下文可见/可调用。
 * 全部失败路径必须 fail-closed——看不懂的条件不能放行。
 */
describe("工具门控求值", () => {
  describe("resolveGatingField", () => {
    it("按 dot-path 逐层解析", () => {
      expect(resolveGatingField({ a: { b: { c: 7 } } }, "a.b.c")).toBe(7);
      expect(resolveGatingField({ a: 1 }, "a")).toBe(1);
    });

    it("路径断裂、上下文非对象或字段不存在时返回 undefined", () => {
      expect(resolveGatingField({ a: { b: 1 } }, "a.b.c")).toBeUndefined();
      expect(resolveGatingField({ a: null }, "a.b")).toBeUndefined();
      expect(resolveGatingField(null, "a")).toBeUndefined();
      expect(resolveGatingField("string", "a")).toBeUndefined();
      expect(resolveGatingField({}, "missing")).toBeUndefined();
    });

    it("不沿原型链取值", () => {
      // Object.hasOwn 守卫：继承来的属性不算"上下文里有这个字段"，
      // 否则宿主对象原型上的成员会成为绕过门控的入口。
      expect(resolveGatingField({}, "toString")).toBeUndefined();
      expect(resolveGatingField(Object.create({ secret: 1 }), "secret")).toBeUndefined();
    });
  });

  describe("defaultGatingEvaluator", () => {
    it("truthy 按布尔化判定", () => {
      expect(defaultGatingEvaluator({ field: "on", operator: "truthy" }, { on: true })).toBe(true);
      expect(defaultGatingEvaluator({ field: "on", operator: "truthy" }, { on: 0 })).toBe(false);
      expect(defaultGatingEvaluator({ field: "on", operator: "truthy" }, { on: "" })).toBe(false);
    });

    it("equals 比较原始值，并深比较对象", () => {
      expect(defaultGatingEvaluator({ field: "mode", operator: "equals", value: "study" }, { mode: "study" })).toBe(true);
      expect(defaultGatingEvaluator({ field: "mode", operator: "equals", value: "study" }, { mode: "quiz" })).toBe(false);
      expect(defaultGatingEvaluator({ field: "o", operator: "equals", value: { a: 1 } }, { o: { a: 1 } })).toBe(true);
      expect(defaultGatingEvaluator({ field: "o", operator: "equals", value: { a: 1 } }, { o: { a: 2 } })).toBe(false);
    });

    it("in 要求条件值为数组；非数组一律不放行", () => {
      expect(defaultGatingEvaluator({ field: "tier", operator: "in", value: ["a", "b"] }, { tier: "b" })).toBe(true);
      expect(defaultGatingEvaluator({ field: "tier", operator: "in", value: ["a"] }, { tier: "c" })).toBe(false);
      expect(defaultGatingEvaluator({ field: "tier", operator: "in", value: "a" }, { tier: "a" })).toBe(false);
    });

    it("custom、未知算子与畸形条件全部 fail-closed", () => {
      expect(defaultGatingEvaluator({ field: "x", operator: "custom" }, { x: true })).toBe(false);
      expect(defaultGatingEvaluator({ field: "x", operator: "unknown" }, { x: true })).toBe(false);
      expect(defaultGatingEvaluator({ field: "", operator: "truthy" }, { "": true })).toBe(false);
      expect(defaultGatingEvaluator({ field: 123, operator: "truthy" } as never, { 123: true })).toBe(false);
      expect(defaultGatingEvaluator(null as never, {})).toBe(false);
    });

    it("字段解析不到时即使算子为 equals 也不放行（不把 undefined 当作匹配）", () => {
      expect(defaultGatingEvaluator({ field: "missing", operator: "equals", value: undefined }, {})).toBe(false);
    });
  });

  describe("gatingAllows", () => {
    it("无条件视为无门控", () => {
      expect(gatingAllows(undefined)).toBe(true);
      expect(gatingAllows(null)).toBe(true);
    });

    it("全组必须通过", () => {
      const conditions = [
        { field: "authorized", operator: "truthy" },
        { field: "tier", operator: "in", value: ["pro"] },
      ];
      expect(gatingAllows(conditions, { authorized: true, tier: "pro" })).toBe(true);
      expect(gatingAllows(conditions, { authorized: false, tier: "pro" })).toBe(false);
      expect(gatingAllows(conditions, { authorized: true, tier: "free" })).toBe(false);
    });

    it("非数组条件 fail-closed", () => {
      for (const malformed of [{ field: "x" }, "x", 3, true]) {
        expect(gatingAllows(malformed, { x: true }), `conditions=${JSON.stringify(malformed)}`).toBe(false);
      }
      expect(gatingAllows([null], {})).toBe(false);
    });
  });
});
