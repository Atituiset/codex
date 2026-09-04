# 第 2 章 启动链路：从 npm 壳到 TUI/exec 分发

## 本章导读

第 1 章给了你一张全景地图，本章开始沿着地图走第一段路：从你在终端敲下 `codex` 回车，到 Rust 二进制的 `main()` 把控制权交给 TUI，中间到底发生了什么。

这段链路比你想象的长。`npm i -g @openai/codex` 装下的其实不是一个可执行文件，而是一个 **JavaScript 壳**：它负责按你的操作系统和 CPU 架构挑出正确的原生二进制，再把进程让渡给它。二进制启动后也不是直接解析命令行——它先看一眼自己的 `argv[0]`（进程被以什么名字调用），决定要不要摇身一变成为 `apply_patch` 或 Linux 沙箱助手；确认自己是“正常形态”之后，才轮到 clap 解析子命令，把 `codex`（无参数）、`codex exec`、`codex mcp-server`、`codex app-server` 分发到四条完全不同的代码路径。

如果你写过 TypeScript 版的 my-agent，启动链路对你大概只有一行：`node dist/index.js`，然后 `commander.parse()`。Codex 为什么要把这么简单的事情拆成三层（npm 壳 → arg0 分发 → clap 子命令）？每一层解决了什么单靠一层解决不了的问题？这是本章要回答的核心问题，也是理解后面所有章节的前提——配置加载（[第 3 章](ch03-config.md)）、认证（[第 4 章](ch04-auth-model.md)）都挂在本章讲的分发点之后。

## 源码地图

| 文件 | 职责 | 一句话点评 |
|------|------|-----------|
| `codex-cli/package.json` | npm 包清单，`bin` 指向 JS 壳 | 发布的包里只有 `bin/codex.js` 一个文件 |
| `codex-cli/bin/codex.js` | 按平台选二进制并 spawn | 全书唯一的 JS 主角，信号处理是精髓 |
| `codex-cli/scripts/build_npm_package.py` | 打包时注入 `optionalDependencies` | 平台分包的秘密不在 package.json 里，在这里 |
| `codex-rs/cli/Cargo.toml` | 声明 `codex` 二进制目标 | `[[bin]] name = "codex"` |
| `codex-rs/cli/src/main.rs` | 主入口 + clap 子命令分发 | 4800+ 行，本章只读骨架 |
| `codex-rs/arg0/src/lib.rs` | argv[0] 分发与 tokio 运行时搭建 | “一个二进制扮演多个 CLI”的机关 |
| `codex-rs/cli/src/lib.rs` | cli 库面：login、sandbox 命令等 | `main.rs` 与库分开，便于复用 |
| `codex-rs/cli/src/login.rs` | `codex login/logout` 的实现 | 分发后的去向之一，详见第 4 章 |
| `codex-rs/cli/src/mcp_cmd.rs` | `codex mcp` 子命令（管理外部 MCP server） | 典型的“配置编辑型”子命令 |
| `codex-rs/tui/src/cli.rs` | TUI 自己的 `Cli` 参数结构 | 无子命令时被 flatten 进顶层 |
| `codex-rs/tui/src/lib.rs` | `codex_tui::run_main` TUI 入口 | 默认路径的终点，详见第 14 章 |
| `codex-rs/exec/src/lib.rs` | `codex_exec::run_main` 无头模式入口 | 详见第 16 章 |
| `codex-rs/mcp-server/src/lib.rs` | `codex_mcp_server::run_main` | 注意：该子命令已被标记弃用 |

## 核心数据结构

启动链路横跨 JS 与 Rust 两个世界，数据结构也分两组。

### npm 壳一侧：平台映射表

npm 壳的全部“智能”集中在这张表里——Rust 的 target triple 到 npm 平台分包的映射：

```js
// 来源：codex-cli/bin/codex.js:16-23
const PLATFORM_PACKAGE_BY_TARGET = {
  "x86_64-unknown-linux-musl": "@openai/codex-linux-x64",
  "aarch64-unknown-linux-musl": "@openai/codex-linux-arm64",
  "x86_64-apple-darwin": "@openai/codex-darwin-x64",
  "aarch64-apple-darwin": "@openai/codex-darwin-arm64",
  "x86_64-pc-windows-msvc": "@openai/codex-win32-x64",
  "aarch64-pc-windows-msvc": "@openai/codex-win32-arm64",
};
```

注意 Linux 用的是 `musl` 而不是 `gnu`：静态链接 musl libc 的二进制不依赖宿主的 glibc 版本，在任何发行版上都能跑。这是“单二进制分发”思路在 C 库层面的落地。

### Rust 一侧：`MultitoolCli` 与 `Subcommand`

`codex-rs/cli/src/main.rs` 的顶层参数结构叫 `MultitoolCli`——“多用途工具”的意思。它由四块 flatten 进来的参数组加一个可选子命令构成：

