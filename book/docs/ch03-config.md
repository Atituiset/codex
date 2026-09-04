# 第 3 章 配置系统：ConfigToml 与 Config 的两级世界

## 本章导读

在[第 2 章](ch02-startup.md)走启动链路时，我们在 `codex-rs/tui/src/startup_orchestration.rs:111` 见过一个调用：`load_config_or_exit(...)`。它是 TUI 拿到运行时配置的唯一入口，也是本章的终点。现在把它拆开。

配置系统要解决的真实问题，远比「读一个 TOML 文件」复杂。同一个配置项——比如 `model`——在 Codex 里可能同时出现在近十个地方：二进制内嵌的出厂默认、`/etc/codex/config.toml` 系统级配置、`~/.codex/config.toml` 用户配置、`--profile` 选中的 profile 文件、项目目录里的 `.codex/config.toml`、命令行的 `-c key=value` 覆盖、企业管理员下发的受管配置……这些来源必须排出一个明确的优先级，合并成一份「生效配置」，而且每一步都要记住「这个值是谁给的」，因为有些来源（比如项目目录里的配置）天然不可信，有些来源（企业受管配置）则必须凌驾于用户的一切选择之上。

如果你在自己的 my-agent 里写过配置加载，大概率是「读 JSON/YAML → 和环境变量 merge → 完事」的单层模型。Codex 的答案是一个**两级模型**：`ConfigToml` 是对 TOML 文本的忠实反序列化（纸上世界，字段几乎全是 `Option`），`Config` 是运行时装配完成的最终形态（落地世界，默认值、约束、覆盖全部生效）。两级之间还夹着一个中间层：**先把所有来源合并成一棵 TOML 值树，再做类型化反序列化**。为什么不是读完就直接 `serde` 进结构体？这正是本章要回答的核心设计问题。

顺带一提，本章所有引用基于基线 commit `4f39251a01`。这个基线上的配置系统刚经历过一轮大重构：独立的 `codex-config` crate（`codex-rs/config/`）承担了分层加载的全部职责，老式的 `profile = "name"` 选择器已被移除。书中讲的是重构后的形态。

## 源码地图

| 文件 | 职责 | 一句话点评 |
|------|------|-----------|
| `codex-rs/config/src/config_toml.rs` | `ConfigToml` 定义：config.toml 的类型化镜像 | 近百个字段、几乎全 `Option` 的「大平层」结构体 |
| `codex-rs/config/src/config_layer_source.rs` | `ConfigLayerSource` 枚举与优先级数值 | 九类来源各拿一个 `precedence()` 分数，全章的「宪法」 |
| `codex-rs/config/src/loader/mod.rs` | `load_config_layers_state()`：按优先级装配层栈 | 本章最重的函数，层层 `push` 出完整层栈 |
| `codex-rs/config/src/merge.rs` | `merge_toml_values()`：TOML 值树的深合并 | 表递归合并、标量与数组整体替换 |
| `codex-rs/config/src/overrides.rs` | 把 `-c` 的点路径覆盖折叠成一层 TOML | `model="o3"` 变成 `{model: "o3"}` 这棵树 |
| `codex-rs/config/src/state.rs` | `ConfigLayerStack`：有序的层集合 + `effective_config()` | 合并发生的地方，还顺手校验层序 |
| `codex-rs/config/src/schema.rs` | 从 `ConfigToml` 生成 JSON Schema | 文档/编辑器提示与代码同步的关键 |
| `codex-rs/config/defaults.toml` | 内嵌进二进制的出厂默认层 | 优先级最低的一层，编译期 `include_str!` 进去 |
| `codex-rs/core/src/config/mod.rs` | `Config`、`ConfigBuilder`、`ConfigOverrides` | 两级模型中「落地」的那一级 |
| `codex-rs/features/src/lib.rs` | `Feature` 注册表、`Features` 求解、`FeaturesToml` | 功能开关的单一事实来源 |
| `codex-rs/cli/src/main.rs` | `-c/--config`、`--enable/--disable`、`--profile` 的 clap 入口 | 覆盖语法的起点 |
| `codex-rs/utils/cli/src/config_override.rs` | `CliConfigOverrides`：`-c` 原始字符串的收集与解析 | 故意推迟解析，值先当 TOML 试、失败当裸字符串 |
| `codex-rs/utils/home-dir/src/lib.rs` | `find_codex_home()`：`CODEX_HOME` 环境变量 | 环境变量参与配置系统的正门 |
| `codex-rs/core/src/bin/config_schema.rs` | `codex-write-config-schema` 二进制 | `just write-config-schema` 背后的可执行文件 |

## 核心数据结构

### ConfigToml：纸上世界

`ConfigToml` 是 `config.toml` 文本的类型化镜像。它巨大、扁平，而且有一个贯穿始终的特征——**几乎所有字段都是 `Option<T>`**：

```rust
// 来源：codex-rs/config/src/config_toml.rs:152-176（节选）
/// Base config deserialized from ~/.codex/config.toml.
#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq, JsonSchema)]
#[schemars(deny_unknown_fields)]
pub struct ConfigToml {
    /// Optional override of model selection.
    pub model: Option<String>,     // ← None = "任何一层都没写过这个键"

    /// Provider to use from the model_providers map.
    pub model_provider: Option<String>,

    /// Default approval policy for executing commands.
    #[schemars(with = "Option<crate::schema::ConfigAskForApproval>")]
    pub approval_policy: Option<AskForApproval>,

    /// Sandbox mode to use.
    pub sandbox_mode: Option<SandboxMode>,
    // ... 后面还有近百个字段，一路排到 520 行
}
```

为什么全用 `Option`？因为 `ConfigToml` 的职责是**如实记录"层叠合并后的 TOML 里有没有这个键"**，而不是给出最终答案。`None` 携带信息——「用户没表达过意图」——这样下游 `Config` 才能放心地填默认值，而不用担心把「用户显式写的值」和「默认值」混淆。这个区分在企业受管场景里是要命的：管理员要求 `approval_policy = "never"` 时，系统必须能分辨用户是真的想覆盖，还是根本没写过。

