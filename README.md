# dsh-pet-coo-link

把「蓝毛小女仆（dsh-pet）× 大肥鱼（Coopanion）」的对话通道做成 DSH 插件。v0.2.0

## 四个入口，一个循环

| 入口 | 作用 |
|---|---|
| **设置页**（设置 → 插件 → 桌宠对话） | 开关、间隔、快捷键、状态 |
| **托盘右键** | 💬 / ✅ 和大肥鱼聊天 |
| **快捷键** | 默认 **F9**（可在设置页改） |
| **工具** | pet_coo_status / pet_coo_toggle / pet_coo_say / pet_coo_run_once / pet_coo_history |

## 设置项

| 项 | 默认 | 说明 |
|---|---|---|
| 启用自动对话循环 | 关 | 打开即开始，关掉即停 |
| 每隔多少分钟聊一轮 | 2 | **0.5–240**，改完立刻重排下一轮 |
| 共享记忆 | 6 轮 | 近期逐轮细节；更早的只留话题关键词 |
| 快捷键 | **F9** | 单功能键（F1–F24）或组合键；单字母会被拒绝 |
| 陪玩静默 | 300 秒 | 她看游戏时，游戏话不进宠物频道 |
| 沉默时换话题 | 开 | 15 个话题轮转，且跳过最近聊过的 |

## 能力

- **自动轮聊**：她说话就接、她沉默就换话题（间隔带 ±30% 抖动，不像定时器）
- **双层记忆**：近期 6 轮细节 + 更早话题关键词，两边对称注入
- **陪玩隔离**：watch-window 最近 5 分钟有画面 → 她的游戏话留在主人那条线，宠物频道改用独立话题
- **人工优先**：手动 pet_coo_say 之后 150 秒内自动循环让路
- **防复读**：记住上一句回复，提示换说法
- **反向提问**：要求她回话时反问她一个问题
- **开关通知**：开关时两只宠物都会收到（小女仆会真的开口）

## API（供脚本/自检使用）

`
GET  /pet-coo/status              状态（enabled/intervalMinutes/hotkey/memoryLines/lastReply）
POST /pet-coo/toggle   {enabled}  开/关
POST /pet-coo/interval {minutes}  改间隔（0.5–240）
POST /pet-coo/hotkey   {hotkey}   改快捷键（需含修饰键，或 F1–F24）
`

## 数据

`
%DSH_HOME%\dsh-pet-coo-link\
  state.json     开关、间隔、快捷键、游标
  memory.jsonl   共享记忆（最近 300 轮）
  chat.md        人读记录
  link.log       运行日志
`

## 依赖

- dsh-pet（小女仆侧，提供 /dsh-pet-7340/chat）
- coopanion-connector-dsh（大肥鱼侧）。**推给她需要 connector 上的 /coopanion/tell 路由**
- Coopanion 桌面端在运行（读 /api/events 与 session-main.jsonl）

## 边界

1. 大肥鱼窗口只显示她自己说的话，外部推过去的 reply 帧只进她的输入——通知要请她「说出来」才看得见；
2. 小女仆本质是被喂话后回话，没有自主发起能力；
3. 托盘菜单与快捷键实现在 dsh-pet/runtime/electron-helper/main/tray.js，**dsh-pet 升级会覆盖**。

## 四档记忆（v0.3.0）

| 档 | 内容 | 成本 |
|---|---|---|
| ① 短期 | 最近 N 轮逐句细节（默认 10，可 0–20） | 约 250 token |
| ② 关键词回忆 | 拿当前这句话的 2 字片段去更早记忆里翻，命中就带上 | **0** |
| ③ 每日摘要 | 每天把话头压成一句，保留 14 天，注入最近 3 天 | **0** |
| ④ 事实卡 | 正则抽取「我喜欢/讨厌/怕/我是X派/不吃/最爱吃」，最多 40 条，注入前 8 条 | 约 50 token |

新增接口：

```
POST /pet-coo/memory {rounds}    记忆轮数（0–20）
```

数据文件：

```
daily.json   每日摘要（14 天滚动）
facts.json   事实卡（最多 40 条）
```

## 授权与合规（Licensing & compliance）

- **本仓库全部是本项目原创代码**，没有复制或内嵌 dsh-pet、coopanion-connector-dsh 或 Coopanion 桌面端的源码与素材。
- 运行时会**读取** Coopanion 自己写入的数据文件、调用 dsh-pet 与连接器的本地 HTTP 接口；这是与独立进程通信，不是链接或再分发它们的代码。
- dsh-pet 为 MIT；coopanion-connector-dsh 为 **AGPL-3.0-or-later**。本项目不是它的衍生作品，也不分发它；若你要修改并分发该连接器（例如自行添加 /coopanion/tell 路由），请遵守 AGPL 的相应义务。
- 图标 ssets/icon-180.png / icon-512.png 为几何图形生成图，不含任何第三方角色美术。
- 名称 dsh-pet、Coopanion 仅作事实性指代，用于说明依赖关系。

## 可调的记忆参数（v0.4.0）

设置页里三项都能改，填 0 即关闭：

| 参数 | 范围 | 默认 | 作用 |
|---|---|---|---|
| 记忆轮数 | 0–20 | 10 | 每轮注入最近多少轮的逐句细节 |
| 关键词回忆 | 0–6 | 2 | 按当前话题去更早记忆里翻几条 |
| 事实卡 | 0–20 | 8 | 注入多少条抽取到的长期事实 |

接口：

```
POST /pet-coo/memory { "rounds": 10, "recall": 2, "facts": 8 }
```

三项可只传其一，也可一起传；越界返回 400。