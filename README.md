# ChatGPT-Retry

ChatGPT 桌面版在 Linux 上出现 “Selected model is at capacity” 时，这个程序把一段脚本注入页面，在后台调用「重试」的 `click()`。不移动鼠标，也不把窗口拉到前台。

它和 macOS 应用 [Codex-RetryPilot](https://github.com/yuxi1989/Codex-RetryPilot) 使用同一套判定，但是独立项目。macOS 版走辅助功能；这一版只运行在 Linux 的 ChatGPT 桌面版里。

## 运行

需要 Node.js 20+，以及已安装的 ChatGPT 桌面版（`/usr/bin/chatgpt`）。

```bash
./retrypilot
```

第一次会执行 `npm install`，只用来打包注入脚本。

ChatGPT 已经在跑、又没有调试端口时，命令会退出并打印原因。确认可以关掉当前窗口后：

```bash
./retrypilot --restart
```

这会退出当前 ChatGPT 进程，再用 `--remote-debugging-port` 重新打开，然后注入脚本。

可选参数：

```bash
./retrypilot --duration 8h --interval 10 --port 9333
```

`--duration` 接受 `Ns`、`Nm`、`Nh`，省略单位时按分钟计。默认间隔 10 秒，默认时长 30 分钟。

## 行为

- 只点标题正好是「重试 / Retry / 重試」的按钮。倒计时文案「N 秒后重试」先不点。
- 不点「重置使用量 / Reset usage / Reset limit」。
- 出现用量上限、又没有重试按钮时，暂停到解析出的重置时间。
- 窗口停在别的程序后面时仍然会点。左右滑动留下的相邻会话即使不在画面上，也会点它自己的「重试」，不切换当前会话。完全没挂在页面上的会话点不到。
- 窗口最小化较长时间后，Chromium 会放慢页面定时器，检查间隔可能长于设定值。
- 配置在 `~/.config/CodexRetry/config.json`，也可用 `RETRYPILOT_CONFIG_DIR` 或 `XDG_CONFIG_HOME` 改目录。字段与 macOS 版导出的 JSON 兼容，包括 `intervalSeconds`、`errorKeywords`、`scriptLines`、`limitPause`、`idleSendEnabled`。
- 日志写到配置目录下的 `logs/`。日志只记脚本自己的状态，不记会话正文。

调试端口只监听 `127.0.0.1`。关掉注入进程不会关掉 ChatGPT，端口会留到你退出 ChatGPT、再从应用菜单正常打开为止。这个端口可以控制该窗口里的页面，不要改成对外网卡监听。

## 开发

```bash
npm install
npm test
```

`npm test` 跑判定单测，并用无头 Chrome 在本机端口 `9337` 上确认脚本会点 Retry、不会点「重置使用量」。它不会连接已经打开的 ChatGPT。

## 许可

[MIT License](LICENSE)。