注意结构体上的 `JsonSchema` derive 和 `#[schemars(deny_unknown_fields)]`——它们不参与运行时，只为 schema 生成服务，后面「schema 生成」一节会回来讲。

`ConfigToml` 里还保留着两个与 profile 相关的字段：

```rust
// 来源：codex-rs/config/src/config_toml.rs:318-323
/// Profile to use from the `profiles` map.
pub profile: Option<String>,     // ← 旧式选择器，本基线上写了会直接报错

/// Named profiles to facilitate switching between different configurations.
#[serde(default)]
pub profiles: HashMap<String, ConfigProfile>,
```

以及集中管理功能开关的 `features` 表：

```rust
// 来源：codex-rs/config/src/config_toml.rs:460-464
/// Centralized feature flags (new). Prefer this over individual toggles.
#[serde(default)]
// Injects known feature keys into the schema and forbids unknown keys.
#[schemars(schema_with = "crate::schema::features_schema")]
pub features: Option<FeaturesToml>,
```

`features_schema` 是个自定义 schema 函数，后面会看到它如何把 `Feature` 注册表里的键注入 JSON Schema。

### ConfigLayerSource：九类来源的优先级数值

整个配置系统的优先级不靠散落的 `if` 判断，而是收敛在一个函数里——每种来源拿一个整数分数，分高者赢：

```rust
// 来源：codex-rs/config/src/config_layer_source.rs:30-52
impl ConfigLayerSource {
    /// A setting from a layer with a higher precedence overrides a setting
    /// from a layer with a lower precedence.
    pub fn precedence(&self) -> i16 {
        match self {
            ConfigLayerSource::PackagedDefaults { .. } => -10, // ← 内嵌出厂默认，垫底
            ConfigLayerSource::Mdm { .. } => 0,           // ← macOS 受管偏好
            ConfigLayerSource::System { .. } => 10,       // ← /etc/codex/config.toml
            ConfigLayerSource::EnterpriseManaged { .. } => 15, // ← 企业云配置包
            ConfigLayerSource::User { profile, .. } => {
                if profile.is_some() {
                    21                                    // ← --profile 选中的层
                } else {
                    20                                    // ← ~/.codex/config.toml
                }
            }
            ConfigLayerSource::Project { .. } => 25,      // ← 项目内 .codex/config.toml
            ConfigLayerSource::SessionFlags => 30,        // ← -c / --enable / --disable
            ConfigLayerSource::LegacyManagedConfigTomlFromFile { .. } => 40,
            ConfigLayerSource::LegacyManagedConfigTomlFromMdm => 50, // ← 管理员兜底
        }
    }
}
```

这张表值得逐行读。它回答了几个新手常会问错的问题：

- **profile 不是独立机制，而是用户层之上的第二个用户层**（20 → 21）。profile 文件只需要写差异，其余键自然从基础 `config.toml` 继承。
- **项目层（25）高于用户层（20）**：项目可以调整本仓库特有的行为，但——
- **会话标志（30）又压过项目层**：你在命令行敲的 `-c` 永远赢过仓库里提交的配置文件。
- **最顶端是两层 LegacyManaged（40/50）**：企业管理员下发的配置凌驾于一切，包括用户的命令行参数。这是一个刻意的「倒挂」，设计取舍一节再展开。

每一层被物化为 `ConfigLayer`，带着来源、版本和一份以 JSON 值形态保存的配置内容（`config_layer_source.rs:70-76`）。层的集合是 `ConfigLayerStack`：

```rust
// 来源：codex-rs/config/src/state.rs:246-254（节选）
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ConfigLayerStack {
    /// Layers are listed from lowest precedence (base) to highest (top), so
    /// later entries in the Vec override earlier ones.
    layers: Vec<ConfigLayerEntry>,     // ← 从低到高排序，越靠后越"说了算"

    /// Constraints that must be enforced when deriving a [Config] from the
    /// layers.
    requirements: ConfigRequirements,  // ← 管理员约束，与配置层并行的轨道
    // ...
}
```

`ConfigLayerStack::new` 会调用 `verify_layer_ordering`（`state.rs:527-533`）断言 `layers` 严格按 `precedence()` 升序——顺序错了直接在构造期报错，而不是等到合并出一个莫名其妙的结果。

### Config：落地世界

`Config` 是运行时真正使用的形态，定义在 `codex-rs/core/src/config/mod.rs:600` 起。和 `ConfigToml` 对比着看最有意思：

```rust
// 来源：codex-rs/core/src/config/mod.rs:600-632（节选）
pub struct Config {
    /// Provenance for how this [`Config`] was derived (merged layers + enforced
    /// requirements).
    pub config_layer_stack: ConfigLayerStack, // ← 保留层栈，可查每个值的来源

    /// Optional override of model selection.
    pub model: Option<String>,

    /// Key into the model_providers map that specifies which provider to use.
    pub model_provider_id: String,         // ← 已解析成具体 id，不再是 Option

    /// Info needed to make an API request to the model.
    pub model_provider: ModelProviderInfo, // ← 连 provider 记录都查好了

    /// Whether `AgentReasoning` events emitted by the backend will be
    /// suppressed from the frontend output.
    pub hide_agent_reasoning: bool,        // ← Option<bool> 落地为 bool
    // ...
}
```

三种「落地」方式一目了然：`Option<String>` 保持 `Option`（`model` 真的可以不设，由模型管理器后续决定）；需要确定值的字段填上默认值（`hide_agent_reasoning: bool`，默认 `false`）；需要查表的字段直接物化（`model_provider: ModelProviderInfo`，从 `model_providers` map 里按 id 查出来，查不到在构建期就报错，详见[第 4 章](ch04-auth-model.md)）。另外注意 `Config` 把整个 `config_layer_stack` 背在身上——运行时随时可以追问「这个值来自哪一层」，TUI 的配置展示和错误诊断都靠它。

`Config` 里还有一类字段来自功能开关：`pub features: ManagedFeatures`（`mod.rs:1042`）。它的原料是 `features` crate 里的注册表：

