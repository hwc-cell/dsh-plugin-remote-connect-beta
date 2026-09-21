# 多租户：一个网关，每人一个独立 Harness

[English](multi-tenant.md) | [中文](multi-tenant.zh.md)

> **先读这段。** 每个租户的 Harness 都跑在**你装这个插件的那台机器上**，而 Harness 能在那里执行命令、
> 读写文件。所以把一条租户链接给出去，等于在那台电脑上给他开了一个账号。只给你愿意让他直接坐到这台
> 电脑前的人用。
>
> 如果对方只是想要自己的远程入口，最省事的答案是：**让他把本插件装在他自己的机器上**
> （MIT，`npx dsh-plugin-remote-connect-beta serve --public ...`）—— 这也是本项目的主要用途。下面的多租户
> 是为「一台机器确实要给多个人用」（家庭服务器、共用工作站）准备的，默认关闭。

一个 DSH Harness 实例**本身就是单用户的**：会话、凭据、设置、工作区、启动令牌全都在同一个
`DSH_HOME` 里，实例内部没有账号体系（自带的 `anonymous-user-id` 只是遥测用的 UUID，不是身份）。
所以多租户不可能是"给单个实例加个开关"，而是本插件当**网关**，给每个租户**一个独立的 Harness 进程**：

```
                         ┌─ 租户 alice ─► Harness 127.0.0.1:58581   DSH_HOME=~/DSH-tenants/alice
浏览器 ─?k=<alice 密钥>─►│                 （自己的会话 / 凭据 / 令牌）
   网关 :8787/:8788      └─ 租户 bob   ─► Harness 127.0.0.1:58582   DSH_HOME=~/DSH-tenants/bob
```

隔离的是什么、靠什么隔离：

| 隔离对象 | 边界 |
| --- | --- |
| 会话、设置、凭据、`storages/` | 每个租户一个独立 `DSH_HOME`（独立目录） |
| 进程、内存、agent 循环 | 每个租户一个独立操作系统进程 |
| 启动令牌 | 各自实例自己打印；网关**只**注入该请求所属租户的令牌 |
| 网络暴露面 | 所有实例只绑 `127.0.0.1`；唯一入口是网关 |
| 模型计费 / API 密钥 | 各自在自己的实例里配置凭据，不继承任何人的 |

`test/e2e-isolated.sh` 已端到端验证：两个真实实例各自监听独立回环端口、各自独立 `DSH_HOME`，
各自密钥进各自实例，匿名请求与无效密钥一律 `404`，并且**把一个租户的令牌打到另一个实例上返回 `401`**。

---

![Tenants card in the panel](tenants-preview.png)

## 打开它

```yaml
# profiles/web/cordis.patch.yml
- insert:
    - id: dsh-plugin-remote-connect-beta
      name: dsh-plugin-remote-connect-beta
      config:
        lan: { enabled: true, port: 8787 }
        tenants:
          enabled: true
          baseDir: ~/DSH-tenants          # 每个租户的 DSH_HOME 放这里
          registry: ~/.dsh/remote-connect/tenants.json
          harness:
            node: /opt/homebrew/bin/node  # 必须是真 node，见下面的坑
```

重启 DSH，打开面板：多了一张**租户**卡片。输入名字新增，点二维码，把人那条链接发给他 —— 就这些。
链接里带他的访问密钥，网关换成 Cookie 后，他之后的每个请求都落在**他自己**的 Harness 里。

⚠️ **一个能白花一小时的坑**：DSH Desktop 会把自己的 `node` shim（`ELECTRON_RUN_AS_NODE=1` + Electron
Helper）放进 `PATH`，而它会拒绝 `NODE_OPTIONS` —— 把 `harness.node` 指向它，租户实例一律起不来。
请指向真正的 Node（Homebrew 那个就行）。起不来时面板会把这句话直接摊出来；
自动探测找错入口时可以用 `tenants.harness.bin` 钉住。

---

## 命令行

```bash
# 只改注册表，不启动任何东西
npx dsh-plugin-remote-connect-beta tenant add --name "张三"      # 打印密钥 + 局域网链接 + 二维码
npx dsh-plugin-remote-connect-beta tenant list
npx dsh-plugin-remote-connect-beta tenant key    --id zhangsan
npx dsh-plugin-remote-connect-beta tenant rotate zhangsan        # 旧链接立刻失效
npx dsh-plugin-remote-connect-beta tenant rm     zhangsan        # 数据目录保留，不替你删

# 在没有 DSH 界面的机器上：网关 + 实例都在这个进程里
npx dsh-plugin-remote-connect-beta serve --multi --port 8787
```

`tenant` 只动注册表。Harness 实例归"跑网关的那个进程"所有 —— DSH 插件，或 `serve --multi`。
启停请在宿主窗口的面板里做（`serve --multi` 退出时会一起收掉），因为短命 CLI 命令拉起的实例
会在命令返回的瞬间变成孤儿进程。

---

## 注册表格式

`~/.dsh/remote-connect/tenants.json`，权限 `0600`，原子写入：

```json
{
  "version": 1,
  "tenants": [
    {
      "id": "alice",                    // 2–32 位小写字母/数字/连字符；同时是 DSH profile 名
      "name": "Alice",
      "accessKey": "…32 位 URL 安全字符…",
      "home": "/home/you/DSH-tenants/alice",
      "profile": "alice",
      "port": 0,                        // 0 = 由系统分配；真实端口从实例输出里读
      "autostart": true,
      "enabled": true,
      "note": "",
      "createdAt": "2026-09-19T03:44:53.370Z"
    }
  ]
}
```

手工编辑也可以：非法条目会被逐条报告并跳过（插件照样能起来），重复 id 或重复密钥会被拒。

**查重的范围是整台机器，不只是租户之间** —— 账本在 `$DSH_HOME/remote-connect/keys-used.json`
（0600，只存 sha256 前 16 位指纹）：租户口令不能等于本机访问口令，也不能复用任何**换掉过、已退休**
的旧口令。撞了就重新生成（生成时重试），不会等到写入才报错。见
[`self-host.zh.md` §4.8](self-host.zh.md)。

一对一也是硬约束：**一把口令只对应一个 Harness**。本机口令在多租户网关下打不开任何租户的实例
（`test/verify.mjs` 有回归断言），跨租户的令牌打到别人的实例上返回 `401`。

---

## 运维问答

| 问题 | 答案 |
| --- | --- |
| 某个租户的实例在干什么？ | `<租户 home>/instance.log`（它的 stdout/stderr），面板里也有该租户的状态 |
| 实例反复崩溃怎么办？ | 看护会指数退避重试，到上限就停手并显示最后的错误，不会无限重启刷屏 |
| 换了某人的口令会怎样？ | 面板里点该行的「换新口令」，旧的 `?k=` 链接立刻失效；他已发的 Cookie 也不再匹配。别人不受影响 |
| 删除租户会删数据吗？ | 不会。只停实例 + 从注册表移除，**他的数据目录原样保留** |
| 两个人共用一台电脑？ | 各用各自的浏览器 profile（Cookie 决定租户） |
| 公网入口呢？ | 每人一条 `https://<你的域名>/?k=<他的密钥>`；如果你在服务器上还开了 nginx 的「边缘口令」，那一层对所有人一样生效（它不是身份，只是院门） |
| 租户能摸到别人的实例吗？ | 不能：网关只连"当前请求 Cookie 解析出的那个上游"，而实例只认自己的令牌 |
| 租户会用我的 API 凭据吗？ | 不会 —— 按设计每个实例有自己的凭据文件。要用你的额度，得你主动把凭据放进去 |