```rust
// 来源：codex-rs/cli/src/main.rs:100-130
/// Codex CLI
///
/// If no subcommand is specified, options will be forwarded to the interactive CLI.
#[derive(Debug, Parser)]
#[clap(
    author,
    version,
    // If a sub‑command is given, ignore requirements of the default args.
    subcommand_negates_reqs = true,
    // The executable is sometimes invoked via a platform‑specific name like
    // `codex-x86_64-unknown-linux-musl`, but the help output should always use
    // the generic `codex` command name that users run.
    bin_name = "codex",
    override_usage = "codex [OPTIONS] [PROMPT]\n       codex [OPTIONS] <COMMAND> [ARGS]"
)]
struct MultitoolCli {
    #[clap(flatten)]
    pub config_overrides: CliConfigOverrides,   // ← -c key=value 覆盖，流向所有子命令

    #[clap(flatten)]
    pub feature_toggles: FeatureToggles,        // ← --enable/--disable 功能开关

    #[clap(flatten)]
    remote: InteractiveRemoteOptions,           // ← --remote 连接远程 app-server

    #[clap(flatten)]
    interactive: TuiCli,                        // ← 关键：TUI 的参数直接铺在顶层

    #[clap(subcommand)]
    subcommand: Option<Subcommand>,             // ← None 就意味着"进 TUI"
}
```

`interactive: TuiCli` 这一行是整个 CLI 形态设计的枢纽：TUI 的参数结构被 `flatten` 进顶层，所以 `codex --model gpt-5 "fix the bug"` 不需要任何子命令；`subcommand` 是 `Option`，`None` 就是默认路径。`subcommand_negates_reqs = true` 则保证 `codex exec ...` 不会被顶层参数的要求误伤。

`Subcommand` 枚举是用户可见形态的全集（`main.rs:132-230`），删减后长这样：

```rust
// 来源：codex-rs/cli/src/main.rs:132-230（有删节）
#[derive(Debug, clap::Subcommand)]
enum Subcommand {
    /// Browse all agent sessions on the shared local app-server daemon.
    Agents(AgentsCommand),

    /// Run Codex non-interactively.
    #[clap(visible_alias = "e")]
    Exec(ExecCli),                              // ← 无头模式 → 第 16 章

    /// Run a code review non-interactively.
    Review(ReviewCommand),

    /// Manage login.
    Login(LoginCommand),                        // ← 认证 → 第 4 章

    /// Manage external MCP servers for Codex.
    Mcp(McpCli),

    /// Start Codex as an MCP server (stdio).
    McpServer(McpServerCommand),                // ← 已弃用，见下文

    /// [experimental] Run the app server or related tooling.
    AppServer(AppServerCommand),                // ← IDE 集成 → 第 15 章

    /// Resume a previous interactive session (picker by default; use --last ...).
    Resume(ResumeCommand),                      // ← 会话恢复 → 第 13 章

    // ... 还有 logout / plugin / completion / doctor / sandbox / debug /
    //     apply / fork / cloud / exec-server / features 等二十余个变体
}
```

每个变体持有自己的参数结构（`ExecCli`、`LoginCommand`……），clap 在解析阶段就按子命令名把 `argv` 分流到对应的结构里。类型即路由表。

### arg0 一侧：`Arg0DispatchPaths`

arg0 分发完成后，往下游传递的是这个不起眼但到处出现的结构：

```rust
// 来源：codex-rs/arg0/src/lib.rs:27-37
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct Arg0DispatchPaths {
    /// Stable path to the current Codex executable for child re-execs.
    ///
    /// Prefer this over [`std::env::current_exe()`] in code that may run under
    /// a test harness, where `current_exe()` can point at the harness binary
    /// instead of the real Codex CLI.
    pub codex_self_exe: Option<PathBuf>,
    pub codex_linux_sandbox_exe: Option<PathBuf>,
    pub main_execve_wrapper_exe: Option<PathBuf>,
}
```

为什么需要它？因为 Codex 在运行期会**反复重新执行自己**：沙箱要 re-exec、apply_patch 要走 PATH 别名、app-server 要拉起子进程。这些路径在进程启动时一次性解析好，之后通过参数一层层传下去（你在第 1 章的 `codex_exec::run_main(exec_cli, arg0_paths)` 签名里已经见过它）。注释里还特别提醒：测试 harness 下 `current_exe()` 指向的是测试 runner 而不是 codex 本体，所以这个值要在 `main()` 附近捕获，不能到用的时候再查。

## 流程走读

先看全链路的总图，再逐段拆开：

```
$ codex "fix the bug"
  │
  ▼
npm bin shim ──► node codex-cli/bin/codex.js
  │  按 process.platform/arch 算出 target triple
  │  定位 vendor/<triple>/bin/codex（来自平台分包）
  │  spawn 子进程，转发 SIGINT/SIGTERM/SIGHUP，镜像退出码
  ▼
codex 原生二进制：cli/src/main.rs::main()
  │
  ▼
arg0_dispatch()：先看 argv[0]/argv[1]（arg0 crate）
  ├─ argv[0]=codex-linux-sandbox → codex_linux_sandbox::run_main()（不返回）
  ├─ argv[0]=apply_patch         → codex_apply_patch::main()（不返回）
  ├─ argv[1]=--codex-run-as-apply-patch → 打补丁后 std::process::exit
  └─ 正常形态：load_dotenv → 建 PATH 别名目录 → 建 tokio runtime
  │
  ▼
cli_main()：MultitoolCli::parse()，然后 match subcommand
  ├─ None（无子命令） → run_interactive_tui → codex_tui::run_main  → 第 14 章
  ├─ exec / review    → codex_exec::run_main                      → 第 16 章
  ├─ mcp-server       → codex_mcp_server::run_main（已弃用）       → 第 12 章
  ├─ app-server       → codex_app_server（JSON-RPC 长驻服务）      → 第 15 章
  ├─ login / logout   → cli/src/login.rs → codex_login            → 第 4 章
  └─ resume / mcp / … → 各自模块，最终多数也汇入 TUI 或 core
```

