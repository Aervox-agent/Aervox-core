import { describe, expect, it } from "vitest";
import {
  HostToolError,
  HostToolForbiddenError,
  HostToolNotFoundError,
  HostToolValidationError,
  copyToolBudget,
  validateToolBudget,
} from "../src/tool/host-tool-errors.js";

/**
 * 错误层从 host-tool-runtime.ts 拆出后单独覆盖。
 *
 * 这些类被宿主直接抛出（如 host-runtime 的插件工具许可），因此它们的
 * `statusCode` / `code` 属于公开契约——宿主把这些值映射成 HTTP 响应。
 */
describe("宿主工具错误层", () => {
  it("基类默认 500 / TOOL_ERROR，并允许宿主指定", () => {
    const base = new HostToolError("boom");
    expect(base).toBeInstanceOf(Error);
    expect(base.name).toBe("HostToolError");
    expect(base.statusCode).toBe(500);
    expect(base.code).toBe("TOOL_ERROR");

    const custom = new HostToolError("teapot", 418, "TEAPOT");
    expect(custom.statusCode).toBe(418);
    expect(custom.code).toBe("TEAPOT");
  });

  it("子类固定各自的 status 与 code", () => {
    expect(new HostToolForbiddenError()).toMatchObject({ statusCode: 403, code: "FORBIDDEN", message: "forbidden" });
    expect(new HostToolNotFoundError()).toMatchObject({ statusCode: 404, code: "NOT_FOUND", message: "resource not found" });
    for (const error of [new HostToolForbiddenError(), new HostToolNotFoundError()]) {
      expect(error).toBeInstanceOf(HostToolError);
    }
  });

  it("校验错误把逐字段错误拼进 message 并保留结构化 errors", () => {
    const detail = [{ path: "q", message: "must be string" }, { path: "", message: "root required" }];
    const error = new HostToolValidationError("search", detail);
    expect(error.statusCode).toBe(400);
    expect(error.code).toBe("SCHEMA_VALIDATION_FAILED");
    expect(error.message).toContain("search");
    expect(error.message).toContain("q: must be string");
    // 空 path 必须以 (root) 呈现，否则消息会出现空洞冒号
    expect(error.message).toContain("(root): root required");
    expect(error.errors).toEqual(detail);
  });

  it("无明细时不追加冒号后缀", () => {
    expect(new HostToolValidationError("search").message).toBe("tool argument schema validation failed for search");
    expect(new HostToolValidationError("search", []).message).toBe("tool argument schema validation failed for search");
  });

  it("预算校验拒绝 Node 定时器无法可靠承载的值", () => {
    expect(() => validateToolBudget(undefined)).not.toThrow();
    expect(() => validateToolBudget({ timeoutMs: 1 })).not.toThrow();
    expect(() => validateToolBudget({ timeoutMs: 2_147_483_647 })).not.toThrow();

    for (const invalid of [0, -1, 1.5, 2_147_483_648, Number.NaN]) {
      expect(() => validateToolBudget({ timeoutMs: invalid }), `timeoutMs=${invalid}`)
        .toThrow(HostToolError);
    }
    for (const notObject of [null, [], "x", 3]) {
      expect(() => validateToolBudget(notObject as never), `budget=${String(notObject)}`).toThrow(/invalid_tool_budget/);
    }
  });

  it("复制预算返回新对象，避免调用方后续改动污染注册快照", () => {
    const source = { timeoutMs: 30_000 };
    const copy = copyToolBudget(source);
    expect(copy).toEqual({ timeoutMs: 30_000 });
    expect(copy).not.toBe(source);
    source.timeoutMs = 1;
    expect(copy!.timeoutMs).toBe(30_000);
    expect(copyToolBudget(undefined)).toBeUndefined();
  });
});
