---
title: "Rust 异步系统中的优雅停止：CancellationToken 实战"
pubDatetime: 2026-04-22T14:00:00+08:00
description: "从 Ctrl+C 到运行时摘除单个数据源，用 CancellationToken 把停止信号描述清楚。"
tags:
  - Rust
  - 异步
  - tokio
---

写异步服务，启动逻辑人人上心，停止逻辑却总是最后写、最先出问题。不是不知道它重要——是"先把功能跑起来"这句话太好说了。然后某个凌晨两点，一条措辞严肃的告警短信替你完成了排期。

设想你维护着一个**实时数据采集服务**：同时从十几个上游接口拉数据，每个源有自己的连接、速率限制和处理逻辑。运营说某个源经常超时拖累整体，能不能运行时单独摘掉它；运维说每次发版要优雅停机，别让数据传到一半就断。

某天下午，运维按下 Ctrl+C。你的程序是怎么处理这个信号的？

## 停止信号的三种写法，以及它们各自的问题

### 第一种：直接掐死

```rust
tokio::signal::ctrl_c().await?;
process::exit(0);
```

两秒写完，两点收到告警。进程蒸发，十几个上游连接没来得及关，缓冲区里的数据没来得及落盘，数据库连接池等着被归还——全跟着进程一起消失了。这不叫停机，这叫跑路。

### 第二种：broadcast channel 广播

稍微负责任一点——起一个 `broadcast` channel，让各任务通过 `subscribe()` 拿到接收端，收到信号时广播：

```rust
let (shutdown_tx, _) = broadcast::channel::<()>(1);

let mut rx = shutdown_tx.subscribe();
tokio::spawn(async move {
    rx.recv().await.ok();
    // 做清理...
});

tokio::signal::ctrl_c().await?;
shutdown_tx.send(()).ok();
```

比 `exit(0)` 好一些，但用起来磕磕绊绊：

- 每个任务都要手动 `subscribe()`，漏了就漏了，编译器不管
- `broadcast::Receiver` 无法直接 clone，传递起来需要多绕几步
- 和 `select!` 配合时需要额外包一层 future

但最要命的问题不在这里。broadcast 只能全播或不播——**没法只通知某一个源**。运营要的"运行时摘掉某个出问题的源、其他源继续跑"，这套方案根本没法干净表达。

### 第三种：AtomicBool 轮询

```rust
static SHUTDOWN: AtomicBool = AtomicBool::new(false);

loop {
    if SHUTDOWN.load(Ordering::Relaxed) { break; }
    // 拉数据...
}

SHUTDOWN.store(true, Ordering::Relaxed);
```

全局变量，随取随用，看起来省事。但它只能被轮询——如果某个源正阻塞在 `conn.fetch().await` 上，它压根不会去看这个标志位，停止信号就这么无声无息地沉了。

而且，要实现"只停某个源"，你得给每个源单独维护一个 AtomicBool，再维护一张索引表，越写越像在手搓 CancellationToken，但没有它的任何优雅之处。

### 真正需要的是什么

回顾这三种方案，缺口很清晰：

1. **广播**：一处触发，所有源都能感知
2. **可 await**：能直接放进 `select!`，不用轮询
3. **可克隆**：随意散发，不用维护订阅关系
4. **可分级**：能只停某一个源，也能一下停所有

这四条加在一起，就是 `tokio_util::sync::CancellationToken`。

## CancellationToken：一套可以精准控制的电闸

`CancellationToken` 来自 `tokio-util` crate。把它想象成一栋办公楼的配电系统——楼管可以拉总闸让全楼断电，也可以只关三楼的配电箱，其余楼层灯火通明。

三个核心方法：

- `token.cancel()` → 拉闸
- `token.cancelled().await` → 竖起耳朵等闸被拉，可以直接扔进 `select!`
- `token.is_cancelled()` → 主动看一眼闸有没有被拉，用在没有 await 点的同步循环里

下面从最简单的需求开始，逐步把这三个方法都用起来。

## 需求一：Ctrl+C，所有源一起停

最基础的场景：进程收到信号，所有采集任务干净退出。

```rust
let root_token = CancellationToken::new();

// 信号监听：把 Ctrl+C 翻译成 token.cancel()
// 职责极其单纯——只负责把一种语言转成另一种，不参与任何决策
let ctrl_c_token = root_token.clone();
tokio::spawn(async move {
    tokio::signal::ctrl_c().await.ok();
    info!("收到 Ctrl+C，广播停止信号");
    ctrl_c_token.cancel();
});

// 每个源拿走一个克隆，共享同一个 token
let token = root_token.clone();
tokio::spawn(async move {
    loop {
        tokio::select! {
            result = conn.fetch() => {
                // 处理数据...
            }
            _ = token.cancelled() => {
                info!("收到停止信号，关闭连接");
                conn.close().await;
                break;
            }
        }
    }
});
```

`clone()` 出来的副本和原本是**同一个 token 的不同持有者**——任何一处调用 `cancel()`，所有持有者都能感知到。就像广播电台的信号，不管你手里拿的是哪台收音机，都能收到同一个频道。