### 第一段：npm 壳如何选择二进制

`@openai/codex` 的 `package.json` 极简，关键是 `bin` 字段和 `files` 白名单：

```json
// 来源：codex-cli/package.json:6-15
"bin": {
  "codex": "bin/codex.js"
},
"type": "module",
"engines": {
  "node": ">=16"
},
"files": [
  "bin/codex.js"
]
```

`files` 里只有 `bin/codex.js`——也就是说你全局安装的这个包里**没有任何原生二进制**。真正的二进制在六个平台分包（`@openai/codex-linux-x64` 等）里，每个分包带 `os`/`cpu` 字段，npm 安装时会自动跳过不匹配的平台。这些分包声明为 `optionalDependencies`——但你在仓库的 `package.json` 里找不到它们，因为它们是打包脚本在发布时注入的：

```python
# 来源：codex-cli/scripts/build_npm_package.py:294-303
if package == "codex":
    package_json["files"] = ["bin/codex.js"]
    package_json["optionalDependencies"] = {
        CODEX_PLATFORM_PACKAGES[platform_package]["npm_name"]: (
            f"npm:{CODEX_NPM_NAME}@"
            f"{compute_platform_package_version(version, CODEX_PLATFORM_PACKAGES[platform_package]['npm_tag'])}"
        )
        for platform_package in PACKAGE_EXPANSIONS["codex"]
        if platform_package != "codex"
    }
```

这套“主包 + optionalDependencies 平台分包”是 esbuild、swc 等工具开创的标准玩法：用户只装自己平台的二进制，下载量从“六个平台全量”降到一份。

`codex.js` 运行时的第一步是把 Node 的 `process.platform`/`process.arch` 翻译成 Rust target triple（`codex.js:25-68`，就是一串嵌套 `switch`），然后定位二进制：

```js
// 来源：codex-cli/bin/codex.js:79-96
function findCodexExecutable() {
  let vendorRoot;
  try {
    const packageJsonPath = require.resolve(`${platformPackage}/package.json`);
    vendorRoot = path.join(path.dirname(packageJsonPath), "vendor");
  } catch {
    vendorRoot = path.join(__dirname, "..", "vendor");  // ← 回退：二进制就躺在主包旁边
  }

  const codexExecutable = path.join(
    vendorRoot,
    targetTriple,
    "bin",
    process.platform === "win32" ? "codex.exe" : "codex",
  );
  if (existsSync(codexExecutable)) {
    return codexExecutable;
  }
  // ... 找不到就抛出带重装指引的错误
}
```

用 `require.resolve` 而不是自己拼 `node_modules` 路径，是为了兼容 pnpm 的隔离式布局——包管理器把平台包放在哪里，让 Node 的模块解析算法去找。

### 第二段：spawn 与信号的精细让渡

找到二进制后，npm 壳不是简单地 `exec` 掉自己，而是 `spawn` 一个子进程并**全程陪护**（`codex.js:195-249`）：

```js
// 来源：codex-cli/bin/codex.js:195-226（有删节）
const child = spawn(binaryPath, process.argv.slice(2), {
  stdio: "inherit",          // ← 子进程直接继承终端的 stdin/stdout/stderr
  env,                       // ← 附带 CODEX_MANAGED_BY_NPM 等安装方式标记
});

// ...

const forwardSignal = (signal) => {
  if (child.killed) {
    return;
  }
  try {
    child.kill(signal);
  } catch {
    /* ignore */
  }
};

["SIGINT", "SIGTERM", "SIGHUP"].forEach((sig) => {
  process.on(sig, () => forwardSignal(sig));
});
```

这段代码里藏着两个容易踩的坑，源码注释把它们讲得很清楚：

1. **为什么用异步 `spawn` 而不是 `spawnSync`？** 同步 spawn 期间 Node 进程无法响应信号。你在 TUI 里按 Ctrl-C，SIGINT 会先到达 Node 父进程；只有异步 spawn 才能让父进程活着处理信号、把它转发给 Rust 子进程，让 TUI 有机会恢复终端状态后优雅退出。
2. **退出时要“镜像”死因。** 子进程退出后（`codex.js:233-249`），如果它是被信号杀死的，父进程用 `process.kill(process.pid, signal)` 给自己发同一个信号——这样 shell 看到的退出状态是 `128 + n`，脚本和 CI 才能正确判断“用户中断”和“正常失败”。

父进程还往环境变量里写了 `CODEX_MANAGED_BY_NPM` / `CODEX_MANAGED_BY_PNPM` / `CODEX_MANAGED_BY_BUN`（`codex.js:179-193`，靠启发式判断包管理器），Rust 侧的 `codex update` 据此决定用哪条命令自我更新。安装方式的上下文就这样通过 env 完成了跨语言传递。

