# Feishu Calendar Skill

一个给 `OpenClaw` 用的飞书日历技能。

它支持：

- 在飞书对话里创建日程
- 优先写入当前用户自己的飞书主日历
- 用户日历不可写时，自动回退到机器人日历并邀请用户参会
- 删除测试日程
- 本地完成一次性用户 OAuth 授权，并自动刷新 token

## 目录结构

```text
feishu-calendar-skill/
├── SKILL.md
├── agents/
│   └── openai.yaml
└── scripts/
    └── feishu-calendar.mjs
```

## 安装

### 一键安装

直接执行：

```bash
curl -fsSL https://raw.githubusercontent.com/tsumi233/feishu-calendar-skill/main/install.sh | bash
```

### 固定版本安装

如果你想安装某个 tag 版本：

```bash
curl -fsSL https://raw.githubusercontent.com/tsumi233/feishu-calendar-skill/main/install.sh | bash -s -- --ref v0.2.0
```

### 本地安装

如果你已经把仓库克隆到了本地，也可以直接运行：

```bash
./install.sh
```

或者：

```bash
git clone https://github.com/tsumi233/feishu-calendar-skill.git ~/.openclaw/skills/feishu-calendar
```

安装脚本默认会：

- 安装到 `~/.openclaw/skills/feishu-calendar`
- 自动备份旧版本 skill
- 只复制 skill 运行需要的文件，不复制 `.git`、README、截图资源或本地用户授权状态

## 前置条件

需要一套已经可用的飞书企业自建应用，并且在 `~/.openclaw/openclaw.json` 里配置好：

- `channels.feishu.accounts.default.appId`
- `channels.feishu.accounts.default.appSecret`

飞书开放平台里还需要配置：

- 应用能力：机器人
- 重定向地址：`http://127.0.0.1:18790/feishu-calendar/callback`

建议开通这些用户权限：

- `offline_access`
- `calendar:calendar:read`
- `calendar:calendar`
- `calendar:calendar.event:create`
- `calendar:calendar.event:update`
- `calendar:calendar.event:delete`

如果只开了租户权限，没有开用户权限，那么它仍然可以回退到机器人日历，但不能直接写入用户自己的主日历。

## 配置说明


### 1. 在飞书开放平台-安全设置中添加 Redirect URL

要点：

- 地址必须完整一致：`http://127.0.0.1:18790/feishu-calendar/callback`
- `127.0.0.1` 不要换成 `localhost`
- 保存后再进行用户授权

### 2. 在飞书开放平台-权限中开通用户侧 calendar 权限

建议至少开这几项：

- `offline_access`
- `calendar:calendar:read`
- `calendar:calendar`
- `calendar:calendar.event:create`
- `calendar:calendar.event:update`
- `calendar:calendar.event:delete`

如果刚刚补了权限，记得重新执行一次 `auth-start`，否则旧 token 还是不带这些 scope。

### 3. 在本机授权，然后在飞书里直接创建日程

推荐流程：

1. 先在运行 `OpenClaw` 的机器上执行 `auth-start`
2. 在浏览器中完成飞书授权
3. 再去飞书私聊里直接发自然语言建日程指令

## 一次性用户授权

首次要让某个飞书用户的请求直接写入其个人主日历，需要在运行 `OpenClaw` 的这台 Mac 上执行：

```bash
node ~/.openclaw/skills/feishu-calendar/scripts/feishu-calendar.mjs auth-start \
  --requester-open-id 'ou_xxx' \
  --open-browser true
```

授权成功后，token 会保存在本地：

```text
~/.openclaw/skills/feishu-calendar/state/users/<account-id>/<open_id>.json
```

不要把这个状态目录提交到 Git 仓库，也不要分享给别人。

## 常用命令

### 检查权限状态

```bash
node ~/.openclaw/skills/feishu-calendar/scripts/feishu-calendar.mjs probe \
  --requester-open-id 'ou_xxx'
```

### 查看当前用户授权状态

```bash
node ~/.openclaw/skills/feishu-calendar/scripts/feishu-calendar.mjs auth-status \
  --requester-open-id 'ou_xxx'
```

### 创建日程

```bash
node ~/.openclaw/skills/feishu-calendar/scripts/feishu-calendar.mjs create \
  --title '项目评审' \
  --start '2026-03-12T15:00:00+08:00' \
  --end '2026-03-12T16:00:00+08:00' \
  --requester-open-id 'ou_xxx' \
  --description '评审新版本发布计划'
```

### 删除日程

```bash
node ~/.openclaw/skills/feishu-calendar/scripts/feishu-calendar.mjs delete \
  --calendar-id 'feishu.cn_xxx@group.calendar.feishu.cn' \
  --event-id '6912345678901234567' \
  --requester-open-id 'ou_xxx'
```

## 运行逻辑

创建日程时，脚本会按这个顺序尝试：

1. 使用该用户的 `user_access_token` 直接写入其个人主日历
2. 如果用户授权不存在、已失效、或 scope 不够，尝试常规主日历探测
3. 如果用户主日历仍不可写，回退到机器人主日历并邀请该用户

## 适合的飞书对话指令

例如：

- `帮我创建明天下午3点到4点的飞书日程，标题叫项目评审`
- `帮我创建今天晚上8点到9点的日程，标题叫健身`
- `帮我删掉刚才创建的测试日程`

## 开发

本地校验：

```bash
python3 /Users/tsumi/.codex/skills/.system/skill-creator/scripts/quick_validate.py .
```

如果你修改了 skill 并希望 OpenClaw 立即使用，记得同步到：

```text
~/.openclaw/skills/feishu-calendar
```

## 仓库

- GitHub: <https://github.com/tsumi233/feishu-calendar-skill>