```rust
// 来源：codex-rs/features/src/lib.rs:819-841（节选）
/// Single, easy-to-read registry of all feature definitions.
#[derive(Debug, Clone, Copy)]
pub struct FeatureSpec {
    pub id: Feature,
    pub key: &'static str,      // ← config.toml 里的键名，如 "unified_exec"
    pub stage: Stage,           // ← UnderDevelopment / Experimental / Stable...
    pub default_enabled: bool,  // ← 未配置时的默认值
}

pub const FEATURES: &[FeatureSpec] = &[
    // Stable features.
    FeatureSpec {
        id: Feature::ShellTool,
        key: "shell_tool",
        stage: Stage::Stable,
        default_enabled: true,
    },
    // ...
];
```

`FEATURES` 是一张静态注册表：每个开关的键名、生命周期阶段（`Stage`）、默认值全部集中在一处。它是功能开关的**单一事实来源**——schema 生成、`--enable` 校验、运行时求解都从这张表出发。

`FeaturesToml`（`features/src/lib.rs:704-735`）是 `[features]` 表的反序列化形态，值得一看的是它的收尾字段：

```rust
// 来源：codex-rs/features/src/lib.rs:731-735（节选）
    pub network_proxy: Option<FeatureToml<NetworkProxyConfigToml>>,
    /// Boolean feature toggles keyed by canonical or legacy feature name.
    #[serde(flatten)]
    entries: BTreeMap<String, bool>,  // ← 其余所有键都落进这张布尔 map
}
```

带复杂配置的开关（如 `network_proxy`）有显式字段，普通的布尔开关则由 `#[serde(flatten)]` 一把兜进 `entries`。

## 流程走读

现在把整条链路走一遍。全景图：

```
命令行: codex --profile fast -c model="gpt-5.2" --enable unified_exec
   │
   ▼
cli/src/main.rs                        clap 解析命令行
   │  CliConfigOverrides.raw_overrides  ← 原样收集 -c 字符串
   │  FeatureToggles::to_overrides()    ← --enable 翻成 features.X=true
   ▼
CliConfigOverrides::parse_overrides()  "k=v" → (点路径, toml::Value)
   │
   ▼
tui: load_config_or_exit()             tui/src/lib.rs:1807
   │  只是 ConfigBuilder 的一层错误处理壳
   ▼
core: ConfigBuilder::build_inner()     core/src/config/mod.rs:1408
   │
   ├─► config::loader::load_config_layers_state()   装配层栈
   │      按 precedence 从低到高 push 九类来源
   │
   ├─► ConfigLayerStack::effective_config()         逐层深合并
   │      得到一棵合并后的 toml::Value 树
   │
   ├─► 反序列化为 ConfigToml            纸上世界（全 Option）
   │
   └─► Config::load_config_with_layer_stack()
          应用 requirements 约束 + ConfigOverrides + 默认值
   ▼
Config                                 落地世界，交给 Session 使用
```

### 第一段：命令行覆盖的收集与解析

`-c/--config` 的定义出奇地「懒」——它什么都不解析：

```rust
// 来源：codex-rs/utils/cli/src/config_override.rs:18-37（节选文档）
#[derive(Parser, Debug, Default, Clone)]
pub struct CliConfigOverrides {
    /// Override a configuration value that would otherwise be loaded from
    /// `~/.codex/config.toml`. Use a dotted path (`foo.bar.baz`) to override
    /// nested values. The `value` portion is parsed as TOML. If it fails to
    /// parse as TOML, the raw string is used as a literal.
    ///
    /// Examples:
    ///   - `-c model="o3"`
    ///   - `-c 'sandbox_permissions=["disk-full-read-access"]'`
    ///   - `-c shell_environment_policy.inherit=all`
    #[arg(
        short = 'c',
        long = "config",
        value_name = "key=value",
        action = ArgAction::Append,     // ← 可重复出现，全部收集
        global = true,                  // ← 对所有子命令生效
    )]
    pub raw_overrides: Vec<String>,     // ← 原始字符串，不是解析后的值
}
```

模块文档（`config_override.rs:1-8`）说得很明白：故意保持两半都**不解析**，让调用方决定如何解释右值。真正解析发生在 `parse_overrides()`（`config_override.rs:49-84`）：

```rust
// 来源：codex-rs/utils/cli/src/config_override.rs:53-83（节选）
let mut parts = s.splitn(2, '=');   // ← 只按第一个 '=' 切，值里可含 '='
// ... key/value 分别 trim、校验非空 ...

// Attempt to parse as TOML. If that fails, treat it as a raw
// string. This allows convenient usage such as
// `-c model=o3` without the quotes.
let value: Value = match parse_toml_value(value_str) {
    Ok(v) => v,                     // ← `42`、`true`、`["a","b"]` 都能识别
    Err(_) => {
        // Strip leading/trailing quotes if present
        let trimmed = value_str.trim().trim_matches(|c| c == '"' || c == '\'');
        Value::String(trimmed.to_string())   // ← 兜底：当裸字符串
    }
};

Ok((canonicalize_override_key(key), value))
```

`parse_toml_value` 的小技巧（`config_override.rs:95-102`）是把右值包成 `_x_ = <raw>` 再交给 TOML 解析器——这样 `-c model=o3` 这种没加引号的写法也能工作，而 `-c 'notify=["notify-send","Codex"]'` 又能拿到真正的数组类型。

`--enable` / `--disable` 则是覆盖语法的语法糖。它们被定义为一个独立的 clap 结构：

```rust
// 来源：codex-rs/cli/src/main.rs:960-969
#[derive(Debug, Default, Parser, Clone)]
struct FeatureToggles {
    /// Enable a feature (repeatable). Equivalent to `-c features.<name>=true`.
    #[arg(long = "enable", value_name = "FEATURE", action = clap::ArgAction::Append, global = true)]
    enable: Vec<String>,

    /// Disable a feature (repeatable). Equivalent to `-c features.<name>=false`.
    #[arg(long = "disable", value_name = "FEATURE", action = clap::ArgAction::Append, global = true)]
    disable: Vec<String>,
}
```

