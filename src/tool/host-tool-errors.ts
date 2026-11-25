/**
 * Aervox｜思隅 @aervox/core — 宿主工具错误层
 *
 * 从 `host-tool-runtime.ts` 拆出：这些错误是工具运行时、门控求值器与宿主侧工具
 * 装配共同依赖的基础层，与内存实现无关。宿主（如 host-runtime 的插件工具许可）
 * 直接抛出它们，因此它们属于稳定公开面，而不是运行时内部细节。
 */
import type { ToolBudget, ToolValidationErrorDetail } from "../types.js";

export class HostToolError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(message: string, statusCode = 500, code = "TOOL_ERROR") {
    super(message);
    this.name = "HostToolError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export class HostToolForbiddenError extends HostToolError {
  constructor(message = "forbidden") {
    super(message, 403, "FORBIDDEN");
    this.name = "HostToolForbiddenError";
  }
}

export class HostToolNotFoundError extends HostToolError {
  constructor(message = "resource not found") {
    super(message, 404, "NOT_FOUND");
    this.name = "HostToolNotFoundError";
  }
}

export class HostToolValidationError extends HostToolError {
  readonly errors?: ToolValidationErrorDetail[];
  constructor(toolName: string, errors?: ToolValidationErrorDetail[]) {
    const detail = errors && errors.length > 0 ? `: ${errors.map((e) => `${e.path || "(root)"}: ${e.message}`).join("; ")}` : "";
    super(`tool argument schema validation failed for ${toolName}${detail}`, 400, "SCHEMA_VALIDATION_FAILED");
    this.name = "HostToolValidationError";
    this.errors = errors;
  }
}

/** 拒绝会被 Node 定时器截断或溢出为 1ms 的期限。 */
export function validateToolBudget(budget: ToolBudget | undefined): void {
  if (budget === undefined) return;
  if (budget === null || typeof budget !== "object" || Array.isArray(budget)) {
    throw new HostToolError("invalid_tool_budget: expected an object", 400, "INVALID_TOOL_BUDGET");
  }
  const timeout = budget.timeoutMs;
  if (timeout !== undefined && (!Number.isInteger(timeout) || timeout < 1 || timeout > 2_147_483_647)) {
    throw new HostToolError(
      "invalid_tool_budget: timeoutMs must be an integer between 1 and 2147483647",
      400,
      "INVALID_TOOL_BUDGET",
    );
  }
}

/** 复制预算并顺带校验；返回新对象避免调用方后续改动影响注册快照。 */
export function copyToolBudget(budget: ToolBudget | undefined): ToolBudget | undefined {
  validateToolBudget(budget);
  return budget === undefined ? undefined : { timeoutMs: budget.timeoutMs };
}