这解决了"全部停"，但运营的需求呢？

## 需求二：只停某一个源——child_token 登场

运营说某个源连续超时，想单独把它摘掉，其他源继续跑。

用 `clone()` 做不到这一点——clone 出来的都是同一个 token，取消其中一个就取消了全部。我们需要的是 `child_token()`：

```rust
let root_token = CancellationToken::new();

// 父取消 → 子跟着取消
// 子取消 → 父不受影响
let source_token = root_token.child_token();
```

两条规则，非对称：
- 父取消，子跟着取消（总闸拉了，配电箱自然也没电）
- 子取消，父不受影响（关了三楼的配电箱，一楼还亮着）

画成树就是：

```
root_token（整个服务）
  ├── source_token（源 A）
  ├── source_token（源 B）
  └── source_token（源 C）
```

`root_token.cancel()` → 全树取消。`source_token_B.cancel()` → 只有 B 停止，A 和 C 继续跑。

把这套逻辑加进采集服务：

```rust
struct DataCollector {
    sources: HashMap<SourceId, SourceHandle>,
    root_token: CancellationToken,
}

struct SourceHandle {
    token: CancellationToken,  // root 的 child token
    task: JoinHandle<()>,
}

impl DataCollector {
    fn add_source(&mut self, id: SourceId, cfg: SourceConfig) {
        let source_token = self.root_token.child_token();
        let token = source_token.clone();

        let task = tokio::spawn(async move {
            run_source(cfg, token).await;
        });

        self.sources.insert(id, SourceHandle { token: source_token, task });
    }

    // 运行时摘掉某个源：只取消它的 child token，root 和兄弟源不受影响
    async fn remove_source(&mut self, id: &SourceId) {
        if let Some(src) = self.sources.remove(id) {
            src.token.cancel();      // 只关这一层的配电箱
            let _ = src.task.await;  // 等它干净退出
        }
    }
}
```

`remove_source()` 里那行 `src.token.cancel()` 是整套设计的核心——它明确地只砍一条枝桠。`DataCollector` 继续跑，其余源不知道发生了什么，只有被摘掉的那个收到信号并退出。

这就是 `child_token()` 和 `clone()` 的本质区别：**clone 是分身，共享同一条命；child 是子嗣，父死子亡，子死父在。**

顺带一提，这个模式天然支持热重载——摘掉旧的 source_token，用新配置调用 `add_source()` 再起一个。因为 child token 独立于 root，重建一条枝桠不影响整棵树的其他部分。

## 需求三：CPU 密集型解析——is_cancelled() 的用武之地

每个源拉回来的数据往往需要做一轮解析：类型转换、字段校验、格式化……这些操作是同步的，没有 await 点，放不进 `select!`。

如果这段时间里收到停止信号，任务不会立刻感知到——它要等整个批次跑完，才能在下一次循环里碰到 `cancelled().await`。少则几十毫秒，多则几秒，全靠数据量说了算。

这时候用 `is_cancelled()` 在批次之间插入检查点：

```rust
async fn run_source(cfg: SourceConfig, token: CancellationToken) -> Result<()> {
    let mut conn = connect(&cfg).await?;

    loop {
        // 异步阶段：fetch 和取消信号竞争，谁先到谁赢
        let raw = tokio::select! {
            result = conn.fetch() => result?,
            _ = token.cancelled() => break,
        };

        // 同步阶段：CPU 密集型解析，没有 await 点
        // 在每个 chunk 之间插入检查点，别等整批跑完才反应
        for chunk in raw.chunks(CHUNK_SIZE) {
            if token.is_cancelled() { break; }
            pipeline.push(parse(chunk)?);
        }
    }

    conn.close().await;
    Ok(())
}
```

`cancelled().await` 和 `is_cancelled()` 配合使用：异步等待用前者，同步循环用后者。就像赛跑运动员——在起跑线等信号用耳朵听，跑起来之后只能靠眼睛扫一眼计时板。

## 需求四：关键源失败，升级为全局停止

并非所有源都同等重要。某些提供可选数据，出错了记个日志、调用 `remove_source()` 下线就行；另一些是关键路径，它一挂整个服务继续跑也没有意义——这时应该向上广播，触发全局停止。

```rust
fn add_source(&mut self, id: SourceId, cfg: SourceConfig) {
    let source_token = self.root_token.child_token();
    let root_token = self.root_token.clone();  // 留一份，用于向上广播
    let token = source_token.clone();

    let task = tokio::spawn(async move {
        if let Err(e) = run_source(cfg, token).await {
            if cfg.is_critical {
                error!("关键源 {id} 失败: {e}，触发全局停止");
                root_token.cancel();  // 向上广播，全树取消
            } else {
                warn!("非关键源 {id} 失败: {e}，已自动下线");
                // source_token 随 task 结束自然失效，无需额外操作
            }
        }
    });

    self.sources.insert(id, SourceHandle { token: source_token, task });
}
```

注意这里同时持有两个 token：`source_token`（child）和 `root_token`（clone）。

