# ChatGPT-Retry

ChatGPT 桌面版在 Linux 上出现 “Selected model is at capacity” 时，这个程序把一段脚本注入页面，在后台调用「重试」的 `click()`。不移动鼠标，也不把窗口拉到前台。

它和 macOS 应用 [Codex-RetryPilot](https://github.com/yuxi1989/Codex-RetryPilot) 使用同一套判定，但是独立项目。macOS 版走辅助功能；这一版只运行在 Linux 的 ChatGPT 桌面版里。

## 安装

需要 Node.js 20+，以及已安装的 ChatGPT 桌面版（`/usr/bin/chatgpt`）。

装到当前用户，不需要 root。`~/.local/bin` 需要在 `PATH` 里：

```bash
PREFIX="$HOME/.local" ./install.sh
```

装到系统：

```bash
sudo ./install.sh
```

装好之后命令是 `codexretry`。卸掉时 `PREFIX` 要和安装时一样：

```bash
PREFIX="$HOME/.local" ./install.sh uninstall
sudo ./install.sh uninstall
```

也可以在源码目录里直接跑 `./codexretry`。页面脚本比 `page.bundle.js` 新、又还没有打包工具时，它会执行一次 `npm install`。

## 运行

```bash
codexretry
```

ChatGPT 已经在跑、又没有调试端口时，命令会退出并打印原因。确认可以关掉当前窗口后：

```bash
codexretry --restart
```

这会退出当前 ChatGPT 进程，再用 `--remote-debugging-port` 重新打开，然后注入脚本。

可选参数：

```bash
codexretry --duration 8h --interval 10 --port 9333
```

`--duration` 接受 `Ns`、`Nm`、`Nh`，省略单位时按分钟计，也可以写 `unlimited` 或 `0`。默认间隔 10 秒。默认不限时，一直重试到你停掉进程。只有传入 `--duration`，或配置里写了时长，才会到点停止。

## 行为

- 默认没有运行时长。到了 `--duration` 或配置里的截止时间才停。
- 没有错误时也继续监控。之后再出现 “at capacity” 仍会点「重试」。
- 只点标题正好是「重试 / Retry / 重試」的按钮。倒计时文案「N 秒后重试」先不点。
- 会话显示「目标已停滞」时，点该会话的「恢复目标」。不点「清除目标」或「编辑目标」。这时输入框旁即使还有「停止」，也按停滞处理。
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
npm run build
npm test
```

`npm run build` 用 esbuild 把 `src/page.ts` 打成页面注入用的 `page.bundle.js`。`npm test` 会先重新构建，再跑 `test/logic.test.ts` 的判定单测和 `test/inject.test.ts` 的无头 Chrome 注入测试；测试会使用本机端口 `9337`，不会连接已经打开的 ChatGPT。

本地开发可以直接运行：

```bash
npm start
```

它会先构建，再执行 `src/injector.ts`。日常使用和安装后的入口都是 `codexretry`；源码目录中的 `./codexretry` 会在 `page.bundle.js` 缺失或落后于 `src/page.ts`、`src/logic.ts` 时自动构建。需要只验证注入逻辑时，可使用 `codexretry --no-launch --target any --port <端口>` 连接已有的 CDP 页面。

长期维护时保持以下路径和顺序：

1. 页面采集、点击和注入逻辑改在 `src/page.ts`；纯判定、配置解析和状态机改在 `src/logic.ts`；CDP 连接与配置加载改在 `src/injector.ts`；ChatGPT 进程发现、退出和启动改在 `src/launch.ts`。
2. 先运行 `npm test`，再提交 `src/`、`test/` 和同步生成的 `page.bundle.js`；不要手工编辑生成文件。
3. 安装发布使用 `PREFIX="$HOME/.local" ./install.sh` 或 `sudo ./install.sh`，脚本会重新构建并把运行所需文件复制到 `$PREFIX/lib/codexretry`，再在 `$PREFIX/bin/codexretry` 建立入口。
4. 修改配置后优先用隔离目录验证：`RETRYPILOT_CONFIG_DIR=$(mktemp -d) codexretry --no-launch ...`。提交前再次确认 `git status`、`npm test` 和 `git diff`，避免把本地日志或安装产物带进提交。

配置查找顺序是 `RETRYPILOT_CONFIG_DIR`、`XDG_CONFIG_HOME/CodexRetry`、`~/.config/CodexRetry`；文件名固定为 `config.json`，日志写入同目录的 `logs/`。例如：

```json
{
  "language": "zh",
  "intervalSeconds": 10,
  "durationChoice": "unlimited",
  "errorKeywords": ["at capacity"],
  "limitPause": true,
  "idleSendEnabled": false,
  "noSleep": true
}
```

运行中的进程会监视已经存在的 `config.json`，文件改动会重新载入；首次创建配置文件后重新启动一次即可启用监视。`durationChoice` 也兼容 `15`、`30`、`60`、`120`、`custom` 和 `unlimited`，命令行 `--duration` 还接受 `Ns`、`Nm`、`Nh`。

## 许可

[MIT License](LICENSE)。
