# Vercel 生产日志邮件巡检

GitHub Actions 工作流 `.github/workflows/vercel-log-email-monitor.yml` 每天按北京时间 12:00 和 18:00 检查线上项目 `prompt-lens` 的生产日志。

巡检范围：

- Vercel 项目：`prompt-lens`（`prj_LA38e0saqqVw1OkQ95AyoMx5vjIV`）
- 环境：`production`
- 分支：`main`
- 错误级别：`error`、`fatal`
- HTTP 状态：`5xx`

没有可操作错误时，工作流保持静默。发现错误或 Vercel 查询失败时，工作流通过 SMTP 发送中文摘要。工作流没有代码写入、提交、推送或部署权限。

## GitHub Actions Secrets

在仓库的 `Settings → Secrets and variables → Actions` 中配置：

| Secret | 必填 | 说明 |
| --- | --- | --- |
| `VERCEL_TOKEN` | 是 | 具备 `raojiacuis-projects` 团队和 `prompt-lens` 项目日志读取权限的 Vercel Token |
| `SMTP_HOST` | 是 | 邮件服务 SMTP 主机 |
| `SMTP_PORT` | 是 | SMTP 端口，常见值为 `465` 或 `587` |
| `SMTP_SECURE` | 是 | 端口 465 通常填 `true`，端口 587 通常填 `false` |
| `SMTP_USER` | 是 | 发件邮箱账号 |
| `SMTP_PASS` | 是 | 邮箱 SMTP 授权码或应用密码，避免使用网页登录密码 |
| `ALERT_EMAIL_TO` | 是 | 收件邮箱；多个地址可用英文逗号分隔 |
| `ALERT_EMAIL_FROM` | 否 | 发件人地址，省略时使用 `SMTP_USER` |

Vercel Token 和邮箱授权码只存入 GitHub Secrets。不要写入仓库文件、Actions 变量或日志。

## 验证

1. 配置全部 Secrets。
2. 打开仓库的 `Actions → Monitor Vercel production errors`。
3. 选择 `Run workflow`，勾选 `Send an email even when the selected log window is clean` 后手动执行。
4. 确认工作流成功，并收到标题包含“邮件通道测试”的邮件。
5. 后续普通手动运行和计划运行不勾选测试邮件；无错误时不会发送邮件。

计划任务采用固定、不重叠的时间窗口：12:00 巡检前一日 18:00 至当日 12:00，18:00 巡检当日 12:00 至 18:00。GitHub 调度即使延迟，也不会因此产生时间缺口。