翻译逻辑直白（`main.rs:985-997`）：`--enable unified_exec` 变成字符串 `features.unified_exec=true`，并在翻译前用 `is_known_feature_key` 校验开关名是否存在于 `FEATURES` 注册表，拼错直接报错退出。然后在 `cli_main`（`main.rs:1059-1061`）里被合并进根级覆盖列表：

```rust
// 来源：codex-rs/cli/src/main.rs:1059-1061
// Fold --enable/--disable into config overrides so they flow to all subcommands.
let toggle_overrides = feature_toggles.to_overrides()?;
root_config_overrides.raw_overrides.extend(toggle_overrides);
```

也就是说，`--enable`/`--disable` 没有自己的通道，它们从这一刻起就和 `-c` 覆盖**完全同构**——后面所有代码只需要处理一种东西。这是减少特判的典型手法。

### 第二段：装配层栈

TUI 侧的 `load_config_or_exit`（`tui/src/lib.rs:1807-1851`）本身没有逻辑，只是把 CLI 解析结果交给 `ConfigBuilder`，失败时恢复终端并退出。真正的构建在 `ConfigBuilder::build_inner`（`core/src/config/mod.rs:1408-1479`）：

```rust
// 来源：codex-rs/core/src/config/mod.rs:1432-1478（节选）
let config_layer_stack = load_config_layers_state(
    LOCAL_FS.as_ref(),
    &codex_home,
    Some(cwd),
    &cli_overrides,                // ← 解析后的 (点路径, toml::Value) 列表
    ConfigLoadOptions { /* loader_overrides, strict_config, ... */ },
    thread_config_loader
        .as_deref()
        .unwrap_or(&codex_config::NoopThreadConfigLoader),
)
.await?;
let merged_toml = config_layer_stack.effective_config(); // ← 合并成一棵树

// 各层的相对路径已在装配期解析为绝对路径，这里可以安全地直接反序列化
let config_toml: ConfigToml = match merged_toml.try_into() { /* 错误处理略 */ };
Config::load_config_with_layer_stack(
    LOCAL_FS.as_ref(),
    config_toml,
    harness_overrides,             // ← --model、--sandbox 等结构化覆盖
    codex_home,
    config_layer_stack,
)
.await
```

装配层栈的 `load_config_layers_state`（`config/src/loader/mod.rs:128-514`）是本章最重的函数。它自己的文档注释（`loader/mod.rs:105-121`）就把层的顺序写清楚了：package → admin → system → cloud → user → profile → cwd/tree/repo（项目层）→ runtime。函数体基本上就是按这个顺序一路 `layers.push(...)`：

```rust
// 来源：codex-rs/config/src/loader/mod.rs:270-358（节选，有删节）
let mut layers = Vec::<ConfigLayerEntry>::new();
layers.push(packaged_defaults_layer);       // ← 出厂默认：内嵌 defaults.toml
// ...
layers.push(system_layer);                  // ← /etc/codex/config.toml
layers.extend(cloud_config_layers);         // ← 企业云配置包

// Add the base user config layer. When profile-v2 is selected, add the
// profile config as a second user layer on top so the profile only needs to
// contain overrides.
// ...
layers.push(base_user_layer);               // ← ~/.codex/config.toml

if active_user_file != base_user_file {
    layers.push(
        load_user_config_layer(/* ..., active_user_profile, ... */).await?,
    );                                      // ← ~/.codex/<name>.config.toml
}
// ... 中间是项目层发现（cwd/.codex、父目录、git root），存在信任检查 ...
// Add a layer for runtime overrides from the CLI or UI, if any exist.
if let Some(cli_overrides_layer) = cli_overrides_layer {
    layers.push(ConfigLayerEntry::new(
        ConfigLayerSource::SessionFlags,    // ← -c/--enable 生成的层
        cli_overrides_layer,
    ));
}
// ... 最后 push 两层 LegacyManagedConfigToml*，压在所有层之上 ...
```

出厂默认层在没有显式打包文件时来自编译期内嵌（`loader/mod.rs:169-182`）：`include_str!("../../defaults.toml")`。看一眼这个文件，就是 Codex 的「出厂设置」：

```toml
# 来源：codex-rs/config/defaults.toml（节选）
# Fixed defaults for packaged Codex clients.
include_permissions_instructions = true
include_environment_context = true
cli_auth_credentials_store = "file"
project_doc_max_bytes = 32768
file_opener = "vscode"
hide_agent_reasoning = false
project_root_markers = [".git"]

[history]
persistence = "save-all"
```

`-c` 覆盖如何变成一层？`build_cli_overrides_layer`（`config/src/overrides.rs:9-15`）把 `(点路径, 值)` 列表逐条种进一棵空的 TOML 树：`model="gpt-5.2"` 长成 `{model: "gpt-5.2"}`，`shell_environment_policy.inherit=all` 长成 `{shell_environment_policy: {inherit: "all"}}`。点路径逐段下钻、缺表建表的逻辑在 `apply_toml_override`（`overrides.rs:18-99`）。

**profile 的继承**也在这段发生。本基线的 profile 是「v2」形态：`--profile fast`（定义见 `cli/src/main.rs:466-468`，文档原文就是 `"Layer $CODEX_HOME/<name>.config.toml on top of the base user config"`）让 loader 把 `~/.codex/fast.config.toml` 作为第二个用户层压在基础 `config.toml` 之上（`loader/mod.rs:347-358`）。合并由后面统一的值树深合并完成，所以 profile 文件只需写差异键——这就是「继承」的全部实现，没有单独的继承语法。路径拼接本身只有几行：

```rust
// 来源：codex-rs/core/src/config/mod.rs:1894-1902（常量见 mod.rs:239）
pub fn resolve_profile_v2_config_path(
    codex_home: &Path,
    profile_name: &ProfileV2Name,
) -> AbsolutePathBuf {
    AbsolutePathBuf::resolve_path_against_base(
        format!("{profile_name}{CONFIG_PROFILE_V2_SUFFIX}"), // ← ".config.toml"
        codex_home,
    )
}
```

