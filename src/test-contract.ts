/**
 * Aervox｜思隅 @aervox/core — 共享契约套件统一入口
 *
 * 为什么有这一层：套件按端口分文件（`execution-store-contract.ts`、
 * `inbox-contract.ts`），但宿主只应该记一个导入路径。此入口把它们组合起来，
 * 同时也让 `package.json` 的 `./test-contract` 只指向一个文件。
 *
 * 这些都是**测试用声明**，不含任何生产实现；`src/` 不引入测试框架，
 * 由宿主适配到自选 runner。
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