- 想只停自己：`source_token.cancel()`
- 想停整棵树：`root_token.cancel()`

两行代码，意图截然不同。这是 child token 的另一面：除了让父可以单方面停子，它同样允许子在需要时"敲响警报"通知父。子 token 的取消不会自动向上传播，但持有 root token 的 clone 就可以——信号往哪个方向走，完全由你决定。

## 完整拼装

把四个需求组合在一起，停止信号的流向如下：

```
Ctrl+C / 运维命令 / 关键源失败
                │
                ▼
        root_token.cancel()          ← 那声"拉闸"
                │
    ┌───────────┴───────────┐
    ▼                       ▼
全树子 token 跟着取消    （或）source_token.cancel()
所有源收到信号退出              只有这一个源退出
```

完整代码：

```rust
use std::collections::HashMap;
use std::time::Duration;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

struct DataCollector {
    sources: HashMap<SourceId, SourceHandle>,
    root_token: CancellationToken,
    admin_rx: Receiver<AdminCmd>,
}

struct SourceHandle {
    token: CancellationToken,
    task: JoinHandle<()>,
}

impl DataCollector {
    fn add_source(&mut self, id: SourceId, cfg: SourceConfig) {
        let source_token = self.root_token.child_token();
        let root_token = self.root_token.clone();
        let token = source_token.clone();

        let task = tokio::spawn(async move {
            if let Err(e) = run_source(cfg, token).await {
                if cfg.is_critical {
                    error!("关键源 {id} 失败: {e}，触发全局停止");
                    root_token.cancel();
                } else {
                    warn!("非关键源 {id} 失败: {e}，已自动下线");
                }
            }
        });

        self.sources.insert(id, SourceHandle { token: source_token, task });
    }

    async fn remove_source(&mut self, id: &SourceId) {
        if let Some(src) = self.sources.remove(id) {
            src.token.cancel();
            let _ = src.task.await;
        }
    }

    async fn run(&mut self) -> Result<()> {
        // 信号监听：把 OS 信号翻译成 token.cancel()
        let ctrl_c_token = self.root_token.clone();
        tokio::spawn(async move {
            tokio::signal::ctrl_c().await.ok();
            info!("收到 Ctrl+C，广播停止信号");
            ctrl_c_token.cancel();
        });

        // 主循环：等停止信号，或响应运维命令
        loop {
            tokio::select! {
                _ = self.root_token.cancelled() => {
                    info!("收到停止信号，开始清理...");
                    self.shutdown().await;
                    break;
                }
                cmd = self.admin_rx.recv() => {
                    match cmd {
                        Some(AdminCmd::RemoveSource(id)) => {
                            self.remove_source(&id).await;
                        }
                        None => break,
                    }
                }
            }
        }

        Ok(())
    }

    async fn shutdown(&mut self) {
        // root_token 此时已取消，所有 child token 也已取消
        // 带超时等待所有子任务退出，防止某个源的 close() 卡死
        let drain = async {
            for (_, src) in self.sources.drain() {
                let _ = src.task.await;
            }
        };
        match tokio::time::timeout(Duration::from_secs(30), drain).await {
            Ok(_) => info!("所有数据源已停止"),
            Err(_) => error!("部分数据源未能在 30 秒内退出，强制结束"),
        }
    }
}

async fn run_source(cfg: SourceConfig, token: CancellationToken) -> Result<()> {
    let mut conn = connect(&cfg).await?;

    loop {
        let raw = tokio::select! {
            result = conn.fetch() => result?,
            _ = token.cancelled() => break,
        };

        for chunk in raw.chunks(CHUNK_SIZE) {
            if token.is_cancelled() { break; }
            pipeline.push(parse(chunk)?);
        }
    }

    conn.close().await;
    Ok(())
}
```

## 总结

### 四种能力，各有用场

| 能力 | 方法 | 用在哪 |
|------|------|--------|
| 全局广播 | `token.clone()` + `cancel()` | Ctrl+C、致命错误向上传播 |
| 分级取消 | `child_token()` + `cancel()` | 运行时摘掉单个源，不影响其余 |
| 异步等待 | `cancelled().await` | `select!` 分支，IO 阻塞阶段 |
| 同步轮询 | `is_cancelled()` | 没有 await 点的 CPU 密集型循环 |

### 几条原则

1. **不要悄悄退出**：任何导致停止的事件，都该调用 `token.cancel()` 让别人也知道，不要静默消失
2. **分清 clone 和 child**：同生共死用 clone，父死子亡但子死父活用 child_token
3. **超时是必须的**：任何等待清理的操作都要加超时，别让"优雅停止"变成"体面地永远停不下来"
4. **一个失败不应拖累全局**：非关键源出错，记录日志，继续处理其余的——三楼停电不是全楼断电的理由

---

优雅停止听起来是个小细节，但在生产环境里，它常常是系统可靠性的隐藏天花板。数据采集服务尤其如此——跑得快固然好，但能在合适的时机、以合适的方式停下来，才算真正意义上的稳定。等第一次丢数据之后再补这块逻辑，代价会大得多，而且你大概正在凌晨两点盯着屏幕。