旧式写法在本基线被明确拒绝。如果你还在 `config.toml` 里写 `profile = "fast"`，构建期直接报错（`core/src/config/mod.rs:3257-3264`）：

```rust
// 来源：codex-rs/core/src/config/mod.rs:3257-3264
if let Some(profile) = cfg.profile.as_deref() {
    return Err(std::io::Error::new(
        std::io::ErrorKind::InvalidData,
        format!(
            "legacy `profile = \"{profile}\"` config is no longer supported; use `--profile {profile}` with `{profile}.config.toml` instead"
        ),
    ));
}
```

类型 `ConfigProfile`（`config/src/profile_toml.rs:22-72`，即 `[profiles.<name>]` 表）在代码里还存在，但全 workspace 已没有非测试代码消费它——保留类型只是为了反序列化兼容与错误提示。迁移存量配置时这是一个值得知道的坑。

**项目层与信任**。项目目录是「别人仓库里的内容」，天然不可信，所以 loader 对项目层做了两件事：其一，装配项目层之前要先判定项目信任状态（`loader/mod.rs:360-428`，未信任目录的项目层会被加载但禁用）；其二，有一张硬编码的黑名单（`loader/mod.rs:71-84`），项目层永远不许设置这些键：

```rust
// 来源：codex-rs/config/src/loader/mod.rs:67-84（节选）
// Project-local config comes from repository contents, so it should not get to
// choose where a user's credentials are sent or which local commands are run.
const PROJECT_LOCAL_CONFIG_DENYLIST: &[&str] = &[
    "openai_base_url",       // ← 不许把 API 请求指向攻击者的服务器
    "chatgpt_base_url",
    "model_provider",        // ← 不许偷换 provider（凭据会发给它）
    "model_providers",
    "notify",                // ← 不许注册任意本地命令
    "profile",
    "profiles",
    // ...
];
```

想想为什么：`notify` 是一条会被自动执行的命令，`chatgpt_base_url` 决定你的登录凭据发往哪里。如果 `git clone` 一个仓库就自动生效这些键，配置系统就成了远程代码执行的入口。沙箱与审批的整体安全模型在[第 11 章](ch11-sandbox-approval.md)展开，配置层的信任检查是它的第一道门。

**环境变量在哪？** 读者可能注意到层列表里没有「环境变量层」。Codex 的答案是：环境变量不直接参与层叠合并，它作用于更上游——`CODEX_HOME` 决定 `config.toml` 在哪个目录（`utils/home-dir/src/lib.rs:13-18`）：

```rust
// 来源：codex-rs/utils/home-dir/src/lib.rs:13-18
pub fn find_codex_home() -> std::io::Result<AbsolutePathBuf> {
    let codex_home_env = std::env::var("CODEX_HOME")
        .ok()
        .filter(|val| !val.is_empty());
    find_codex_home_from_env(codex_home_env.as_deref())
}
```

也就是说，环境变量选择的是「用哪套文件」，而不是「覆盖哪个键」。模型 API key 之类的环境变量（provider 配置里的 `env_key`）要到[第 4 章](ch04-auth-model.md)认证环节才读取，不在本章的合并链路里。

### 第三段：合并——在 TOML 值层面，而不是结构体层面

层栈装配完后，`effective_config()`（`config/src/state.rs:455-461`）做合并：

```rust
// 来源：codex-rs/config/src/state.rs:455-461
pub fn effective_config(&self) -> TomlValue {
    let mut merged = TomlValue::Table(toml::map::Map::new());
    for layer in self.layers_low_to_high() {
        merge_toml_values(&mut merged, &layer.config);
    }
    merged
}
```

注意合并的对象是 `toml::Value`——**动态的 TOML 值树，不是类型化结构体**。合并规则在 `merge_toml_values_at_path`（`config/src/merge.rs:75-121`）：

```rust
// 来源：codex-rs/config/src/merge.rs:94-121（节选）
if let TomlValue::Table(overlay_table) = overlay
    && let TomlValue::Table(base_table) = base
{
    // ... 键名规范化（别名、大小写、域名）略 ...
    for (key, value) in overlay_table {
        path.push(key.clone());
        if let Some(existing) = base_table.get_mut(&key) {
            merge_toml_values_at_path(existing, &value, path); // ← 表对表：递归
        } else {
            base_table.insert(key, normalized_with_key_aliases(&value, path));
        }
        path.pop();
    }
} else {
    *base = normalized_with_key_aliases(overlay, path); // ← 其它类型：整体替换
}
```

规则只有两条：**表（table）递归合并，其余一切（标量、数组）整体替换**。数组不拼接——用户层写 `notify = ["a"]` 会整个换掉系统层的 `notify = ["b", "c"]`，不会变成三个元素。这个「不聪明」的选择反而是对的：数组合并的语义谁也说不准（去重吗？顺序呢？怎么删除一个元素？），整体替换让每个键的最终值都能归因到唯一一层。

为什么不等反序列化成 `ConfigToml` 之后再用「结构体字段级 merge」？三个理由，都能在代码里找到落点：

1. **来源追踪**。`ConfigLayerStack::origins()`（`state.rs:466-475`）在值树上逐键记录「这个键最后由哪层写入」，生成 TUI 里「配置来源」展示和诊断信息。结构体一旦合并，字段级来源就丢了。
2. **逐层的路径解析**。每层加载时就地把自己的相对路径（如 `model_instructions_file = "./prompt.md"`）解析为相对于该层文件所在目录的绝对路径（`resolve_relative_paths_in_config_toml`，在 `loader/mod.rs:570` 等处调用）。如果先合并再解析，`./prompt.md` 到底相对哪个文件就说不清了。
3. **黑名单与校验在合并前作用于单层**。项目层黑名单、`strict-config` 的未知键检查，都需要「单层视角」；合并后的树里键已经混在一起，无法再区分是谁写的。

### 第四段：从 ConfigToml 到 Config

合并树反序列化为 `ConfigToml` 之后，`Config::load_config_with_layer_stack`（`core/src/config/mod.rs:3121` 起）做最后落地。这个函数很长，但套路一致，看三个动作就够。

动作一：**应用管理员约束**。`requirements::apply_to_config`（`mod.rs:3160-3164` 调用）把 `ConfigRequirements`（由 `/etc/codex/requirements.toml`、MDM、企业云包等「要求层」组合而成，与配置层是平行的另一条轨道，见 `loader/mod.rs:90-103` 的文档）压到 `ConfigToml` 上。用户配置与要求冲突时，值被改回要求允许的取值，并追加一条启动警告——`apply_requirement_constrained_value`（`mod.rs:2119-2153`）的日志原文是 "configured value is disallowed by requirements; falling back to required value"。这就是为什么管理员层在优先级表最顶端：它不是参与竞争，而是**裁判**。

动作二：**应用结构化覆盖**。命令行里 `--model`、`--sandbox`、`--ask-for-approval` 这类有专属 flag 的选项不走 `-c` 的值树通道，而是被装进 `ConfigOverrides`（`mod.rs:2541-2573`）：

```rust
// 来源：codex-rs/core/src/config/mod.rs:2541-2548（节选）
pub struct ConfigOverrides {
    pub model: Option<String>,
    pub review_model: Option<String>,
    pub cwd: Option<PathBuf>,
    pub approval_policy: Option<AskForApproval>,
    pub approvals_reviewer: Option<ApprovalsReviewer>,
    pub sandbox_mode: Option<SandboxMode>,
    // ... 共二十余个字段
}
```

构建函数把它们整体解构（`mod.rs:3202-3229` 的 `let ConfigOverrides { ... } = overrides;`）——**穷尽式解构**让以后给 `ConfigOverrides` 加字段的人必须在这里处理它，编译器会盯着。这些覆盖在 `ConfigToml` 之上再生效一次，优先级高于所有文件层。

动作三：**求解功能开关**。`Features::from_sources`（`mod.rs:3271-3280` 调用，定义在 `features/src/lib.rs:592-614`）按「内置默认 → 配置表 → 覆盖」的顺序合成最终开关集：

```rust
// 来源：codex-rs/features/src/lib.rs:592-614（节选）
pub fn from_sources(
    base: FeatureConfigSource<'_>,
    profile: FeatureConfigSource<'_>,
    overrides: FeatureOverrides,
) -> Self {
    let mut features = Features::with_defaults(); // ← FEATURES 表的默认值

    for source in [base, profile] {
        // ... 老式兼容开关先折算 ...
        if let Some(feature_entries) = source.features {
            features.apply_toml(feature_entries); // ← [features] 表逐项开关
        }
    }

    overrides.apply(&mut features);               // ← 命令行覆盖最后压上
    features.normalize_dependencies(); // ← 如 code_mode_only 蕴含 code_mode
    features
}
```

在 core 的调用点，`base` 用的是合并后 `cfg.features`——profile 文件的 `[features]` 早在 TOML 值合并阶段就已经叠进去了，所以这里 `profile` 参数传的是默认值；这个参数留给那些自己分开构造两层配置来源的调用方。`with_defaults`（`features/src/lib.rs:426-439`）则只是遍历 `FEATURES` 注册表、把 `default_enabled` 为真的开关放进集合——注册表同时承担了「文档」与「默认值来源」两个角色。

最后 `ManagedFeatures::from_configured_with_warnings`（`mod.rs:3281-3285`）再把管理员的开关约束叠上去，得到 `Config.features`。运行时代码只问 `config.features.enabled(Feature::UnifiedExec)`，不关心它来自哪一层。

### schema 生成：文档与代码如何不失步

`codex-rs/core/config.schema.json` 不是手写的。生成链路是：

```
just write-config-schema                      justfile:177-178
   │  cargo run -p codex-core --bin codex-write-config-schema
   ▼
