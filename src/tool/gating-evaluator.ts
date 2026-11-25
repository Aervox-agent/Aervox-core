/**
 * Aervox｜思隅 @aervox/core — 工具门控求值（AST-04 默认实现）
 *
 * 从 `host-tool-runtime.ts` 拆出：门控判定是纯函数，不依赖注册表或运行时状态，
 * 宿主可在装配期直接复用或替换（`HostToolRegistryPort.exportRegistry` 与
 * `callTool` 都接受自定义求值器）。
 *
 * fail-closed 原则：字段缺失、算子未知、`custom` 未注册求值器一律返回 false，
 * 绝不因为条件"看不懂"就放行。
 */

/** 按 dot-path 从门禁上下文解析字段值；上下文缺失或路径断裂返回 undefined */
export function resolveGatingField(context: unknown, field: string): unknown {
  if (context === null || typeof context !== "object") return undefined;
  let current: unknown = context;
  for (const part of field.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    if (!Object.hasOwn(current, part)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export interface GatingCondition {
  field: string;
  operator: string;
  value?: unknown;
  evaluatorId?: string;
}

/**
 * 默认门控求值（equals/in/truthy 基础实现）：
 * 字段值从门禁上下文按 dot-path 实际解析并与条件值比较；未知算子与
 * custom（需要宿主注册自定义求值器）一律 fail-closed 返回 false。
 */
export function defaultGatingEvaluator(condition: GatingCondition, context?: unknown): boolean {
  if (!condition || typeof condition.field !== "string" || !condition.field) return false;
  const resolved = resolveGatingField(context, condition.field);
  if (resolved === undefined) return false;
  switch (condition.operator) {
    case "truthy":
      return Boolean(resolved);
    case "equals":
      if (typeof resolved === "object" && typeof condition.value === "object") {
        return JSON.stringify(resolved ?? null) === JSON.stringify(condition.value ?? null);
      }
      return resolved === condition.value;
    case "in":
      return Array.isArray(condition.value) && (condition.value as unknown[]).includes(resolved);
    case "custom":
      return false;
    default:
      return false;
  }
}

/** 整组条件必须全部通过；条件缺失视为无门控。 */
export function gatingAllows(conditions: unknown, context?: unknown): boolean {
  if (conditions == null) return true;
  return Array.isArray(conditions) && conditions.every(c => defaultGatingEvaluator(c as GatingCondition, context));
}
