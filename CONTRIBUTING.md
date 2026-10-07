# STA-BX 开发协作指南

这份说明面向第一次使用 GitHub 和 AI 编程工具的同学。一般流程是：

**选择 Issue → 在评论区认领 → Fork → Clone → 配置测试环境 → 让 Agent 修复 → 本地查看 → 提交代码 → 创建 Pull Request → 等待检查和合并。**

仓库：<https://github.com/yhwlwl/sta-bx>

Issue 列表：<https://github.com/yhwlwl/sta-bx/issues>

## 先记住三件事

1. 每个 Issue 单独开一个分支和一个 Pull Request，不要把几个不相关的改动混在一起。请尽量保留分支commit数量少，建议每个pr内一个大版本只commit一次。原因是，每一次commit都会消耗一次构建，每月额度有限。
2. 不要直接向 main 推送，也不要把 .env.local、生产密码或 service_role 密钥提交到 GitHub。
3. 开发和测试统一连接测试 Supabase 项目。生产环境只由项目负责人维护。

## 1. 选择并认领 Issue

打开 [Issues](https://github.com/yhwlwl/sta-bx/issues)，先读完 Issue 的目标、范围和验收标准。优先选择仍然开放、没有人在处理的 Issue。

GitHub 中“认领”通常有两步：

1. 在 Issue 下留言，说明你准备处理它；
2. 等项目维护者确认或分配给你。

可以直接留言：

```text
我想处理这个 Issue，计划先检查现有实现，再补上功能和测试。
如果没有其他人正在处理，我来负责这个改动。
```

如果 Issue 已经有人认领，先选其他 Issue，或者在评论区和对方协调。不要没有沟通就重复实现。

目前可以从这些方向中选择：

- #1 公开财报页面
- #2 财报筛选统计
- #3 公开财报的数据脱敏和权限边界
- #4 财报导出
- #6 修改密码后撤销其他会话
- #7 操作日志搜索、筛选和分页
- #8 批量导入用户
- #9 工作台待处理提醒

Issue 内容可能会继续更新，以 Issue 页面上的最新内容为准。

## 2. Fork 并 Clone 仓库

### Fork

打开仓库主页，点击右上角 **Fork**，把仓库复制到自己的 GitHub 账号下。之后你拥有的是自己的副本，不会直接改动主仓库。

### Clone

把下面的 <你的用户名> 换成自己的 GitHub 用户名：

```bash
git clone https://github.com/<你的用户名>/sta-bx.git
cd sta-bx
```

git clone 已经自动完成了 Git 初始化，不需要再执行 git init。

建议添加主仓库作为 upstream，以后用来同步最新代码：

```bash
git remote add upstream https://github.com/yhwlwl/sta-bx.git
git remote -v
```

正常情况下会看到：

- origin：自己的 Fork，用来推送分支；
- upstream：主仓库，用来获取最新代码。

如果不是通过 git clone，而是手动创建了一个空文件夹，才需要这样初始化：

```bash
git init
git remote add origin https://github.com/<你的用户名>/sta-bx.git
git fetch origin
git switch -c main --track origin/main
```

## 3. 创建 Issue 分支

每个 Issue 都从最新的 main 创建自己的分支：

```bash
git switch main
git pull upstream main
git push origin main
git switch -c feat/issue-<编号>-简短名称
```

例子：

```bash
git switch -c feat/issue-7-audit-search
```

分支名可以用英文、数字和短横线，尽量短一些。不要在 main 分支上直接开发。

## 4. 安装依赖并配置 .env.local

建议使用 Node.js 20.19+ 或 22.12+。

在仓库根目录执行：

```bash
npm install
cp .env.example .env.local
```

然后编辑根目录下的 .env.local：

```dotenv
VITE_SUPABASE_URL=https://xqeodukjmrbpgcafteed.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=向项目负责人获取测试项目的_publishable_key
```

注意：

- 变量名必须是 VITE_SUPABASE_URL 和 VITE_SUPABASE_PUBLISHABLE_KEY；
- .env.local 只放在本机，不要提交；
- 不要把 SUPABASE_SERVICE_ROLE_KEY、数据库密码或生产变量放进前端项目；
- 改完 .env.local 后要重启本地开发服务器；
- 需要确认 .env.local 没有出现在待提交文件中：

```bash
git status --short
```

## 5. 测试账号

以下账号只用于测试 Supabase 项目 xqeodukjmrbpgcafteed，不适用于生产环境：

| 用户名 | 身份 | 测试密码 |
| --- | --- | --- |
| admin | 超级管理员 | 1234567890 |
| finance | 财委 | 1234567890 |
| chair | 主席 | 1234567890 |
| user | 普通用户 | 1234567890 |

权限含义：

- admin 是唯一的超级管理员，可以查看和处理全部流程；
- finance 只有财委身份；
- chair 只有主席身份；
- user 没有审批或管理身份，只按普通用户使用。

如果这个文件要提交到公开仓库，建议把上表中的密码改成“向项目负责人获取”，不要把任何可登录账号的密码公开在仓库里。

## 6. 在本地启动网站

在仓库根目录执行：

```bash
npm run dev
```

终端会显示类似地址：

```text
Local: http://localhost:5173/
```

用浏览器打开这个地址即可。端口被占用时，Vite 会自动使用其他端口，以终端显示的地址为准。

如果需要让同一局域网内的手机访问：

```bash
npm run dev -- --host 0.0.0.0
```

本地 Agent 也要在仓库根目录中打开，不要在上一级目录启动，否则它可能找不到 package.json、src 和 supabase。

## 7. 把 Issue 交给 AI Agent

在刚才的项目目录中打开本地 Agent，然后把 Issue 编号和链接告诉它。可以使用下面的提示词：

```text
请先阅读 CONTRIBUTING.md、README.md，并阅读 Issue #<编号>：<Issue 链接>。

先用几句话说明：
1. 现有代码中相关功能在哪里；
2. 这个 Issue 要解决的具体问题；
3. 你准备修改哪些文件；
4. 如何验证。

只处理这个 Issue，不顺手重写无关代码，也不要修改 main 分支。
开发期间只能使用测试 Supabase 环境，不要读取、输出或修改生产密钥。
不要把 .env.local 的内容写进代码、日志或提交记录。

完成后运行 npm test 和 npm run build，并告诉我改了什么、测试结果是什么。
```

让 Agent 修改之前，先看它的计划；修改后一定要查看 git diff。如果涉及数据库，要求它新增清晰的 migration 文件，并说明迁移顺序，不要让它直接对生产库执行 SQL。

## 8. 本地查看和验证

开发过程中保持本地服务运行，浏览器刷新即可看到修改。至少做这几项检查：

```bash
npm test
npm run build
```

然后再手动检查 Issue 的验收标准。例如：

- 普通用户不能看到不属于自己的管理操作；
- 财委和主席只看到自己身份对应的流程；
- admin 才能看到超级管理员功能；
- 附件、草稿、正式提交和撤回行为符合 Issue 描述；
- 浏览器控制台没有明显错误；
- 网络请求使用的是测试项目地址。

如果 AI 说“已经修好”，不要只看它的文字说明，要自己在 http://localhost:5173 操作一遍。

## 9. 提交代码到自己的 Fork

确认改动只属于当前 Issue 后执行：

```bash
git status
git diff --check
git diff
```

确认没有 .env.local、密码或密钥后提交：

```bash
git add -A
git commit -m "fix: 简短描述改动"
git push -u origin feat/issue-<编号>-简短名称
```

以后继续修改时，只需要再次提交并推送同一个分支：

```bash
git add -A
git commit -m "test: 补充相关测试"
git push
```

## 10. 创建 Pull Request

推送完成后打开自己的 Fork，点击 **Compare & pull request**。创建时确认：

- **base repository**：yhwlwl/sta-bx；
- **base branch**：main；
- **head repository**：自己的 Fork；
- **compare branch**：feat/issue-<编号>-简短名称。

PR 标题可以写成：

```text
fix: 修复操作日志搜索 #7
```

PR 内容建议包含：

```markdown
## 改了什么
- ……

## 如何验证
- npm test
- npm run build
- 浏览器手动验证：……

## 关联 Issue
Closes #7
```

如果是跨 Fork 的 PR，Closes #编号 仍然指向主仓库中对应的 Issue。不要把 PR 的目标仓库选成自己的 Fork。

## 11. PR 创建后

等待自动检查和维护者 review。收到意见后，继续在同一个本地分支修改、测试、提交和 git push，PR 会自动更新，不需要重新创建。

如果出现合并冲突：

```bash
git fetch upstream
git rebase upstream/main
# 解决冲突后
git add -A
git rebase --continue
git push --force-with-lease
```

只对自己的功能分支使用 --force-with-lease，不要对 main 使用强制推送。

PR 合并后同步本地：

```bash
git switch main
git pull upstream main
git push origin main
git branch -d feat/issue-<编号>-简短名称
git push origin --delete feat/issue-<编号>-简短名称
```

## 常见问题

### git push 提示没有权限

通常是推送到了主仓库。检查：

```bash
git remote -v
```

代码应该推到自己的 origin，例如：

```text
https://github.com/<你的用户名>/sta-bx.git
```

### 页面提示“尚未配置数据服务”

确认 .env.local 在仓库根目录、变量名完全正确，然后停止并重新运行：

```bash
npm run dev
```

### 登录或请求失败

确认使用的是测试项目 URL 和 publishable key，且测试项目的 app-api 已部署。不要把生产 key 粘贴到 Issue、PR 或 AI 对话中。

### AI 改了很多无关文件

先不要提交。让它解释每个文件的改动，撤掉与当前 Issue 无关的部分，再重新运行测试。

### Issue 已经有人在做

不要重复开工。可以换一个 Issue，或者在原 Issue 下留言协商协作方式。