### 第三段：arg0 分发——一个二进制，多张面孔

原生二进制启动，进入 `cli/src/main.rs` 的 `main()`：

```rust
// 来源：codex-rs/cli/src/main.rs:1040-1046
fn main() -> anyhow::Result<()> {
    let remote_control_disabled = codex_app_server::take_remote_control_disabled_env();
    arg0_dispatch_or_else(move |arg0_paths: Arg0DispatchPaths| async move {
        cli_main(arg0_paths, remote_control_disabled).await?;
        Ok(())
    })
}
```

`main` 自己几乎什么都不做，全部委托给 `arg0_dispatch_or_else`。这个函数是 arg0 crate 对外的主入口，名字的意思是：“先尝试按 argv[0] 分发；如果不是特殊形态，再执行你给的 `main_fn`”。

分发逻辑在 `arg0_dispatch()`（`arg0/src/lib.rs:60-174`），第一件事情是看自己被以什么名字调用：

```rust
// 来源：codex-rs/arg0/src/lib.rs:60-100（有删节）
pub fn arg0_dispatch() -> Option<Arg0PathEntryGuard> {
    // Determine if we were invoked via the special alias.
    let mut args = std::env::args_os();
    let argv0 = args.next().unwrap_or_default();
    let exe_name = Path::new(&argv0)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("");

    // ... argv[0] == "codex-execve-wrapper" 的分支（Unix 提权执行包装器）

    if exe_name == CODEX_LINUX_SANDBOX_ARG0 {
        // Safety: [`run_main`] never returns.
        codex_linux_sandbox::run_main();        // ← 沙箱助手形态，永不返回
    } else if exe_name == APPLY_PATCH_ARG0 || exe_name == MISSPELLED_APPLY_PATCH_ARG0 {
        codex_apply_patch::main();              // ← apply_patch 形态（含常见拼写错误别名）
    }
```

`CODEX_LINUX_SANDBOX_ARG0` 就是字符串 `"codex-linux-sandbox"`（`codex-rs/sandboxing/src/landlock.rs:6`），`APPLY_PATCH_ARG0` 是 `"apply_patch"`（`arg0/src/lib.rs:20`）。这就是经典的 **busybox 模式**：一个二进制根据 `argv[0]` 扮演多个工具。

Windows 上 symlink 不便，所以还有一层按 `argv[1]` 的分发做后备（`arg0/src/lib.rs:102-155`）：如果第一个参数是 `--codex-run-as-apply-patch`（常量在 `codex-rs/apply-patch/src/lib.rs:55`），就在进程内直接应用补丁然后 `exit`。

确认自己是正常形态后，`arg0_dispatch` 做三件为“正常运行”铺路的事：

1. **`load_dotenv()`**（`arg0/src/lib.rs:159, 303-323`）：从 `~/.codex/.env` 读环境变量，但**过滤掉所有 `CODEX_` 前缀的键**——防止用户配置文件覆盖 Codex 自己的内部协议变量（比如上一节 npm 壳写入的 `CODEX_MANAGED_BY_*`）。
2. **建 PATH 别名目录**（`arg0/src/lib.rs:161-173, 338-448`）：在 `$CODEX_HOME/tmp/arg0/codex-arg0-XXXXXX/` 下创建指向当前可执行文件的符号链接：

```rust
// 来源：codex-rs/arg0/src/lib.rs:387-401（有删节）
for filename in &[
    APPLY_PATCH_ARG0,
    MISSPELLED_APPLY_PATCH_ARG0,
    #[cfg(target_os = "linux")]
    CODEX_LINUX_SANDBOX_ARG0,
    #[cfg(unix)]
    EXECVE_WRAPPER_ARG0,
] {
    let exe = std::env::current_exe()?;

    #[cfg(unix)]
    {
        let link = path.join(filename);
        symlink(&exe, &link)?;          // ← apply_patch 等名字 → codex 本体
    }
    // ... Windows 上改为生成调用隐藏 flag 的 .bat 脚本
}
```

   然后把这个临时目录 prepend 到 `PATH`。效果：模型生成的 shell 命令里如果写了 `apply_patch ...`，内核执行时能在 PATH 上直接找到它——找到的其实还是 codex 自己，只是绕回上面的 argv[0] 分支。沙箱与补丁的详细机制见[第 10 章](ch10-shell-applypatch.md)和[第 11 章](ch11-sandbox-approval.md)。临时目录靠一个文件锁（`.lock`）和“看门人”清理函数（`janitor_cleanup`，`arg0/src/lib.rs:481-508`）管理：还活着的进程握着锁，已死进程留下的目录才能被下次启动清掉。
3. **搭 tokio 运行时**（`arg0_dispatch_or_else`，`arg0/src/lib.rs:219-248`）：

