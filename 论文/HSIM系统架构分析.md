# HSIM 仿真平台系统架构分析

> 面向系统分析：工作区 `hsim-deploy` 如何把多个 Git 仓组装成云上可调度的闭环仿真平台。  
> 依据仓库内 README 与实现代码整理，不依赖口头约定。

---

## 目录

1. [平台是什么](#1-平台是什么)
2. [工作区与仓库清单](#2-工作区与仓库清单)
3. [平台如何搭起来](#3-平台如何搭起来)
4. [各仓库职责](#4-各仓库职责)
5. [容器：为什么拆、怎么管](#5-容器为什么拆怎么管)
6. [技术栈](#6-技术栈)
7. [从源码到运行镜像](#7-从源码到运行镜像)
8. [深入：部署拓扑、端口与卷](#8-深入部署拓扑端口与卷)
9. [深入：一次任务的状态机](#9-深入一次任务的状态机)
10. [深入：LogSim 拍内时序与 ROS 域](#10-深入logsim-拍内时序与-ros-域)
11. [深入：adapter 与动力学](#11-深入adapter-与动力学)
12. [设计取舍](#12-设计取舍)
13. [建议阅读顺序](#13-建议阅读顺序)

---

## 1. 平台是什么

HSIM（Hello Simulation）是哈啰 Robotaxi 的**闭环仿真平台**。核心用途：

- 用路测包（LogSim）或虚拟场景（WorldSim）把算法（规划 / 控制 / 端到端）关进仿真
- 动力学车辆模型吃控制指令，算出位姿/底盘，再回灌给算法
- 云上按任务调度，跑完录包、上传 OSS，再由评测 Pod 异步打分

用户侧入口是 **hsim CLI 1.6.0**，对接到 prod（默认项目 202）。底层执行在 K8s 仿真 Pod，不在开发机本地。

`hsim-deploy` **不是一个 Git 单体仓**，而是把多个 GitLab 仓 checkout 到同一目录、用 `image/build.sh` 编二进制并打运行镜像的**工作区**。

- 镜像仓库：`reg.hellorobotaxi.top/infra-hsim-t/hsim_engine`
- 运行镜像标签：`rsim_YYYYMMDDHHMMSS`
- 基础镜像标签：`hsim_engine_base`

---

## 2. 工作区与仓库清单

全部远程在 `gitlab.hellorobotaxi.top:hsim/public/`。

| 目录 | Git 仓 | 角色 |
|------|--------|------|
| `image/` | `image.git` | 镜像与运行时装配：Dockerfile、`rsim/` 运行时代码、`build.sh` |
| `orderly/` | `orderly.git` | 任务调度客户端：拉任务、管容器生命周期、上传产物 |
| `sim-controller/` | `sim-controller.git` | 仿真控制器：`rsim_runner` / `reva_runner` / `custom_runner` |
| `adapter/` | `adapter.git` | **实际打进运行镜像的 PNC/E2E 适配器**（logsim + worldsim） |
| `pnc-adapter/` | `pnc-adapter.git` | adapter 同源旧仓，**打包不走这里** |
| `hellosim/` | `hellosim.git` | `rsim_main`：仿真引擎主进程 |
| `hsim-engine/` | `hsim-engine.git` | `scene_runner`：OpenDRIVE / OpenSCENARIO 场景运行 |
| `hsim-recorder/` | `hsim-recorder.git` | 录包 / viz_bridge（ROS2 bag） |
| `third_party/` | `third_party.git` | 统一依赖：RSim SDK、开源库、`hv_interface_msgs` |

文档还提到独立 `scheduler` 仓。本工作区没有单独 clone；调度器由 `image/scripts/build/build_scheduler.sh` 编出后，落到 `sim-controller/custom_runner/hello_pnc_runner/logsim_adapter/scheduler`。

`pnc-adapter` 与 `adapter` 代码同源，但 `image/build.sh --adapter` 明确编译 `../adapter`。查线上行为以 `adapter/` 为准。

---

## 3. 平台如何搭起来

四层，从外到内：

```text
用户 / 云端控制台 / hsim CLI
        │
        ▼
仿真服务端  qiancen.sim.*（拉任务、报状态）
        │
        ▼
┌────────────────── K8s 仿真 Pod ──────────────────┐
│  init-container   准备 /mnt/workspace 共享卷      │
│  orderly (sim)    拉任务、启停业务容器、上传 OSS   │
│  rsim             引擎 + adapter + scheduler + 车 │
│  testobject       算法 control/e2e/planning/map   │
└──────────────────────────────────────────────────┘
        │ 产物 OSS
        ▼
┌────────────────── K8s 评测 Pod ──────────────────┐
│  orderly (eval)   pullEval 认领 run_finished      │
│  reva             评价进程                         │
└──────────────────────────────────────────────────┘
```

一次 LogSim 闭环任务：

1. **下单**：`hsim run start` 或云端拉任务，带上 case（mcap/db3）、算法包、`interfaceVersion`、引擎 tag。
2. **调度**：orderly（sim）从服务端 `task.pull` 拿到 JSON。
3. **准备**：init-container 把 `k8s-agent`、`custom_runner`、`third_party` 拷到 `/mnt/workspace`；从 OSS 下载场景、地图、重刷感知/高精地图、算法包。
4. **启动**：同一套 `hsim_engine` 镜像用 `CONTAINER_NAME` 区分角色；算法在独立 `testobject` 镜像。
5. **运行**：`rsim_runner` 起 `rsim_main`、动力学、adapter、scheduler；按 YAML 锁步驱动算法；adapter 回放原包并给动力学发控制。
6. **收尾**：录 MCAP/CSV/日志 → OSS → 报 `run_finished` → 仿真 Pod 释放。
7. **评测**：eval Pod 认领，reva 打分，sapper 再传结果。

仿真和评价**刻意拆开**：仿真 Pod 不内联评价，避免占卡、占内存，评测量可独立扩缩。

---

## 4. 各仓库职责

### 4.1 `orderly` — 工头

Python 调度客户端，两种模式：

| 模式 | 干什么 |
|------|--------|
| `sim`（默认） | 仿真主 Pod：prepare → running → cleaning；产物上 OSS 后报 `run_finished` |
| `eval` | 评测常驻 Pod：`pullEval` 认领已跑完的任务，派给 reva |

子目录：

- `orderly/`：主循环、任务协议、上传下载
- `sapper/`：本机 HTTP 上传代理（默认 8602），把工作目录打到 OSS
- `k8s-agent/`：跑在**业务容器里**的启动代理（`docker_startup_proxy`），接收启动指令、准备 overlayfs
- `launcher/`：进程拉起辅助

它不跑动力学，也不跑算法，只负责：要不要起容器、起哪个镜像、参数怎么传、失败怎么报、文件怎么进出云。

### 4.2 `sim-controller` — 仿真进程编排

镜像入口 `/start.sh` 按 `CONTAINER_NAME` 分发：

- `rsim` → `rsim_runner/start.sh`
- `reva` → `reva_runner/start.sh`

`rsim_runner` 按 `runType` 选 Manager：

| runType | Manager | 含义 |
|---------|---------|------|
| PDC / E2E / RDD | `PNCWithDyncVehicleManager` | 带动力学的 PNC/端到端闭环（云上最常见） |
| HIL | `HILManager` | 硬件在环 |
| CUSTOM_RUNNER | `RunnerManager` | 自定义 runner |

`custom_runner/hello_pnc_runner/` 是算法侧适配落点：

- `logsim_adapter/`：路测回放二进制 + `scheduler` + YAML
- `worldsim_adapter/`：虚拟场景适配器

adapter 按 hv_interface 版本各编一份：`logsim_adapter_1.5.3` / `1.6.0`（worldsim 同理）。算法 `<1.6.0` 用 1.5.3，`>=1.6.0` 用 1.6.0。

### 4.3 `adapter` — 仿真世界与算法世界的桥

C++，ROS2 Humble。两类二进制：

- **logsim_adapter**：读 mcap/db3，按仿真时间回放 localization / perception / control / planning；把动力学 `VehicleStatus` 发成闭环定位和底盘；可选用原包控制或算法控制开动力学。
- **worldsim_adapter**：虚拟场景传感器（感知、路由、底盘、function_manager）。

通过 **RSimClient SDK** 连 `rsim_main`。跨模块节拍由 scheduler 用 `/scheduler/step_grant` 锁步。

### 4.4 `hellosim` / `hsim-engine` — 引擎内核

- **hellosim → `rsim_main`**：仿真主服务，对外 RPC，管模块状态机（IDLE / INIT / READY / RUNNING / FINISHED）。
- **hsim-engine → `scene_runner`**：OpenDRIVE / OpenSCENARIO。WorldSim、部分 PDC 会用；纯 LogSim 常 `enable_world=False`，时间轴改由 adapter + scheduler 用原包时间戳驱动。

车辆动力学不在这两个仓，而在 `image/rsim/bin/dynamic_vehicle/`：FMI3 组合模型（物理车 + PID + 转向延迟）。

### 4.5 `image` — 可部署单元

| 子目录 | 镜像 | 用途 |
|--------|------|------|
| `docker/base` | `hsim_engine_base` | Ubuntu 22.04 + Python 3.10 + ROS2 Humble + CycloneDDS + ossutil |
| `docker/dev` | `hsim_engine_dev` | CMake / Ninja / Nuitka，编 C++ |
| `docker/adapter` | `hsim_adapter_builder:local` | 与算法 ABI 对齐地编 adapter |
| `docker/run` | `rsim_YYYYMMDDHHMMSS` | 在 base 上 rsync 代码后 commit |
| `docker/testobject` | `hsim_engine_testobject_*` | 算法基础镜像 + RSim Python wheel（cp312） |
| `rsim/` | （打进运行镜像） | `bin/`、`conf/`、动力学 FMU、Nuitka 编出的 `rsim` 启动器 |

构建记录写到仓 `hsim/public/cicd` 的 `build_history.md`（测试 `test/<用户名>`，发版 `--release` 写 main）。

### 4.6 `third_party` — 依赖的单一事实来源

- `external/`：asio、boost、eigen、mcap、spdlog、zstd 等
- `internal/`：RSimAPI、RSimPythonAPI、OpenDriveParser
- `hellobike/hv_interface_msgs/<ver>/<platform>/`：算法团队交付的 ROS2 消息 install 目录（预编译）
- `python/`：logger、task_param、OSS 下载

`setup.sh` 把这份目录 ln 到 `hellosim/third_party`、`hsim-engine/third_party`、`orderly/third_party`。

**msgs 分 `x86_64` 与 `x86_64_thor`：** 运行镜像是 apt ROS2 Humble（FastCDR v1）；算法 testobject 是 thor 交叉编译环境（FastCDR v2）。`.so` 不能混用。adapter 因此按版本各编两套。

### 4.7 `hsim-recorder`

独立录包 / viz_bridge。运行时全量录包主要由 **scheduler 内置 recorder** 做。recorder 仓是补充能力，不是每次任务主路径。

---

## 5. 容器：为什么拆、怎么管

### 5.1 为什么拆

1. **算法与仿真 ABI 不同**：算法要 CUDA、特定 FastCDR；仿真要 Humble + FMU。硬塞同一 rootfs 会冲突。引擎镜像与 testobject 镜像分开，topic 用 ROS2 DDS 跨容器通信。
2. **同一镜像、多种角色**：`hsim_engine:rsim_*` 同时带 orderly、rsim_runner、reva、sapper、k8s-agent。K8s 用不同 command / `CONTAINER_NAME` 起不同进程。
3. **弹性**：仿真 Pod 跑完释放；评测 Pod 常驻抢任务。
4. **数据与权限**：场景、算法包、录包走 `/mnt/workspace` + OSS。AK/STS 用环境变量注入，不打进镜像。
5. **增量发布**：改 adapter 只需 `--adapter` 编四个二进制，再 commit 新 `rsim_*` tag。base 很少重建。

### 5.2 仿真主 Pod 里的容器

| 容器 | 镜像 | 入口 | 职责 |
|------|------|------|------|
| init | `hsim_engine` | `/home/realsim/rsim/services/init.sh` | 建共享卷，拷 k8s-agent / custom_runner / third_party |
| orderly | `hsim_engine` | `orderly/entry.sh --mode sim` | 拉任务、指挥其它容器、上传 |
| rsim | `hsim_engine` | `CONTAINER_NAME=rsim` → `/start.sh` | 引擎 + adapter + scheduler + 车辆 |
| testobject | `hsim_engine_testobject_*` | 算法 startup proxy | control / e2e / planning / map_engine / wm |

评测 Pod：orderly（eval）+ reva，镜像仍是 `hsim_engine`，靠入口区分。

### 5.3 生命周期

```text
K8s 拉起 Pod
  → init-container 初始化共享卷
  → orderly 常驻 pull 任务
  → k8s-agent 在业务容器内听启动指令
  → overlayfs（可选）+ 下载 OSS
  → rsim_runner：INIT → RUNNING → STOP
  → sapper 上传 /mnt/workspace/output/{taskId}
  → 上报 run_finished，Pod idle 或销毁
```

算法容器有 **120s INIT 超时**。卡在 testobject 没 ready 时，C++ adapter 往往还没起来。

---

## 6. 技术栈

| 层 | 技术 | 用途 |
|----|------|------|
| 语言 | C++17/20、Python 3.10（引擎）/ 3.12（算法 wheel） | 引擎性能；编排与云对接用 Python |
| 构建 | CMake + Ninja；Nuitka（`rsim` 编成 onefile） | 可重复 Release 产物 |
| 中间件 | ROS 2 Humble、CycloneDDS / FastDDS、FastCDR v1/v2 | 算法 topic；scheduler 多 domain |
| 数据 | MCAP、rosbag2 db3、CSV | 路测包、重刷感知、动力学日志 |
| 车辆 | FMI 3.0 组合 FMU | 物理车 + PID 加速度环 + 转向延迟 |
| 场景 | OpenDRIVE / OpenSCENARIO（esmini 系） | WorldSim / scene_runner |
| RPC | RSimClient / rpclib | adapter ↔ rsim_main、车辆 tick |
| 容器 | Docker、K8s、docker-compose | 云上 K8s；本地/daemon 也可用 compose |
| 存储 | 阿里云 OSS、STS、ossutil | 场景/算法/录包 |
| 契约 | `hv_interface_msgs` 1.5.3 / 1.6.0 | 与车上算法消息对齐 |
| 用户工具 | hsim CLI 1.6.0 | 下发任务、查日志、拉产物 |

调度策略（`logsim_e2e.yaml`）：`strict_serial`，`tick_ms: -1` 表示**跟原包 localization 时间戳**，不是固定墙钟。预热可让 map/e2e/planning 在环，正式段再开 control。

---

## 7. 从源码到运行镜像

```bash
cd image
./setup.sh              # 缺仓 clone，third_party 做符号链接
./build.sh --adapter    # 编 adapter 四个二进制 + 打 rsim_* 镜像
```

流水线：

1. **base**（很少动）：OS + ROS + Python
2. **dev / adapter_builder**：隔离环境编 C++，对齐线上 glibc/ROS
3. **产物拷进 sim-controller**（adapter、scheduler 常以未提交二进制出现，`build_history` 会记 dirty）
4. **run**：临时容器挂代码，rsync 到 `/home/realsim/rsim/services/`，commit、push
5. 云端任务 JSON 指定 `engine` tag，orderly 按 tag 拉镜像

`docker/run/build_image.py` 打进运行镜像的内容：

| 宿主机路径 | 镜像内路径 |
|------------|------------|
| `image/rsim/` | `/home/realsim/rsim` |
| `sim-controller/{rsim_runner,reva_runner,custom_runner}` | `/home/realsim/rsim/services/` |
| `orderly/{orderly,sapper,k8s-agent}` | `/home/realsim/rsim/services/` |
| `third_party/python` | `/home/realsim/rsim/third_party` |
| `hv_interface_msgs` 预拷贝 | `/home/realsim/hellorobot_msgs/` |
| `sim-controller/start.sh` | 容器 `/start.sh` |
| `init-container/init.sh` | `/home/realsim/rsim/services/init.sh` |

---

## 8. 深入：部署拓扑、端口与卷

平台有两套部署形态：**K8s（云上主路径）** 和 **docker-compose（本地/daemon）**。逻辑相同：共享卷 + 多容器 + HTTP 代理拉起进程。

### 8.1 卷

| 宿主机 / 卷 | 容器内 | 用途 |
|-------------|--------|------|
| Pod 共享卷（或 compose 的 `host_data_dir`） | `/mnt/workspace` | 任务输入输出总根 |
| （可选缓存卷） | `/mnt/workspace_cache` | overlayfs 数据缓存 |
| 引擎镜像内 `~/rsim` | `/home/realsim/rsim` | 运行时二进制与 services |
| `/dev/shm`、`/tmp` | 同路径 | DDS / 临时文件 |
| compose 额外：`docker.sock` | `/var/run/docker.sock` | orderly 在宿主机上再拉业务容器（仅 compose） |

`/mnt/workspace` 约定：

```text
/mnt/workspace/
├── input/
│   ├── download/          # OSS 下来的场景、地图、算法包、msgs、重刷 bag
│   ├── k8s-agent/         # init 拷进来的启动代理
│   ├── custom_runner/     # adapter / scheduler / 算法 launcher
│   └── third_party/       # Python 工具与运行时依赖
└── output/
    ├── {taskId}/          # 本任务产物（logs、mcap、csv）
    ├── logs/              # 服务级日志
    ├── services/logs/     # orderly / sapper 启动日志
    └── overlayfs/         # 可选算法数据缓存
```

init-container（`image/docker/run/init-container/init.sh`）只做三件事：建目录、把 k8s-agent / custom_runner / third_party 拷到 `input/`、准备 `output/services/logs`。之后的场景/算法下载由 orderly prepare 阶段完成。

### 8.2 端口

K8s 常用 **hostNetwork / 127.0.0.1**，端口是进程约定，不是 Service 名。

| 端口 | 进程 | 谁连谁 |
|------|------|--------|
| **8989** | orderly `HttpServerChannel` | 服务端回调、sapper 上报 `/upload_report`、reva 回调 `/validator/result` |
| **8602** | sapper | orderly `POST /upload` 通知上传 `/mnt/workspace/output/{taskId}` |
| **9999** | rsim 容器内 k8s-agent / 任务代理 | orderly 发仿真启动、`/adsim/task/cancel` |
| **6002**（及任务里的 `startupProxyPort`） | testobject 启动代理 | orderly 按算法容器列表逐个 `POST` 启动脚本 |
| **6001** | k8s-agent 默认 `DOCKER_STARTUP_PROXY_PORT` | 代理监听（可被 env 覆盖） |
| **7007** | testobject 算法 serverPort（任务 JSON 示例） | rsim_runner 用 RSim 协议连算法模块状态机 |
| **7001** | reva `EVA_SERVER_PORT` | eval Pod 内 orderly → `POST /add_task`、探活 `/healthz` |
| **9000** | `rsim_main` 默认 RPC（adapter 日志里的 rsim port） | adapter / 车辆客户端连引擎 |
| 动态 | adapter 自身 RPC + streaming | `logsim_runner` 用 `PortSelect` 现选 |

算法各模块另有 ROS2 通信，**不走这些 HTTP 端口**，走 DDS，靠 `ROS_DOMAIN_ID` 隔离（见第 10 节）。

compose 模板（`orderly/orderly/daemon/docker/rsim_compose.yaml` + `config/docker/run_template.yaml`）额外把 orderly 的 8989 映射出去，并挂 `docker.sock`，让 orderly 能 `docker compose` 再拉 `rsim_sim` / `rsim_testobject`。云上 K8s 路径不经过这层套娃，业务容器已由 Pod spec 拉起，orderly 只对已存在的 localhost 代理发 HTTP。

### 8.3 K8s 启动顺序（orderly 侧）

`LaunchStepK8sBusiness` 状态机：

```text
idle
  → simulation_launching          # HTTP 127.0.0.1:9999 拉起 rsim 容器内 /start.sh
  → containers_start_script_launching   # 对其它 startupProxyPort 发 bash /start.sh <task_b64>
  → testobject_launching          # 算法容器
  → idle + 上报
```

任务参数整包 **base64** 传给 `/start.sh`。rsim 容器 `rsim_runner/start.sh` 解码后跑 `python main.py --task_param_b64=...`。

---

## 9. 深入：一次任务的状态机

### 9.1 平台级（orderly sim）

```text
pull 任务
  → prepare     下载 OSS、写 task_param、准备目录
  → launching   上节 K8s 状态机
  → running     等 rsim_runner 报 RUNNING / FINISHED / ERROR
  → cleaning    收日志、调 sapper 上传
  → run_finished 上报服务端，释放 Pod
```

评价不在这条链上。`Util.enable_evaluation()` 只在 eval Pod 为真。

### 9.2 引擎级（rsim_runner）

`main.py`：`INIT` → `RUNNING` → `STOP`（或 `ERROR`）。

`PNCWithDyncVehicleManager.init()` 顺序：

1. `start_rsim`（`enable_world=False` 时不启 scene 3D 世界）
2. `start_dynamic_vehicle`（`enable_vehicle` 时）
3. 按 `containerInfos` 连接每个 `type=alg` 的 testobject（等 INIT，**120s**）
4. `wait_for_init` 等 `rsim_main`
5. testobject `init()` / `prepare()`，等 READY
6. `load_trial_by_path(scenario_file)`：LogSim 直接用 mcap 路径；WorldSim 用 `xosc/scene.xosc`
7. `apply_settings`：LogSim 为 `SteppingMode.DataDrivenMode`（数据驱动步进）

`run()`：`rsim_main.run()` + 各 testobject `run()`，轮询直到 `FINISHED` 或 200s 墙钟超时。

### 9.3 算法与 adapter 级（LogSimRunner.init）

在 custom_runner 里，**必须先算法、再 scheduler、最后 adapter**：

```text
ModuleLauncher.start_modules()     # control / e2e / planning / map_engine / wm
  → wait_modules_ready()           # 扫各模块日志里的就绪字符串
  → _start_scheduler()             # E2E 用 logsim_e2e.yaml，PNC 用 logsim_pnc.yaml
  → _start_logsim_adapter()        # ROS_DOMAIN_ID=0，选 logsim_adapter_{1.5.3|1.6.0}
```

就绪字符串（`module_launcher.py`）：

| 模块 | 日志里出现即 ready |
|------|-------------------|
| planning | `启动planning` |
| control | `启动 control` |
| e2e | `Planner model initialized successfully` |
| map_engine / wm | `模块运行时间统计` |

adapter 等 `step_grant` 才往下走。scheduler 若没起来，adapter 会堵死，所以顺序不能反。

`HSIM_SCHED_DOMAIN_ISOLATION=1` 在 LogSimRunner 里强制打开，并加载 FastDDS profile，避免大消息（如 400KB prediction）UDP 分片打满内核缓冲。

---

## 10. 深入：LogSim 拍内时序与 ROS 域

### 10.1 域隔离

算法零改动，启动前 `export ROS_DOMAIN_ID`。须与 `scheduler_config/modules/*.yaml` 一致：

| Domain | 模块 | 典型产出 |
|--------|------|----------|
| **0** | adapter（仿真侧）+ perception 伪模块 + prediction 伪模块 | 回放原包、闭环定位/底盘、感知/预测 topic |
| **1** | map_engine + wm | `/map/map`、`/map/routing_response`、camera_scene 等 |
| **3** | e2e | `/e2e/e2e_trajectory`、`/e2e/pnp_trajectory` |
| **4** | planning | `/planning/trajectory`、`/planning/routing_request` |
| **5** | control | `/control/control`（**算法输出**） |

scheduler 跨域桥接：把域 0 的定位/底盘/感知桥到 1/3/4/5，把各算法输出桥回来。录包默认 `dedup_bridged_copies: true`，每个话题只录生产者域，避免同一帧录五份定位。

### 10.2 时间轴

`tick_ms: -1`：本拍仿真时间 = 原包 localization 的 `global_timestamp`。adapter 在 Prepare 把时间戳写到与 scheduler 共享的 runtime 目录：

- `scheduler_localization_stamps.txt`
- `scheduler_perception_stamps.txt`
- `scheduler_prediction_stamps.txt`
- `scheduler_anchor_stamps.txt`

E2E：感知触发 e2e；prediction 触发 planning；planning **不等本帧 e2e**，用上一帧 last-known。

### 10.3 预热 vs 正式

预热（`warmup_algo_in_loop: true`）：

1. `warmup/map_init.yaml`：adapter 发 localization + `map_extend_raw` + routing_request，等 `/map/routing_response`（最多 10 次、间隔 1s）。
2. 每拍跑 map / e2e / planning，**不跑 control**。
3. 车辆用 PerfectControl / SetResetControl **瞬移**对齐原包位姿。
4. 缓存最新 planning / function_manager，留给正式第一拍。

正式：

1. 发 `SIMULATION_STARTED`，丢掉迟到的 warmup grant。
2. localization 的 trigger 是 `/control/control`（域 5 算法输出）。这就是「正式段不要再往 `/control/control` 发原包」的根因：否则自己触发自己。
3. control 的 trigger 是闭环 `/localization/localization`；输入含当前 chassis + **replay_last** 的 planning。
4. 动态 rerouting：planning 的 `/planning/routing_request`（域 4）被改名为 `/function/tour_routing_request` 送给 map（域 1）。

### 10.4 一拍里模块顺序（E2E strict_serial）

```text
[域0 adapter] 回放感知 / 预测 / 原包定位对照
     │
     ▼
[域1 wm]     吃闭环定位 → map / routing / camera_scene
     │
     ▼
[域3 e2e]    trigger = 感知障碍物列表
     │
     ▼
[域0 pred]   原包 /prediction/prediction（E2E 算法不再出预测）
     │
     ▼
[域4 planning] trigger = prediction；e2e_trajectory 为 last-known
     │
     ▼
[域5 control] trigger = 闭环 localization；输出 /control/control
     │
     ▼
[域0 adapter] 原包模式：忽略算法控制，SetControlCmd(原包加速度/转角)
              算法模式：SetControlCmd(实时 Control)
     │
     ▼
动力学 FMU tick → VehicleStatus
     │
     ▼
[域0] 发 /localization/localization + /vehicle/chassis_domain_report
     │
     └── 下一拍 localization 再 trigger control
```

### 10.5 看录包时不要看错 topic

| Topic | 生产者 | 正式段含义 |
|-------|--------|------------|
| `/control/control` | **算法**（域 5） | 调度/录像约定的「算法方向盘」，**不一定开车** |
| `/control/control_raw` | adapter | 原包控制，对照用，不进动力学 |
| `/localization/localization` | adapter ← 动力学 | 仿真车 |
| `/localization/localization_origin` | adapter ← 原包 | 原车对照 |
| `/vehicle/chassis_domain_report` | adapter ← 动力学 | 仿真底盘响应 |
| `/vehicle/chassis_domain_report_raw` | adapter | 原包底盘 |
| `/planning/trajectory_raw` | adapter | 原包规划 |

`control_source=original` 时真正开车的是 `SetControlCmd` 里的原包字段，不是 `/control/control`。

---

## 11. 深入：adapter 与动力学

### 11.1 启动与加载

`logsim_adapter_launch.sh` 需要环境变量 `HSIM_LOGSIM_ADAPTER` 指向带版本后缀的二进制。日志里会看到：

- `load_original_control: true/false`（1.4.1 为 false，避免零控制）
- `Original controls size: N`；为 0 时告警 skip original control replay
- 时间窗 `start_time` / `end_time`（LogSim 按时间范围裁包）

mcap 若只有定位+路由两条 topic（部分云上裁剪包），`/control/control` 为空，只能算法开环。

### 11.2 控制源

默认 `FLAGS_control_source=original`（启动脚本目前往往**没传**这个 flag，云上即默认原包）。

| 阶段 | original | algorithm |
|------|----------|-----------|
| 预热 | PerfectControl：位姿瞬移 + 原包加速度/转角 | 同左（预热不吃算法） |
| 正式 | 忽略 `OnControlCommand`，`ApplyOriginalBagControl` → `SetControlCmd` | 实时 Control → `SetControlCmd` |
| 正式 `/control/control` | **不**再 Publish 原包 | 算法自己发 |

映射：

- `chassis_control.target_longitudinal_acceleration` → `throttle`（m/s²）
- `chassis_control.target_steering_angle` → `steering`

查找：按当前原包定位 stamp，取**不晚于该时刻的最近一帧** bag control。

### 11.3 动力学 FMU

`image/rsim/bin/dynamic_vehicle/`，FMI3 组合：

```text
算法/adapter 的 IMP_THROTTLE_ENGINE（加速度指令）
        → PID_Setpoint
上一帧物理 Ax
        → PID_Measurement（phase=previous，晚一拍）
PID_Output
        → Vehicle_1.IMP_THROTTLE_ENGINE
转向 IMP_STEER_SW
        → HelloSteeringDelay → Vehicle 转角
Vehicle 物理积分
        → Vx / Ax / 位姿 → adapter SendLocalization
```

实测过的风险（加速抖动案例）：停车段长时间负加速度把 PID 积分攒满（`IntegralLimit=0`），起步时 10ms 正负对打。分析动力学不要用复位后冻住的 `IMP_Vx` / `IMP_Ax`，用物理 `Vx` / `Ax` 和 adapter `SendLocalization`。

### 11.4 WorldSim 差异

WorldSim 走 `worldsim_adapter`，场景来自 xosc，时间轴可以是实时步进（`RealTimeMode`），传感器由 worldsim 模块合成，而不是 bag 回放。调度 YAML 与 LogSim 不同套。打包时 worldsim 二进制与 logsim 一起按 1.5.3/1.6.0 各编一份。

---

## 12. 设计取舍

1. **多仓不是 monorepo**：镜像、引擎、桥、调度可独立发版；必须靠工作区 + cicd `build_history` 才能复现某次镜像。
2. **adapter 双轨**：历史分叉，打包只认 `adapter/`。
3. **msgs 双平台**：FastCDR 不兼容，所以 adapter 编两套不是功能重复。
4. **仿真 / 评测拆 Pod**：吞吐和故障域；录包 OSS 直读，评测不再经 NAS。
5. **动力学在镜像内**：改 PID/转向延迟要动 `image/rsim/bin/dynamic_vehicle/` 再打镜像。
6. **原包控制可选**：包里没有 `/control/control` 时只能算法开环；默认 `control_source` 会显著改变「车听谁的」。
7. **正式段 `/control/control` 只留给算法**：既为了录包语义，也为了 localization 模块的 trigger 不自激。

---

## 13. 建议阅读顺序

按「调度 → 进程 → 拍 → 桥 → 镜像」：

1. `orderly/README.md`、`orderly/orderly.py`、`business/k8s/business_k8s_launch.py`
2. `sim-controller/start.sh` → `rsim_runner/main.py` → `managers/pnc_vehicle_manager.py`
3. `custom_runner/hello_pnc_runner/logsim_adapter/logsim_runner.py`
4. `scheduler_config/logsim_e2e.yaml` 与 `modules/*.yaml`
5. `adapter/source/logsim/logsim_adapter.cpp`（加载 bag、ProcessSimTime、SetControlCmd）
6. `image/docker/README.md`、`docker/run/build_image.py`、`init-container/init.sh`
7. `third_party/hellobike/hv_interface_msgs/README.md`
8. `image/rsim/bin/dynamic_vehicle/RsimVehicle_FMI3/modelDescription.xml`（PID 连接）

本地复现一次镜像：

```bash
cd image
./build.sh --adapter --msg "说明这次改了什么"
# 产物：reg.hellorobotaxi.top/infra-hsim-t/hsim_engine:rsim_<时间戳>
```

跑任务时把 engine 换成该 tag。构建记录在 cicd 仓 `test/<用户名>` 的 `build_history.md`，用来核对镜像里到底是哪版 adapter / sim-controller。
