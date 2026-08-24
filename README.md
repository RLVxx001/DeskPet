# DeskPet

macOS 菜单栏 3D 桌宠：透明窗口贴在桌角，点它能聊天。形象是 VRM，动作是 VRMA，对话走你自己填的 LLM。

目前只做了 Mac（arm64）。没有填 API Key 也能站着、走动，只是不会正经聊天。

## 运行

需要 Node.js 18+、npm。

```bash
npm install
npm start
```

如果是在 Cursor / 某些 IDE 终端里启动，先清掉 Electron 的占位环境变量，否则窗口起不来：

```bash
env -u ELECTRON_RUN_AS_NODE npm start
```

启动后右下角会出现桌宠，菜单栏有托盘图标。右键托盘可以聊天、换形象、填设置、退出。

打包成可打开的应用：

```bash
npm run pack
```

产物在 `release/`。

## 设置

第一次打开「设置」，至少填：

| 项 | 做什么 |
|---|---|
| 对话 API | OpenAI 兼容的 chat completions。默认按 Kimi Coding：`https://api.kimi.com/coding/v1`，模型 `k3` |
| 向量 API | 记忆和知识库检索用。默认阿里云兼容接口，模型 `qwen3.7-text-embedding` |

Key 存在 Electron 的 userData 里，不要提交进 git。

本地开发也可以把 Key 放到 `testdata/settings.local.json`（已 gitignore）。复制示例再填：

```bash
cp testdata/settings.local.json.example testdata/settings.local.json
```

userData 里还没有 Key 时，启动会读这个文件。

## 用什么

- **说话**：点桌宠或托盘打开聊天窗。同一段对话会留下来；稳定事实会记进记忆，可在「记得的事」里改或忘掉。
- **知识库**：把 `.md` / `.txt` 丢进设置里选的文件夹，聊天时可以直接问里面的内容。
- **形象**：只支持 `.vrm`。设置或托盘「换形象」选文件。仓库自带 `assets/models/avatar.vrm`（three-vrm 示例）。如果本地还有 `模型文件/1全模型2R2最终版/胡桃.vrm`，启动会优先用它。
- **动作**：`assets/animations/*.vrma`，来自 [vrm-viewer](https://github.com/tk256ailab/vrm-viewer)。没有对应 clip 的动作会退回程序摆姿势。

角色模型、MAX/FBX 合集不要当默认资源提交。别人 clone 之后用自带 `avatar.vrm` 就能跑。

## 代码怎么分

```
electron/main.js     窗口、托盘、IPC、读写设置
electron/agent.js    对话、工具、记忆、知识库
electron/rag.js      切片、向量、检索
electron/preload.js  渲染进程能调的接口
renderer/            桌宠 / 聊天 / 设置 / 气泡
assets/              默认 VRM 和 VRMA
testdata/            本地 Key 示例、示例笔记
```

`npm start` 会先跑 `scripts/build-renderer.js`，把渲染进程打进 `dist/`。改 `renderer/` 或 `electron/` 之后重新 `npm start` 才看得到。

聊天、记忆、设置实际写在：

`~/Library/Application Support/deskpet/deskpet/`

里面是 `chat.json`、`memory.json`、`settings.json` 和知识库索引。

## 测试

需要先有 `testdata/settings.local.json`。

```bash
npm run test:agent    # 对 agent 走一轮真实对话
npm run test:stress   # 压记忆 / 检索
```

## 不要提交

- API Key（`testdata/settings.local.json`、任何 settings 副本）
- `node_modules/`、`dist/`、`release/`
- 大体积角色模型（`模型文件/`、网上下的合集）