```rust
// 来源：codex-rs/arg0/src/lib.rs:230-247
// Regular invocation. Run the async entry point on a thread with the same
// stack budget as Tokio workers; `Runtime::block_on` otherwise runs the
// top-level future on the caller's OS stack.
let handle = std::thread::Builder::new()
    .name("codex-main".to_string())
    .stack_size(TOKIO_WORKER_STACK_SIZE_BYTES)     // ← 16 MiB
    .spawn(move || {
        let runtime = build_runtime()?;            // ← new_multi_thread + enable_all
        runtime.block_on(run_main_with_arg0_guard(
            path_entry_guard,
            current_exe,
            main_fn,
        ))
    })?;
match handle.join() {
    Ok(result) => result,
    Err(payload) => std::panic::resume_unwind(payload),  // ← 子线程 panic 照样向上抛
}
```

   为什么不直接在主线程 `block_on`？注释给了答案：`block_on` 会把顶层 future 跑在调用者的 OS 栈上，而主线程栈通常只有 8 MiB；TUI 的深层异步调用链（大量嵌套 `async fn` 的 future 状态机）可能撑爆它。于是专门起一个 16 MiB 栈的 `"codex-main"` 线程，让顶层 future 享受和 tokio worker 一样的栈预算。别名目录的 guard（`Arg0PathEntryGuard`，RAII 包装）被一并带进 future，保证临时目录活到进程最后一刻。

到这里，“环境准备”结束，`cli_main` 才真正开始。

### 第四段：clap 子命令分发

`cli_main`（`main.rs:1048` 起）开头是解析与规范化：

```rust
// 来源：codex-rs/cli/src/main.rs:1052-1061
let MultitoolCli {
    config_overrides: mut root_config_overrides,
    feature_toggles,
    remote,
    mut interactive,
    subcommand,
} = MultitoolCli::parse();
// Fold --enable/--disable into config overrides so they flow to all subcommands.
let toggle_overrides = feature_toggles.to_overrides()?;
root_config_overrides.raw_overrides.extend(toggle_overrides);
```

注意 `--enable`/`--disable` 被翻译成 `-c features.<name>=true` 形式的配置覆盖，合并进 root 级覆盖集——功能开关和配置系统在这里合流，第 3 章会讲这些覆盖最终如何叠进 `Config`。

接下来是全长近 700 行的 `match subcommand`（`main.rs:1093-1830` 附近），每个臂对应一条产品路径。看三个最有代表性的臂。

**默认臂：`None` → TUI**（`main.rs:1093-1145`）：

```rust
// 来源：codex-rs/cli/src/main.rs:1092-1145（有删节）
let open_agents_overview = matches!(&subcommand, Some(Subcommand::Agents(_)));
match subcommand {
    None | Some(Subcommand::Agents(_)) => {
        prepend_config_flags(
            &mut interactive.config_overrides,
            root_config_overrides.clone(),      // ← root 级 -c 覆盖并入 TUI 参数
        );
        // ... `codex agents` 专属的一系列前置校验（remote 冲突、prompt 拒收等）
        let exit_info = run_interactive_tui(
            interactive,
            root_remote.clone(),
            root_remote_auth_token_env.clone(),
            arg0_paths.clone(),
        )
        .await?;
        handle_app_exit(exit_info)?;
    }
```

`codex` 无参数和 `codex agents` 共用同一条 TUI 路径，只是后者会先把 `interactive.agents_overview` 置位。root 级与子命令级的配置覆盖合并后，控制权交给 `run_interactive_tui`。

**exec 臂**（`main.rs:1146-1161`）：

```rust
// 来源：codex-rs/cli/src/main.rs:1146-1161
Some(Subcommand::Exec(mut exec_cli)) => {
    reject_remote_mode_for_subcommand(
        root_remote.as_deref(),
        root_remote_auth_token_env.as_deref(),
        "exec",
    )?;
    exec_cli
        .shared
        .inherit_exec_root_options(&interactive.shared);   // ← 继承顶层 -m 等共享选项
    exec_cli.strict_config |= root_strict_config;
    prepend_config_flags(
        &mut exec_cli.config_overrides,
        root_config_overrides.clone(),
    );
    codex_exec::run_main(exec_cli, arg0_paths.clone()).await?;
}
```

每个臂做三件事的模式是一致的：**校验非法组合 → 继承/合并 root 级选项 → 调对应 crate 的 `run_main`**。`codex exec` 的完整无头事件处理在[第 16 章](ch16-exec.md)。

**mcp-server 臂**（`main.rs:1183-1198`）值得单独看一眼，因为它纠正一个第 1 章可能留下的印象：

```rust
// 来源：codex-rs/cli/src/main.rs:1183-1198
Some(Subcommand::McpServer(McpServerCommand { strict_config })) => {
    eprintln!(
        "warning: `codex mcp-server` is deprecated and will be removed in a future release."
    );
    reject_remote_mode_for_subcommand(
        root_remote.as_deref(),
        root_remote_auth_token_env.as_deref(),
        "mcp-server",
    )?;
    codex_mcp_server::run_main(
        arg0_paths.clone(),
        root_config_overrides,
        strict_config || root_strict_config,
    )
    .await?;
}
```

在本基线（`4f39251a01`）上，`codex mcp-server` **已被标记弃用**，启动即打印警告。它的实现仍在 `codex-rs/mcp-server/src/lib.rs:62` 的 `run_main`（加载 `Config`、起 stdio JSON-RPC 服务），[第 12 章](ch12-mcp.md)讲 MCP 生态时会以它为例，但你要知道这条产品形态正在向 app-server 体系收敛。

### 第五段：TUI 入口——默认路径的终点

