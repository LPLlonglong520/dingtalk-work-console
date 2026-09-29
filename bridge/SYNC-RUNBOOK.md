# 钉钉数据中心 · 每日数据同步运行手册

本手册供定时任务（每日 20:00）执行。目标：拉取用户钉钉 6 大模块数据 → 打包加密 → 推送 GitHub → GitHub Pages 自动更新。

**项目目录**：`C:\Users\龙仔\.qwenworkcn\workspace\mudfpjlrrllypy2z\push-platform`

## 执行步骤（按顺序）

### 第 1 步：确定时间窗口

用 `date` 命令获取当前日期，计算：
- 会议同步窗口 = `今天-30天` 至 `今天+7天`（ISO 格式如 `2026-09-29T00:00:00+08:00`）

### 第 2 步：拉取 5 类数据（每条单独执行，输出到 data/raw/）

DWS 命令必须直接执行（不可管道/重定向）。带 `--output` 的命令会静默写文件：

```
dws wiki +space-list --type orgWikiSpace --page-all --format json --output "C:\Users\龙仔\.qwenworkcn\workspace\mudfpjlrrllypy2z\push-platform\data\raw\knowledge.json"

dws todo +get-related-tasks --format json --output "C:\Users\龙仔\.qwenworkcn\workspace\mudfpjlrrllypy2z\push-platform\data\raw\todos.json"

dws minutes +list-all --page-all --format json --output "C:\Users\龙仔\.qwenworkcn\workspace\mudfpjlrrllypy2z\push-platform\data\raw\minutes.json"
```

**会议数据特殊处理**（calendar 不支持 --output，用 --jq 精简投影后把返回结果写入文件）：

```
dws calendar event list --start "<30天前>T00:00:00+08:00" --end "<7天后>T23:59:59+08:00" --format json --jq "[.result.events[] | {id, summary, start: .start.dateTime, end: .end.dateTime, organizer: .organizer.displayName, attendees: [.attendees[]? | select(.self != true) | .displayName], location}]"
```

把返回的 JSON 数组用 python/node 包一层结构写入 `data/raw/meetings.json`：
`{"result": {"events": <返回的数组>, "hasMore": false}, "success": true}`

**收藏文档分页拉取**（star-list 每页最多 20 条，需按 nextCursor 翻页直到 hasMore=false）：

```
dws drive +star-list --limit 50 --format json --output "...\data\raw\stars.json"
dws drive +star-list --limit 50 --cursor "20" --format json --output "...\data\raw\stars_p2.json"
dws drive +star-list --limit 50 --cursor "40" --format json --output "...\data\raw\stars_p3.json"
```
（翻几页以实际 hasMore 为准；第一页后读取文件中 data.nextCursor 值作为下一页 --cursor 参数）

### 第 3 步：打包加密

```
cd "C:\Users\龙仔\.qwenworkcn\workspace\mudfpjlrrllypy2z\push-platform\bridge"
node pack-data.js
```

成功输出 `{ok: true, date: ..., counts: {...}}`。密码读取自 bridge/secret.txt（已 gitignore，不会入库）。

### 第 4 步：提交推送

```
cd "C:\Users\龙仔\.qwenworkcn\workspace\mudfpjlrrllypy2z\push-platform"
git add data/latest.enc
git -c user.name="LPLlonglong520" -c user.email="1412604317@qq.com" commit -m "data: 每日同步 <日期>"
git -c credential.helper= push origin main
```

**注意 1**：只 add `data/latest.enc`，不要 `git add -A`（data/raw/ 和 bridge/secret.txt 已被 .gitignore 排除，但仍避免误提交）。

**注意 2**：push 必须带 `-c credential.helper=`（禁用凭据助手，否则可能挂起等待交互输入）。如 push 超时挂起，先 `taskkill /IM git.exe /F` 清理进程再重试。

### 第 5 步：汇报

向用户钉钉发送简短同步结果（各模块数量 + 同步状态），失败时说明哪一步失败。

## 失败处理

- 某条 DWS 命令失败：跳过该模块继续其他模块（pack-data.js 对缺失文件返回空数组），在汇报中注明哪个模块缺失
- git push 失败：检查网络，重试一次；仍失败则汇报
- pack-data.js 报错 secret.txt 缺失：停止并汇报（需要用户重建密钥文件）
