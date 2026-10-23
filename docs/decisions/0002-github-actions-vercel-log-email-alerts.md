# ADR 0002：使用 GitHub Actions 巡检 Vercel 生产日志并发送邮件

- 状态：已接受
- 日期：2026-10-23

## 背景

线上项目需要定时检查 Vercel 生产日志。现有 Codex 心跳任务使用本地执行环境，电脑离线时无法保证按时运行。用户希望巡检完全在云端执行，发现错误后先发消息，由用户决定是否修复和推送。

## 决策

使用 GitHub Actions 定时工作流，在每天北京时间 12:00 和 18:00 运行：

1. 使用固定版本的 Vercel CLI 读取 `prompt-lens` 生产环境的 `error`、`fatal` 和 `5xx` 日志。生产环境由 Vercel 项目的 Production Branch 配置约束到 `main`。
2. 两次计划任务使用固定且不重叠的日志窗口，避免 GitHub 调度延迟造成漏报或重复。
3. 使用 Vercel CLI 65 的 `logs runtime`、`logs requests` 与 KQL 查询语法；解析 typed JSONL，忽略分页摘要，再对两类结果合并、去重并按部署 ID 与错误签名聚合。
4. 没有可操作错误时不发邮件；发现错误或日志查询失败时，通过通用 SMTP 发邮件。
5. 工作流权限限制为 `contents: read`，不得修改代码、提交、推送或部署。
6. Vercel Token、SMTP 授权码和收件地址保存在 GitHub Actions Secrets 中。

## 备选方案

### Codex 本地心跳任务

配置简单，但依赖本地电脑和 Codex 后台持续在线，不符合云端运行要求。

### Vercel Log Drain 与外部告警平台

实时性和长期存储更好，但可能需要更高套餐、额外服务与持续费用。当前每日两次巡检规模不需要引入该复杂度。

### Vercel Dashboard 手工检查

不需要开发，但容易遗漏，无法稳定按时执行。

## 后果

### 正面影响

- 巡检由 GitHub 云端运行，不依赖用户电脑。
- 无错误时保持安静，降低通知噪音。
- 邮件包含错误路径、状态、次数、最近时间、Deployment ID 和样例消息，方便用户判断错误来自哪个线上版本以及是否修复。
- 固定项目 ID、生产环境和 `main` 分支，降低误查 V2 测试项目的风险。

### 代价与风险

- 需要维护 Vercel Token 和 SMTP Secrets。
- Vercel Runtime Logs 的保留期和查询能力受套餐及平台策略影响。
- GitHub Actions 计划执行时间可能延迟，但固定查询边界可以避免时间缺口。
- 邮件服务异常时工作流会失败，需要通过 GitHub Actions 运行记录排查。

## 验证计划

1. 单元测试覆盖 typed JSONL 解析、分页摘要忽略、`httpStatus` 筛选、跨查询去重、按 Deployment ID 聚合和静默条件。
2. 使用 `workflow_dispatch` 的测试邮件开关验证完整邮件通道。
3. 关闭测试邮件开关手动运行，验证无错误时不发送邮件。
4. 在可控条件下验证错误邮件和 Vercel 权限失败邮件。
5. 检查工作流权限和日志，确认 Secrets 未输出，且没有写入或部署步骤。