`run_interactive_tui`（`main.rs:2559-2655` 附近）是 CLI 分发的最后一棒。它先做几件“启动前体检”：

```rust
// 来源：codex-rs/cli/src/main.rs:2559-2586（有删节）
async fn run_interactive_tui(
    mut interactive: TuiCli,
    remote: Option<String>,
    remote_auth_token_env: Option<String>,
    arg0_paths: Arg0DispatchPaths,
) -> std::io::Result<AppExitInfo> {
    if let Some(prompt) = interactive.prompt.take() {
        // Normalize CRLF/CR to LF so CLI-provided text can't leak `\r` into TUI state.
        interactive.prompt = Some(prompt.replace("\r\n", "\n").replace('\r', "\n"));
    }

    let terminal_info = codex_terminal_detection::terminal_info();
    if terminal_info.name == TerminalName::Dumb {
        if !(std::io::stdin().is_terminal() && std::io::stderr().is_terminal()) {
            return Ok(AppExitInfo::fatal(
                "TERM is set to \"dumb\". Refusing to start the interactive TUI because no terminal is available for a confirmation prompt (stdin/stderr is not a TTY). Run in a supported terminal or unset TERM.",
            ));
        }
        // ... 有 TTY 时降级为警告 + 交互确认
    }
```

然后是交接，以及一个容易忽略的恢复循环：

```rust
// 来源：codex-rs/cli/src/main.rs:2611-2628
let start_tui = || {
    codex_tui::run_main(
        interactive.clone(),
        arg0_paths.clone(),
        codex_config::LoaderOverrides::default(),
        remote_endpoint.clone(),
    )
};
let mut attempted_backups = HashSet::new();
loop {
    // Keep the large TUI future out of the CLI dispatcher's stack frame.
    let err = match Box::pin(start_tui()).await {
        Ok(exit_info) => return Ok(exit_info),
        Err(err) => err,
    };
    let Some(startup_error) = local_state_db::startup_error(&err) else {
        return Err(err);
    };
    // ... state_db 损坏时：备份旧库 → 询问用户 → 重建并重试
}
```

这个 `loop` 的存在是为了本地 sqlite state_db 的自动恢复：TUI 启动若因数据库损坏失败，CLI 层会把损坏文件挪进备份目录、征得用户同意后重建，然后**再试一次**（每个数据库只重试一次，`attempted_backups` 去重防死循环）。state_db 本身属于[第 13 章](ch13-persistence.md)的内容，这里只需记住：CLI 层不只是转发参数，还承担了“启动失败的外科手术”。

`codex_tui::run_main`（`tui/src/lib.rs:929-952`）的签名与 exec 版几乎对称：

```rust
// 来源：codex-rs/tui/src/lib.rs:929-952（有删节）
pub async fn run_main(
    cli: Cli,
    arg0_paths: Arg0DispatchPaths,
    loader_overrides: LoaderOverrides,
    explicit_remote_endpoint: Option<RemoteAppServerEndpoint>,
) -> std::io::Result<AppExitInfo> {
    match startup_orchestration::run_main_inner(
        cli,
        arg0_paths,
        loader_overrides,
        explicit_remote_endpoint,
    )
    .await
    {
        Err(err) if startup_draft::StartupCancelled::matches(&err) => Ok(AppExitInfo {
            // ... 用户在启动流程中取消 → 视为 UserRequested 正常退出
        }),
        result => result,
    }
}
```

TUI 自己的 `Cli` 参数结构在 `tui/src/cli.rs:10-80`：`prompt`、`--search`、`--ask-for-approval`，以及一堆 `#[clap(skip)]` 的内部字段（`resume_picker`、`fork_last` 等）——它们不在 `codex --help` 里出现，是 `codex resume`/`codex fork` 这些顶层子命令“借道”TUI 参数结构传递意图的暗管。`startup_orchestration::run_main_inner` 接手后的第一件事就是加载配置（`startup_orchestration.rs:111` 的 `load_config_or_exit`）——那里是[第 3 章](ch03-config.md)的起点。

TUI 跑完返回 `AppExitInfo`（token 用量、thread id、恢复提示、是否有待执行的更新），由 `main.rs` 的 `handle_app_exit`（`main.rs:816-838`）统一打印收尾信息、按 `ExitReason` 决定退出码、必要时执行自我更新。至此，从 npm 壳到屏幕上的 TUI，链路闭合。

## 设计取舍

**为什么需要 npm 壳，而不是直接发布原生二进制？**

对照你自己的 my-agent：`npm i -g my-agent` 之后 `node` 直接跑你的 JS，没有平台问题，因为 Node 就是运行时。Codex 选择了无运行时依赖的原生二进制（第 1 章讲过原因：沙箱、进程控制、延迟），代价是 npm 这个分发渠道天生不擅长发二进制。npm 壳 + `optionalDependencies` 平台分包是社区已经验证过的折中（esbuild、swc、biome 同款）：用户侧的体感仍是熟悉的 `npm i -g`，包管理器按 `os`/`cpu` 自动剪枝，壳脚本只留几百行 JS 负责定位与让渡。替代方案——Homebrew/安装脚本/`curl | sh`——把安装方式碎片化，而 npm 壳让 `codex update` 始终知道自己该怎么自我更新（靠 `CODEX_MANAGED_BY_*` 环境变量回传安装方式）。代价是链路里多了一个 Node 进程常驻陪护，以及信号转发这种只有在“父进程是壳”时才会出现的边角问题。

