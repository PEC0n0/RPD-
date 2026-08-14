# RPD通用一起看 — 异地同看浏览器插件

两台异地设备通过「相同的房间号 + 密码」建立 P2P 连接，一起看视频：同步当前网页、实时同步视频进度。

## 功能

- 房间号 + 密码建立两人房间
- 一键「同步此页」：把当前网页同步给对方（对方当前标签页直接跳转，不新开标签）
- 视频进度实时同步（播放 / 暂停 / 拖动 / 倍速）
- 各自可独立看其它视频；只有点「同步此页」才做页面同步
- 断线自动重连、记住密码自动重连
- 同步时自动带上发送方当前进度

## 安装（普通用户）

1. 下载 `syncwatch-extension.zip` 并解压
2. 打开 Edge（`edge://extensions`）或 Chrome（`chrome://extensions`）
3. 打开右上角「开发人员模式 / Developer mode」
4. 点「加载解压缩的扩展 / Load unpacked」，选择解压后的文件夹
5. 点工具栏右侧拼图图标，把 **SyncWatch** 固定到工具栏

## 使用

1. 两人各自点插件图标，输入**相同房间号 + 密码**，点「加入 / 创建房间」
2. 双方状态变为「已同步」即连接成功
3. 任一方打开视频页 → 点页面右上角「⇄ 同步此页」→ 对方当前标签页跳转到同一视频
4. 之后播放 / 暂停 / 拖动进度，对方实时跟随
5. 想各自看别的视频就直接看；要再同步就再点「同步此页」

## 部署信令服务器（房主只需一次）

插件是 P2P 的，但需要一个轻量「信令服务器」让两台设备互相找到对方。推荐部署到 [Render](https://render.com) 免费档：

**方式 A：Blueprint 一键部署**
1. 把本仓库推到 GitHub
2. Render 控制台 → New → Blueprint → 选择仓库，自动读取 `signaling-server/render.yaml` 完成部署

**方式 B：手动创建**
- New → Web Service → 连接仓库，Root Directory 选 `signaling-server`
- Build Command：`npm install`
- Start Command：`npm start`
- Health Check Path：`/health`

部署后得到 `https://xxx.onrender.com`，对应的 WebSocket 地址是 `wss://xxx.onrender.com`。

## 配置服务器地址

在插件弹窗「高级：信令服务器地址」里填入 `wss://xxx.onrender.com`，两台设备都填同一个地址即可（会记住，只填一次）。

> 本地测试可用默认的 `ws://localhost:8787`（需在本地跑 `cd signaling-server && npm install && npm start`）。

## 已知限制

- 仅支持两人房间
- DRM 平台（Netflix / 腾讯视频 VIP 等）无法用注入脚本控制，不在支持范围
- 接收端首次同步播放可能需点一下「点击开始同步播放」浮层（浏览器自动播放策略）

## 目录结构

```
E:\RPD
├── signaling-server/     # 信令服务器（Node.js + ws）
│   ├── server.js         # 房间/密码/双人协商/消息透传
│   ├── test.js           # 自检脚本
│   ├── render.yaml       # Render 一键部署蓝图
│   └── Dockerfile
├── extension/            # Chrome/Edge MV3 插件
│   ├── manifest.json
│   ├── background.js     # 后台 SW（offscreen 引导 + tabs 操作）
│   ├── offscreen.html/js # 常驻 WebSocket + WebRTC DataChannel
│   ├── popup/            # 弹窗 UI
│   └── content/          # 页面视频控制 + 悬浮同步按钮
├── tests/                # 无浏览器可跑的公式测试
└── syncwatch-extension.zip  # 可分发安装包
```
