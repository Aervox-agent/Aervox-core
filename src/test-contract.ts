/**
 * Aervox｜思隅 @aervox/core — 共享契约套件统一入口
 *
 * 为什么有这一层：套件按端口分文件（`execution-store-contract.ts`、
 * `inbox-contract.ts`），但宿主只应该记一个导入路径。此入口把它们组合起来，
 * 同时也让 `package.json` 的 `./test-contract` 只指向一个文件。
 *
 * 这些都是**测试用声明**，不含任何生产实现；`src/` 不引入测试框架，
 * 由宿主适配到自选 runner。
 *
 * ## 什么 Port 需要共享契约套件
 *
 * 判据是「同一语义有两份会长期并存的实现」，而不是「实现数量多」。已核对：
 *
 * | Port | 是否需要 | 理由 |
 * |---|---|---|
 * | `ExecutionStorePort` | **需要** | 内存版与 SQLite 版都是长期实现，语义必须一致 |
 * | `InboxPort` | **需要** | 同上；claim/ack 是崩溃重放的基础 |
 * | `ContextBuilderPort` | 不需要 | 多个实现是装饰器链（inbox/skill/grounding 各自包装 base），不是同一语义的两份实现 |
 * | `ModelProviderPort` | 不需要 | 各实现是不同后端（OpenAI / Replay / Faux / 宿主配置），语义由各自协议定义 |
 * | `ToolProviderPort` | 不需要 | 各实现提供不同工具集，是消费方注入的接口而非可替换实现 |
 * | `SubagentPort` / `DeletionGatePort` / `UserQuestionPort` / `TextEmbeddingPort` | 不需要 | 只有宿主持久实现，内核无内存对应版，不存在漂移对象 |
 *
 * 判定标准：如果某个 Port 将来出现「内核内存实现 + 宿主持久实现」的配对，
 * 就应当补一份套件，并在此表登记。
 */
export {
  executionStoreContract,
  type StoreContractCase,
  type StoreContractAssert,
  type StoreContractHelpers,
} from "./execution-store-contract.js";
export {
  inboxContract,
  type InboxContractCase,
  type InboxContractHelpers,
  type InboxItemShape,
} from "./inbox-contract.js";
