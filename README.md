# Aervox-core

Aervox 的独立 Agent 执行内核。提供 Turn 执行、模型与工具循环、上下文构建、审批、取消、执行账本端口与诊断契约，运行时零第三方依赖。

宿主通过显式端口接入模型、存储、工具和交互。内核不持有应用数据库、账号、界面或业务插件；持久化、副作用授权和删除门禁由宿主实现负责。

## 独立开发

安装 [mise](https://mise.jdx.dev/)，在仓库根执行：

```sh
mise trust
mise install
mise exec -- pnpm install --frozen-lockfile
mise exec -- pnpm build
mise exec -- pnpm typecheck
mise exec -- pnpm test
```

工具版本由 [mise.toml](mise.toml) 和 `packageManager` 固定；依赖全部在根安装。`typescript`、`vitest`、`esbuild` 和 Node 类型仅用于开发，不进入运行时依赖。构建输出位于忽略的 `dist/`，包括 JavaScript、声明文件及声明映射。

完整测试包含浏览器打包、无 Node 全局变量执行及浏览器声明类型边界；也可单独运行 `mise exec -- pnpm test:browser`。浏览器类型检查调用本地 TypeScript 编译器，并显式禁用 ambient Node 类型。Vitest 的普通运行只转译测试代码，宿主与业务 Schema 的跨包兼容性应由宿主使用真实 TypeScript 类型检查验证。

## 使用

包名保持 `@aervox/core`，公开入口保持兼容：

| 入口 | 用途 |
|---|---|
| `@aervox/core` | 完整内核，含 Node 终端审批策略 |
| `@aervox/core/core` | 原有轻量入口，保留已有导出 |
| `@aervox/core/browser` | 平台中立入口，不引入终端审批或 Node 内置模块 |

例如，在将该仓库作为 workspace 包接入并构建后：

```ts
import {
  defaultContextBuilder,
  executeTurn,
  InMemoryExecutionStore,
  type ModelProviderPort,
} from "@aervox/core/browser";

const execution = new InMemoryExecutionStore();
execution.seedAttempt({ id: "attempt-1", turnId: "turn-1" });

const provider: ModelProviderPort = {
  id: "example",
  async *stream() {
    yield { text: "你好", isFinal: false };
    yield { text: "", isFinal: true };
  },
};

const result = await executeTurn(
  { execution, provider, contextBuilder: defaultContextBuilder },
  {
    turnId: "turn-1",
    attemptId: "attempt-1",
    sessionId: "session-1",
    userMessage: "你好",
  },
);
console.log(result.status);
```

示例使用内存账本与固定模型输出，用于展示端口接入。生产宿主应提供持久存储、实际模型、工具权限、取消与删除控制。

## 端口与责任

完整签名以 [src/ports.ts](src/ports.ts)、[src/types.ts](src/types.ts) 和公开入口声明为准。

| 端口 / 控制契约 | 宿主责任 |
|---|---|
| `ExecutionStorePort` / `SessionLedgerPort` | 执行状态、租约与 fencing、幂等预留、事件和工具结果的原子持久化 |
| `ModelProviderPort` | 模型流、工具调用与模型终态的协议转换 |
| `ContextBuilderPort` / `ContextCompactionPort` | 输入上下文与受控压缩 |
| `ToolProviderPort` / `HostToolRegistryPort` | 工具白名单、声明、调用及资源边界 |
| `ApprovalPolicyPort` / `UserQuestionPort` | 人工审批与用户提问交互 |
| `InboxPort` / `SubagentPort` | 外部输入与有界子任务委托 |
| `DeletionGatePort` / `ControlContext` | 删除及撤权门禁、取消、截止时间与预算 |
| `TextEmbeddingPort` / `ToolValidatorPort` | 可选向量能力及宿主 Schema 方言校验 |

内核提供内存实现供测试和集成使用；内存工具运行器不构成操作系统隔离沙箱。宿主承担文件、网络、数据库及其他外部副作用的授权和执行边界。

## 接回 Aervox-harness

[Aervox-harness](https://github.com/3yearsZhuang/Aervox-harness) 将本仓库作为 `packages/core` Git submodule 固定到确定提交，并通过 `@aervox/core` workspace 包消费。主仓修改子模块引用前，应在本仓库 feature / fix / docs 分支完成审查与验证。

在主仓执行：

```sh
git submodule update --init packages/core
mise exec -- pnpm install --frozen-lockfile
```

主仓构建与测试由主仓工具链编排；独立开发则使用本仓库配置。此仓库保持 `private: true`，目前通过 Git submodule / workspace 集成，尚未向 npm 发布。仓库代码可构建不等于已完成宿主集成、生产部署或软件发布。

## 来源、历史与许可

源码来自 Aervox-harness 的 `packages/core`。迁移保留了该路径的过滤提交历史、原始提交者及现有源码；路径过滤后的提交哈希会与原仓库不同。主仓原提交与架构记录仍可在 [Aervox-harness](https://github.com/3yearsZhuang/Aervox-harness) 查阅。迁移仅补齐独立构建配置，原公共 API 保持兼容；与主仓业务 Schema 的兼容测试留在宿主。

本仓库内核采用 **Apache-2.0**，完整许可证见 [LICENSE](LICENSE)，原许可与版权声明保留。Aervox-harness 主仓其余源码和文档的许可分别由主仓对应许可证定义，接入内核不会改变这些文件的许可。