**为什么要“陪护式 spawn”，而不是 `execvp` 直接替换进程？**

Unix 上 npm 壳理论上可以 `exec` 掉自己，让 Rust 二进制原位接管，省掉信号转发。没那么做的原因在 Windows：Node 的 `spawn` 是跨平台一致的抽象，而 `exec` 语义在 Windows 上并不存在；同时陪护进程让“退出码/信号镜像”逻辑有一个统一的落点。这是用一点点进程开销换跨平台行为一致性的典型取舍。

**为什么用 arg0 把戏，而不是干脆多编几个二进制？**

这是和你 my-agent 差异最大的一处。你的 Agent 如果需要“一个 helper 进程”，TS 里的自然做法是再写一个入口文件、构建产物里多一个 `dist/helper.js`，由父进程 `spawn(process.execPath, [helperPath])`。Codex 的选择是把所有 helper（`apply_patch`、`codex-linux-sandbox`、execve wrapper）都塞进**同一个二进制**，靠 argv[0]/argv[1] 分流。好处有三：发布物永远只有一个文件，不存在版本错配（helper 和主程序一定是同一次编译）；`apply_patch` 可以凭空出现在 PATH 上供模型生成的命令调用，用户无需安装任何额外工具（busybox 模式的经典收益）；沙箱 re-exec 自己时路径解析简单可信。代价都写在 `arg0/src/lib.rs` 里：临时目录、文件锁、看门人清理、Windows 上退化为 `.bat` + 隐藏 flag 的两套实现——约 500 行“管道工代码”换一个干净的对外形态。对你的 my-agent 来说，这个取舍大概率不划算——单进程、无沙箱需求时，多入口文件简单直白；但一旦你开始做命令隔离（第 11 章会讲为什么生产级 Agent 必须做），“helper 与主程序同源同版本”这条约束会把你推向类似的单二进制设计。

**为什么分发是两层的（arg0 然后 clap），不合成一层？**

因为两层回答的是不同的问题。arg0 回答“**我这个进程是谁**”：是被内核拉起的沙箱助手？是被 shell 命令调用的补丁工具？这些是**非自愿**的身份——调用方（模型生成的命令、bubblewrap 的 re-exec）不会配合你传复杂的参数协议，只会给一个名字或一个固定 flag。clap 回答“**用户想干什么**”：这是**自愿**的、面向人类的丰富 CLI 语法。把“身份识别”放在 clap 之前，还有一个时序理由：arg0 分支在任何线程、任何 tokio runtime 创建之前执行，沙箱助手这种对进程环境极度敏感的代码得以在“一张白纸”的状态下接管进程。

**默认子命令内联（flatten TuiCli）而不是 `codex tui`？**

`claude` 与 `codex` 都把最高频路径做成了零子命令。代价前面已经看到：`subcommand_negates_reqs`、`SessionTuiCli` 这种手工包装（`main.rs:427-451`，为了让 `--last PROMPT` 合法而 `--last SESSION_ID PROMPT` 非法）、以及 root 级选项向各子命令的逐个继承（`inherit_exec_root_options`、`prepend_config_flags`）。这些“合并覆盖”的样板代码是每个臂开头的固定三行，是“顶层参数即 TUI 参数”设计在代码里留下的税。

**坦诚的局限。** 这条链路并不优雅的部分同样值得记录：`main.rs` 本体 4800+ 行，分发 `match` 近 700 行，子命令的选项继承全靠手工调用、漏一处就是一个隐蔽 bug；arg0 的临时目录方案依赖文件锁启发式，极端情况（锁文件损坏、CODEX_HOME 位于 tmp）只能靠 warning 兜底（`arg0/src/lib.rs:186-192` 明确选择“警告并继续”而不是硬失败——可用性优先于严格性）；`mcp-server` 这样的弃用子命令仍占据分发表的位置，说明形态收敛落后于代码演进。

## 动手实验

以下命令都是只读观察（在仓库根目录执行）。

**1. 看 npm 壳的全部内容：**

```shell
ls codex-cli/bin/          # 只有一个 codex.js——安装包里没有任何原生二进制
cat codex-cli/package.json # 注意 bin 与 files 字段
```

**2. 找平台分包的注入点：**

```shell
rg -n "optionalDependencies" codex-cli/scripts/build_npm_package.py
# 预期：命中 296 行附近——发布时才注入，源码 package.json 里看不到
```

**3. 看二进制的分发表现：**

```shell
cargo run --bin codex -- --help
# 预期输出顶部：Usage: codex [OPTIONS] [PROMPT]
#                     codex [OPTIONS] <COMMAND> [ARGS]
# 子命令列表对应 main.rs 的 Subcommand 枚举（exec/login/mcp/app-server/...）
# 注意没有 tui 子命令——TUI 是 None 分支的默认形态
```

**4. 观察 arg0 分发的判定表：**

```shell
rg -n "exe_name ==|argv1 ==" codex-rs/arg0/src/lib.rs
# 预期：看到 codex-execve-wrapper / codex-linux-sandbox / apply_patch /
#       applypatch / --codex-run-as-apply-patch 等判定常量
rg -n "arg0_dispatch_or_else" codex-rs --type rust -g '!target'
# 预期：cli/src/main.rs 以及其它需要 helper 的二进制入口都在用它
```