core/src/bin/config_schema.rs:13-19           薄 main：解析 --out 并落盘
   ▼
codex_config::schema::write_config_schema()   config/src/schema.rs:266-269
   ▼
config_schema()                               config/src/schema.rs:201-210
   │  schemars 从 ConfigToml 类型派生 draft-07 schema
   ▼
config.schema.json                            排序、美化后写盘
```

核心在 `config_schema()`（`config/src/schema.rs:201-210`）：

```rust
// 来源：codex-rs/config/src/schema.rs:201-210（节选）
pub fn config_schema() -> RootSchema {
    let mut schema = SchemaSettings::draft07()
        .with(|settings| {
            settings.option_add_null_type = false; // ← Option<T> 不生成 null
        })
        .into_generator()
        .into_root_schema_for::<ConfigToml>();     // ← 从类型派生整个 schema
    add_shell_environment_policy_constraints(&mut schema);
    schema
}
```

因为 schema 是从 `ConfigToml` 类型**派生**的，给配置加字段的人不可能忘记更新 schema——类型变了，重新跑一次 `just write-config-schema` 就行，仓库约定要求把生成文件的更新和代码改动放在同一次提交里，CI 会校验漂移。字段上的 `///` 文档注释会被 schemars 一并收进 schema 的 `description`，编辑器（VS Code 等）的悬停提示由此而来。

动态部分靠 `#[schemars(schema_with = "...")]` 钩子。`[features]` 表的键来自运行期注册表，`features_schema`（`config/src/schema.rs:42-158`）遍历 `FEATURES`，为每个开关生成属性（多数布尔开关直接 `subschema_for::<bool>()`，带配置的开关用对应的 `FeatureToml<T>` 类型），最后 `additional_properties = false`（`schema.rs:154`）封死未知键——于是编辑器里打错开关名会立刻被标红，而注册表里的新开关自动出现在提示里。

这个机制的深层收益：**`ConfigToml` 类型、JSON Schema、编辑器补全、用户文档四者共用同一份事实来源**。只要字段加了 `JsonSchema` derive，下游全部自动更新。

## 设计取舍

**为什么分 ConfigToml / Config 两级，而不是一个结构体？**

