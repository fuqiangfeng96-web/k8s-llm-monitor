# 🧠 K8s-LLM-Monitor

> Kubernetes 集群智算监控中心 - 实时监控 AI 推理服务

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](https://opensource.org/licenses/MIT)

## 📖 项目简介

这是一个面向 Kubernetes 集群的 AI 推理服务监控平台，专为 GPU 推理场景设计。提供主机资源、GPU 状态、K8s Pod 状态的全方位实时监控，并支持智能告警。

## 🏗️ 技术架构

```
┌─────────────────────────────────────────────────────────────┐
│                      用户浏览器                              │
│                   (HTML5 + Chart.js)                        │
└──────────────────────────┬──────────────────────────────────┘
                           │ HTTP
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                  Node.js API 服务                            │
│              (原生 http，无框架依赖)                         │
│  • /api/host/metrics    → 主机 CPU/内存/磁盘               │
│  • /api/gpu/metrics    → NVIDIA GPU 状态                   │
│  • /api/k8s/pods       → K8s Pod 状态                      │
│  • /api/history        → Prometheus 时序数据               │
│  • /api/alerts        → 智能告警检测                       │
└──────────────────────────┬──────────────────────────────────┘
                           │
        ┌─────────────────┼─────────────────┐
        ▼                 ▼                 ▼
   ┌─────────┐      ┌──────────┐      ┌─────────┐
   │  主机   │      │Prometheus│      │K8s API  │
   │ /proc   │      │ 时序数据库│      │kubectl  │
   └─────────┘      └──────────┘      └─────────┘
                           │
                           ▼
                    ┌─────────────┐
                    │DCGM Exporter│
                    │ (GPU 监控)  │
                    └─────────────┘
```

## ✨ 核心功能

| 功能 | 描述 |
|------|------|
| **实时监控** | CPU、内存、磁盘、GPU 利用率 5秒刷新 |
| **历史曲线** | 最近 30 分钟数据趋势图 (Chart.js) |
| **Pod 监控** | K8s 所有 Pod 状态实时展示 |
| **智能告警** | 三级告警 (轻微/严重/紧急) + 修复建议 |
| **自动检测** | Pod 状态变化、资源阈值、异常告警 |

## 🔔 告警阈值

| 级别 | 阈值条件 | 示例 |
|------|----------|------|
| 🟡 轻微 | > 70% | CPU/内存/磁盘使用率偏高 |
| 🟠 严重 | > 85% | GPU 显存紧张、Pod Pending |
| 🔴 紧急 | > 95% | 资源耗尽、Pod Failed |

## 🛠️ 技术栈

- **前端**: HTML5 + CSS3 + Chart.js
- **后端**: Node.js (原生 http，无框架)
- **数据源**: Prometheus + node_exporter + DCGM Exporter
- **容器编排**: K3s / Kubernetes
- **GPU 监控**: NVIDIA DCGM Exporter

## 🚀 快速开始

### 1. 克隆项目

```bash
git clone https://github.com/fuqiangfeng96-web/k8s-llm-monitor.git
cd k8s-llm-monitor
```

### 2. 安装依赖

```bash
# Node.js 环境 (已包含在项目中，无需额外安装)
```

### 3. 启动服务

```bash
# 直接运行
node monitor_server.js

# 或后台运行
nohup node monitor_server.js > monitor.log 2>&1 &
```

### 4. 访问监控面板

```
http://<your-server-ip>:8888
```

## 📁 项目结构

```
k8s-llm-monitor/
├── monitor.html          # 前端监控页面
├── monitor_server.js     # Node.js 后端服务
├── logo.svg             # 项目 Logo
├── README.md            # 项目说明
└── 监控面板-面试介绍.md # 面试演示文档
```

## 🔧 配置说明

### 端口配置

| 端口 | 用途 |
|------|------|
| 8888 | Web 服务端口 |

### Prometheus 配置

确保 Prometheus 已配置以下抓取目标：

- node-exporter (9100) - 主机指标
- dcgm-exporter (9400) - GPU 指标
- kube-state-metrics (8080) - K8s 资源状态

## 📊 页面预览

监控面板包含：
- 实时指标卡片 (CPU/内存/磁盘/GPU)
- 历史曲线图 (30分钟趋势)
- Pod 状态列表
- 三级告警系统

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

## 📄 许可证

MIT License

---

*如果对你有帮助，欢迎 Star ⭐*