**5. 亲眼看到 PATH 别名目录**（需要本机已装 codex）：

```shell
# 在一个终端里启动 codex TUI，另一个终端执行：
ls -la ~/.codex/tmp/arg0/*/
# 预期：每个活跃会话一个 codex-arg0-XXXXXX 目录，里面是
#       apply_patch、applypatch、codex-linux-sandbox（Linux）、
#       codex-execve-wrapper 这几个指向 codex 二进制的符号链接，外加 .lock
readlink ~/.codex/tmp/arg0/*/apply_patch   # 指向 codex 本体
```

**6. 顺着分发找终点：**

```shell
rg -n "pub async fn run_main" codex-rs/tui/src/lib.rs codex-rs/exec/src/lib.rs codex-rs/mcp-server/src/lib.rs
# 预期：三个产品形态各自的 run_main 签名——注意它们都接收 Arg0DispatchPaths
```

## Rust 侧栏

- **clap derive 宏**：`#[derive(Parser)]` 让结构体字段直接声明 CLI 参数，`#[derive(Subcommand)]` 让枚举变体成为子命令。`#[clap(flatten)]` 把另一个参数结构的字段“摊平”进当前结构（`MultitoolCli` 摊平了 `TuiCli`，所以无子命令时顶层参数就是 TUI 参数）；`#[clap(skip)]` 字段不参与解析，留给代码内部传递状态（如 `resume_picker`）。
- **`#[cfg(...)]` 条件编译**：按目标平台在编译期裁剪代码。本章里 `#[cfg(target_os = "linux")]` 决定要不要创建 `codex-linux-sandbox` 链接、`#[cfg(unix)]` 决定用 symlink 还是 `.bat`。它不是运行期 `if`——不满足条件的代码根本不进二进制。
- **`anyhow::Result` 与 `?`**：`main() -> anyhow::Result<()>` 允许 `main` 返回错误，运行时自动打印并置非零退出码；函数体内的 `?` 把 `Err` 提前返回，是 Rust 错误传播的标准写法。应用的“边界”（`main`、各子命令入口）用 `anyhow` 聚合各种错误，库内部才定义精确错误类型。
- **RAII guard**：`Arg0PathEntryGuard` 持有 `TempDir` 与锁文件，析构（Drop）时自动清理临时目录。`arg0_dispatch_or_else` 特意把 guard 传进 future、等 `main_fn` 结束才 `drop`——注释明说“让别名目录活到异步入口跑完”。资源生命周期跟着值走，是 Rust 替代 try/finally 的方式。
- **`unsafe { std::env::set_var(...) }`**：新版 Rust 把 `set_var` 标为 `unsafe`，因为多线程下改环境变量可能踩到其它线程正在读取的内存。arg0 代码在调用点写明“此时进程还是单线程，所以安全”——这也是 dotenv 加载、PATH 修改必须排在 tokio runtime 创建**之前**的原因。
- **显式线程 + `Runtime::block_on`**：tokio 没有隐式全局运行时，`main`（同步函数）要自己 `new_multi_thread()` 建运行时，再 `block_on` 一个异步 future。`std::thread::Builder::stack_size(16 MiB)` 先起一个大栈线程再 `block_on`，是为了避免顶层 future 的状态机撑爆主线程默认的 8 MiB 栈。

## 小结 + 思考题

`codex` 命令的启动是一条三段式链路：npm 壳（JS）按平台选二进制并陪护式 spawn；arg0 层按 argv[0]/argv[1] 识别沙箱助手、apply_patch 等特殊身份，正常形态则加载 dotenv、建 PATH 别名、搭 tokio 运行时；clap 层把子命令分发到 TUI（默认）、exec、app-server 等 crate 的 `run_main`。三层各自解决“分发渠道”“单二进制多形态”“用户意图路由”三个不同的问题，把任何两层合并都会顾此失彼。下一章进入所有路径的汇合点：配置系统如何把这些 CLI 参数、`config.toml`、profile 叠加成一份 `Config`。

思考题：

1. `codex.js` 为什么必须用异步 `spawn` 而不能用 `spawnSync`？如果用了，你在 TUI 里按 Ctrl-C 会发生什么连锁反应？（提示：回看 `codex.js:112-116` 的注释，再想终端 raw mode 由谁恢复。）
2. `arg0_dispatch()` 里对 `~/.codex/.env` 的加载为什么要过滤 `CODEX_` 前缀的变量？如果不过滤，本章讲的哪一环会被用户配置攻破？
3. 假如你的 my-agent 要给“模型生成的 shell 命令”提供一个 `apply_patch` 工具命令，在 Node 生态里你有哪几种做法？各自和 Codex 的 symlink + argv[0] 方案相比，版本一致性如何保证？
4. `Subcommand::Review`（`main.rs:1162-1182`）没有自己的运行器，而是构造一个 `ExecCli` 再设 `command = Some(ExecCommand::Review(...))` 调 `codex_exec::run_main`。这种“子命令复用另一个子命令的入口”做法有什么好处？什么时候会反噬？