单结构体的诱惑很大——少一层转换，少一半字段定义。但两级各自解决了对方解决不了的问题。`ConfigToml` 全 `Option` 的设计保留了「用户是否表达过意图」这一信息，`#[serde(default)]` 与 `deny_unknown_fields`（schema 侧）让解析既宽容又可校验；而运行时需要的恰恰是消灭 `Option`——`Config.model_provider` 必须是查表后确定存在的 `ModelProviderInfo`，否则每一行使用配置的代码都要写一遍 `unwrap_or(default)` 或处理「没配 provider」的边角。两级的边界也划出了错误的归属：TOML 语法错、未知键、类型不匹配归 `ConfigToml` 层（能精确报出文件和行号，见 `diagnostics.rs`）；provider 不存在、约束冲突归 `Config` 层。混在一起的话，报错会统一变成"配置有问题"，排查体验完全不同。

**为什么在 TOML 值层合并，而不是读一个文件就反序列化一次？**

流程走读里给了三个技术理由（来源追踪、逐层路径解析、单层校验）。更根本的一条是：**部分配置不是合法的整体配置**。profile 文件只写 `model` 一个键，它反序列化成 `ConfigToml` 没有问题（全 `Option`），但如果每层都先类型化，合并就要写「`ConfigToml` 对 `ConfigToml` 的字段级 merge」——近百个字段的样板代码，而且每加一个字段都得记得更新 merge 函数。在值树层面合并，加字段永远不需要碰合并逻辑。代价是失去了编译期检查，合并代码要自己处理表/标量的形态匹配（`merge.rs` 里那些对 `multi_agent_v2` 之类路径的特判就是代价的具象化——布尔和表两种写法要互相迁就）。

**为什么管理员层压在命令行之上？**

直觉上「命令行优先级最高」是 Unix 传统。Codex 把 LegacyManaged（40/50）放在 SessionFlags（30）之上，是有意的安全倒挂：企业可以强制「approval 永不询问」「禁止某些 MCP server」，此时用户的 `-c` 覆盖必须无效。（提到 MCP 顺带说明：本基线上 `codex mcp-server` 子命令——即把 Codex 自身暴露为 MCP server 的形态——已标记弃用，`cli/src/main.rs:1184-1186` 会打印 deprecation warning；MCP 扩展生态本身在[第 12 章](ch12-mcp.md)展开。）`apply_requirement_constrained_value` 不回报错而是「改回允许值 + 启动警告」，也是同一个哲学的体现——配置系统是执行的辅助，不是对抗管理员的工具。对比之下，my-agent 的单文件配置根本没有「谁说了算」的概念，因为单机单用户场景里这个问题不存在；一旦你的 Agent 要进企业环境，这条轨道迟早要补。

**和 my-agent 的配置加载比，差在哪？**

my-agent（TypeScript）里典型的配置加载大致是：读 `~/.my-agent/config.json`，`Object.assign` 或 `lodash.merge` 叠上环境变量映射，再用 zod 校验一次。和 Codex 对比，四个差距是实质性的：

1. **来源维度**。my-agent 通常只有「文件 + 环境变量 + CLI」三个来源，合并顺序硬编码在一行 `merge(a, b, c)` 里；Codex 把来源建模成带 `precedence()` 分数的枚举，新加一种来源（比如本章的 EnterpriseManaged）只需要实现一个分数，插入位置由排序保证，`verify_layer_ordering` 会在构造期抓住顺序错误。TS 里等价的做法是给每个来源一个 `priority` 数字再 `sort`，成本极低，值得直接抄。
2. **来源追踪**。my-agent 合并完只剩一个对象，用户问「这个 model 哪来的」答不上来；Codex 的 `origins()` 逐键记录来源层。TS 里可以在 merge 时同步维护一份 `Map<path, source>`，一样是低成本高回报。
3. **schema 同步**。my-agent 用 zod 定义校验，文档里的字段表靠手维护，漂移是常态；Codex 从 `ConfigToml` 类型派生 JSON Schema，连 `[features]` 的键都从注册表注入。TS 生态里 `zod-to-json-schema` 能达到同样效果——关键是把「生成物」纳入 CI 漂移检查，像本仓库要求 lockfile/schema 与代码同提交那样。
4. **不可信层**。my-agent 大概没想过「clone 下来的仓库里放了个配置文件」是攻击面；Codex 用黑名单 + 信任门把项目层的能力削到最小。这是 Agent 工具特有的问题——配置里躺着「要执行的命令」和「凭据发往的地址」——做任何多来源配置都该先回答「哪层不可信」。

**本章的局限与演进痕迹**

这个系统并不优雅到底。`core/src/config/mod.rs` 四千七百多行，`Config` 与 `ConfigToml` 的字段高度重复，每加一个配置项要动两个结构体加若干解析代码——这是两级模型实打实的税。`merge.rs` 里针对 `multi_agent_v2` 和 `shell_environment_policy` 的路径特判说明「值树合并」遇到「同一键有两种形态」时并不通用。profile 从 `[profiles.x]` 表演进到独立文件层，旧选择器被硬报错移除，说明这套语义仍在快速演化——读上游更新时，配置章节的折旧率会比 Agent Loop 高。

## 动手实验

以下命令都在仓库根目录执行（`just` 任务的工作目录自动在 `codex-rs/`）。

先看一眼层栈的全貌，直接读代码比读文档快：

```shell
sed -n '90,125p' codex-rs/config/src/loader/mod.rs   # 层顺序的官方文档注释
rg -n "precedence" codex-rs/config/src/config_layer_source.rs
# 预期：看到 precedence() 函数里 -10 到 50 的分值表
```

观察功能开关的生效链路。`codex features list` 会加载真实配置并打印每个开关的解析结果：

```shell
cargo run --bin codex -- features list
# 预期输出形态（对齐的三列：键名、阶段、是否启用）：
#   unified_exec            stable       true
#   use_legacy_landlock     under development  false
#   ...
```

用一个隔离的 `CODEX_HOME` 做覆盖实验，不污染真实配置：

```shell
mkdir -p /tmp/codex-lab
printf '[features]\nunified_exec = false\n' > /tmp/codex-lab/config.toml
CODEX_HOME=/tmp/codex-lab cargo run --bin codex -- features list \
  | grep unified_exec
# 预期：unified_exec 行变成 false（用户层压过内置默认）

CODEX_HOME=/tmp/codex-lab cargo run --bin codex -- \
  --enable unified_exec features list | grep unified_exec
# 预期：又变回 true（SessionFlags 层压过用户层）
```

这正好演示了优先级表里的 20 → 30 这两级。再试 profile 继承：

```shell
printf '[features]\nunified_exec = true\n' > /tmp/codex-lab/fast.config.toml
CODEX_HOME=/tmp/codex-lab cargo run --bin codex -- \
  --profile fast features list | grep unified_exec
# 预期：true（profile 层 21 压过基础用户层 20 的 false）
```

验证旧式 profile 选择器被拒绝：

```shell
printf 'profile = "fast"\n' >> /tmp/codex-lab/config.toml
CODEX_HOME=/tmp/codex-lab cargo run --bin codex -- features list
# 预期：直接报错退出，错误信息含
#   legacy `profile = "fast"` config is no longer supported;
#   use `--profile fast` with `fast.config.toml` instead
```

`-c` 的值解析行为可以用一对命令对照：

```shell
CODEX_HOME=/tmp/codex-lab cargo run --bin codex -- -c model=o3 features list
# 预期：正常执行（o3 不是合法 TOML 值，回退为裸字符串）
# 若开关名拼错：--enable 通道在 validate_feature 直接报
# "Unknown feature flag"（main.rs:999-1005）；而 -c 写的未知键
# 要走到 strict 校验才会报错——对比两条通道的严格程度想想为什么。
```

最后看 schema 生成物：

```shell
rg -n '"unified_exec"' codex-rs/core/config.schema.json | head -3
# 预期：在 features 的属性表里找到该键，类型 boolean
just write-config-schema && git diff --stat codex-rs/core/config.schema.json
# 预期：基线上无 diff；改一个 ConfigToml 字段再跑一次即可看到漂移
```

## Rust 侧栏

本章用到的语言特性，最小必要说明：

- **派生宏驱动一切**：`ConfigToml` 头上同时挂着 `Serialize, Deserialize, JsonSchema` 等多个 derive（`config_toml.rs:153-155`）。`serde` 的 derive 负责 TOML ↔ 结构体，`schemars` 的 derive 负责类型 → JSON Schema。一份字段定义产出多种工件，是 Rust 生态「代码即事实来源」的典型玩法，相当于 TS 里 zod schema 同时生成类型和校验器，但发生在编译期。
- **`#[serde(flatten)]`**：`FeaturesToml.entries`（`features/src/lib.rs:733-734`）用它把「没匹配上显式字段的所有键」收进一个 map。反序列化时先匹配具名字段，剩余键平铺进 `entries`——适合「注册表 + 开放键集合」的场景。
- **`#[schemars(schema_with = "path::to::fn")]`**：schema 派生的逃生舱。字段类型本身表达不了的约束（如 `[features]` 的键来自运行期注册表）可以指定一个函数手工构造该字段的 schema（`config/src/schema.rs:42`）。serde 也有同形的 `serialize_with`/`deserialize_with`。
- **`include_str!`**：编译期把文件内容嵌进二进制（`loader/mod.rs:170` 内嵌 `defaults.toml`）。代价是文件改动必须重新编译才生效，换来的是单二进制分发时零外部依赖。
- **穷尽式解构**：`let ConfigOverrides { ... } = overrides;`（`mod.rs:3202-3229`）把结构体所有字段具名列出。以后有人给 `ConfigOverrides` 加字段，这里会编译错误，强制处理——用编译器当 checklist，比 code review 可靠。
- **`if let ... && let ...` 链**：`merge.rs:94-96` 的 `if let TomlValue::Table(a) = x && let TomlValue::Table(b) = y` 是 let-chain 语法，把两个模式匹配压进一个条件，只有都匹配才进入分支。在值树这种「形态不确定」的数据上比嵌套 `match` 清爽得多。

## 小结 + 思考题

本章拆解了 Codex 配置系统的三级管道：命令行（`-c`、`--enable/--disable` 同构为点路径覆盖）→ 层栈装配（九类来源各带 `precedence()` 分数，项目层受信任门与黑名单约束）→ TOML 值树深合并（表递归、其余替换）→ `ConfigToml`（全 `Option` 的反序列化层）→ `Config`（默认值落地、约束生效、开关求解的运行时层）。profile 的继承不过是「第二个用户层」；schema 生成让文档、编辑器提示与代码共用一份事实来源。

拿到 `Config` 之后，下一步是用它建认证与模型客户端——`model_provider_id`、`chatgpt_base_url` 这些字段将在[第 4 章](ch04-auth-model.md)变成真正的 HTTP 请求。

思考题：

1. `merge_toml_values` 对数组选择「整体替换」而不是拼接。如果改成拼接，`shell_environment_policy` 这类列表配置会出现什么无法表达的操作？（提示：去 `merge.rs:131-155` 看 Codex 自己怎么处理同类两难。）
2. 在 `config_layer_source.rs:33-52` 的优先级表里，`Mdm`（0）低于 `System`（10），但 `LegacyManagedConfigTomlFromMdm`（50）全场最高。结合 `loader/mod.rs:90-121` 的注释，说说新「requirements 轨道」和旧「managed 配置层」各自的定位，为什么不把两者合并成一个分数？
3. 如果让你给 my-agent 的配置系统加「来源追踪」，在 TS 里你会把 `Map<path, source>` 挂在哪？merge 函数返回二元组，还是包一个 class？各自在序列化（比如把配置展示给前端）时有什么麻烦？
4. `-c` 覆盖的键写错了（比如 `modle="o3"`），默认模式下会怎样？加上 `--strict-config` 呢？去 `config/src/strict_config.rs` 验证你的猜想，并评价「默认宽容、strict 报错」这个取舍对 CLI 工具是否合适。
