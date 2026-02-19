#!/usr/bin/env node
/**
 * 监控面板后端 API - 带历史曲线
 */
const http = require('http');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = 8888;
const PROMETHEUS_URL = 'http://localhost:9090';

// ============= 辅助函数 =============
function httpGet(url) {
    return new Promise((resolve, reject) => {
        http.get(url, res => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch { resolve(null); }
            });
        }).on('error', reject);
    });
}

async function queryPrometheus(query) {
    try {
        const url = `${PROMETHEUS_URL}/api/v1/query?query=${encodeURIComponent(query)}`;
        const data = await httpGet(url);
        if (data && data.status === 'success' && data.data.result.length > 0) {
            return parseFloat(data.data.result[0].value[1]);
        }
    } catch (e) { console.error('Prom query error:', query, e.message); }
    return null;
}

async function queryRangePrometheus(query, duration = '30m', step = '30s') {
    try {
        const end = Math.floor(Date.now() / 1000);
        const start = end - parseDuration(duration);
        const url = `${PROMETHEUS_URL}/api/v1/query_range?query=${encodeURIComponent(query)}&start=${start}&end=${end}&step=${step}`;
        const data = await httpGet(url);
        if (data && data.status === 'success') {
            return data.data.result.map(r => ({
                time: r.values.map(v => v[0] * 1000),
                value: r.values.map(v => parseFloat(v[1]))
            }));
        }
    } catch (e) { console.error('Prom range error:', query, e.message); }
    return [];
}

function parseDuration(s) {
    const m = s.match(/(\d+)([smhd])/);
    if (!m) return 1800;
    const v = parseInt(m[1]);
    if (m[2] === 's') return v;
    if (m[2] === 'm') return v * 60;
    if (m[2] === 'h') return v * 3600;
    if (m[2] === 'd') return v * 86400;
    return 1800;
}

// ============= 实时指标 =============
function getHostMetrics() {
    try {
        const loadavg = fs.readFileSync('/proc/loadavg', 'utf8').trim().split(' ');
        const meminfo = fs.readFileSync('/proc/meminfo', 'utf8');
        const memTotal = parseInt(meminfo.match(/MemTotal:\s+(\d+)/)[1]) * 1024;
        const memAvail = parseInt(meminfo.match(/MemAvailable:\s+(\d+)/)[1]) * 1024;
        const df = execSync('df -B1 /', { encoding: 'utf8' });
        const dfParts = df.trim().split('\n')[1].split(/\s+/);
        
        return {
            cpu: { load_1min: parseFloat(loadavg[0]), percent: ((parseFloat(loadavg[0]) / 8) * 100).toFixed(1) },
            memory: { total: memTotal, used: memTotal - memAvail, percent: (((memTotal - memAvail) / memTotal) * 100).toFixed(1) },
            disk: { total: parseInt(dfParts[1]), used: parseInt(dfParts[2]), percent: (parseInt(dfParts[2]) / parseInt(dfParts[1]) * 100).toFixed(1) }
        };
    } catch (e) { return { cpu: {}, memory: {}, disk: {} }; }
}

function getGpuMetrics() {
    try {
        const output = execSync('nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu --format=csv,noheader,nounits', { encoding: 'utf8' });
        const gpus = [];
        output.trim().split('\n').forEach(line => {
            if (line.trim()) {
                const p = line.split(',').map(x => x.trim());
                gpus.push({ name: p[1], utilization: parseInt(p[2]), memoryUsed: parseInt(p[3]), memoryTotal: parseInt(p[4]), temperature: parseInt(p[5]) });
            }
        });
        return gpus;
    } catch (e) { return []; }
}

function getK8sPods() {
    try {
        const output = execSync('kubectl get pods -A -o json', { encoding: 'utf8' });
        const data = JSON.parse(output);
        return data.items.map(item => {
            const ns = item.metadata.namespace, name = item.metadata.name, status = item.status.phase || 'Unknown';
            let restarts = 0;
            if (item.status.containerStatuses) item.status.containerStatuses.forEach(cs => { restarts += cs.restartCount || 0; });
            let age = '0m';
            if (item.status.startTime) {
                const s = (new Date() - new Date(item.status.startTime)) / 1000;
                const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
                age = d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
            }
            return { namespace: ns, name, status, restarts, age };
        });
    } catch (e) { return []; }
}

// ============= 历史曲线数据 =============
async function getHistoryMetrics() {
    // CPU 使用率
    const cpuData = await queryRangePrometheus('100 - (avg(rate(node_cpu_seconds_total{mode="idle"}[1m])) * 100)', '30m', '30s');
    
    // 内存使用率
    const memData = await queryRangePrometheus('100 - (node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes * 100)', '30m', '30s');
    
    // 磁盘使用率
    const diskData = await queryRangePrometheus('100 - (node_filesystem_avail_bytes{mountpoint="/"} / node_filesystem_size_bytes{mountpoint="/"} * 100)', '30m', '30s');
    
    // GPU 利用率 - 使用更灵活的查询
    const gpuUtilData = await queryRangePrometheus('avg(DCGM_FI_DEV_GPU_UTIL)', '30m', '30s');
    
    // GPU 显存使用 - 使用更灵活的查询  
    const gpuMemData = await queryRangePrometheus('avg(DCGM_FI_DEV_FB_USED)', '30m', '30s');
    
    // GPU 温度
    const gpuTempData = await queryRangePrometheus('avg(DCGM_FI_DEV_GPU_TEMP)', '30m', '30s');
    
    // 处理数据格式
    const processResult = (results) => {
        if (!results || results.length === 0) return { labels: [], data: [] };
        const r = results[0];
        return {
            labels: r.time.map(t => new Date(t).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })),
            data: r.value.map(v => v.toFixed(1))
        };
    };
    
    return {
        cpu: processResult(cpuData),
        memory: processResult(memData),
        disk: processResult(diskData),
        gpuUtil: processResult(gpuUtilData),
        gpuMem: processResult(gpuMemData),
        gpuTemp: processResult(gpuTempData)
    };
}

// ============= 告警检测 =============
let lastPodStates = {}; // 上次 Pod 状态缓存

function checkAlerts(hostMetrics, gpuMetrics, pods) {
    const alerts = { minor: [], serious: [], critical: [] };
    
    const cpuPercent = parseFloat(hostMetrics.cpu.percent);
    if (cpuPercent > 95) alerts.critical.push({ title: 'CPU 使用率过高', desc: `当前 CPU 使用率 ${cpuPercent}%`, fix: '建议：1. 检查是否有异常进程 2. 考虑扩容 CPU 核心数 3. 优化占用高的服务' });
    else if (cpuPercent > 85) alerts.serious.push({ title: 'CPU 使用率偏高', desc: `当前 CPU 使用率 ${cpuPercent}%`, fix: '建议：1. 查看占用最高的进程 2. 考虑升级 CPU 或增加实例 3. 检查是否有DDOS攻击' });
    else if (cpuPercent > 70) alerts.minor.push({ title: 'CPU 使用率轻度偏高', desc: `当前 CPU 使用率 ${cpuPercent}%`, fix: '建议：持续监控，必要时考虑扩容' });
    
    const memPercent = parseFloat(hostMetrics.memory.percent);
    if (memPercent > 95) alerts.critical.push({ title: '内存使用率过高', desc: `当前内存使用率 ${memPercent}%`, fix: '建议：立即释放缓存 echo 3 > /proc/sys/vm/drop_caches 2. 重启占用内存大的服务 3. 扩容内存' });
    else if (memPercent > 85) alerts.serious.push({ title: '内存使用率偏高', desc: `当前内存使用率 ${memPercent}%`, fix: '建议：1. 检查内存泄漏 2. 增加 Swap 3. 考虑扩容内存' });
    else if (memPercent > 70) alerts.minor.push({ title: '内存使用率轻度偏高', desc: `当前内存使用率 ${memPercent}%`, fix: '建议：关注内存趋势，必要时扩容' });
    
    const diskPercent = parseFloat(hostMetrics.disk.percent);
    if (diskPercent > 95) alerts.critical.push({ title: '磁盘空间不足', desc: `磁盘使用率 ${diskPercent}%`, fix: '建议：1. 立即清理日志文件 2. 删除不必要的镜像/容器 3. 扩容磁盘' });
    else if (diskPercent > 85) alerts.serious.push({ title: '磁盘空间紧张', desc: `磁盘使用率 ${diskPercent}%`, fix: '建议：1. 清理旧日志 2. 删除临时文件 3. 计划扩容' });
    else if (diskPercent > 70) alerts.minor.push({ title: '磁盘使用率偏高', desc: `磁盘使用率 ${diskPercent}%`, fix: '建议：关注磁盘增长趋势，定期清理' });
    
    if (gpuMetrics.length > 0) {
        const gpu = gpuMetrics[0];
        const gpuMemPercent = (gpu.memoryUsed / gpu.memoryTotal) * 100;
        if (gpuMemPercent > 95) alerts.critical.push({ title: 'GPU 显存不足', desc: `GPU 显存使用 ${gpu.memoryUsed}/${gpu.memoryTotal} MB (${gpuMemPercent.toFixed(1)}%)`, fix: '建议：1. 减少 batch_size 2. 使用模型量化 3. 扩容 GPU 或使用多卡' });
        else if (gpuMemPercent > 85) alerts.serious.push({ title: 'GPU 显存使用偏高', desc: `GPU 显存使用 ${gpu.memoryUsed}/${gpu.memoryTotal} MB (${gpuMemPercent.toFixed(1)}%)`, fix: '建议：监控模型推理性能，考虑优化显存使用' });
        else if (gpuMemPercent > 70) alerts.minor.push({ title: 'GPU 显存使用偏高', desc: `GPU 显存使用 ${gpu.memoryUsed}/${gpu.memoryTotal} MB (${gpuMemPercent.toFixed(1)}%)`, fix: '建议：持续监控 GPU 显存使用情况' });
        if (gpu.temperature > 85) alerts.critical.push({ title: 'GPU 温度过高', desc: `GPU 温度 ${gpu.temperature}°C`, fix: '建议：1. 检查 GPU 散热风扇 2. 降低计算负载 3. 增加机房空调' });
        else if (gpu.temperature > 75) alerts.serious.push({ title: 'GPU 温度偏高', desc: `GPU 温度 ${gpu.temperature}°C`, fix: '建议：关注温度趋势，检查散热系统' });
    }
    
    // Pod 告警 - 状态变化检测
    const currentPodStates = {};
    pods.forEach(pod => {
        const key = `${pod.namespace}/${pod.name}`;
        currentPodStates[key] = { status: pod.status, restarts: pod.restarts, age: pod.age };
        
        // 记录当前状态
        if (!lastPodStates[key]) {
            lastPodStates[key] = { status: 'Unknown', restarts: 0, age: '0m' };
        }
        
        const lastState = lastPodStates[key];
        
        // 检测状态变化（从非 Running 变为 Running - 表示刚恢复）
        if (lastState.status !== 'Running' && pod.status === 'Running') {
            alerts.serious.push({
                title: `Pod 刚恢复: ${pod.name}`,
                desc: `命名空间: ${pod.namespace}, 之前状态: ${lastState.status}`,
                fix: `建议：检查之前故障原因 kubectl describe pod ${pod.name} -n ${pod.namespace}`
            });
        }
        
        // 检测重启次数增加
        if (pod.restarts > lastState.restarts && pod.restarts > 0) {
            alerts.serious.push({
                title: `Pod 重启: ${pod.name}`,
                desc: `命名空间: ${pod.namespace}, 重启次数: ${pod.restarts}次 (增加了${pod.restarts - lastState.restarts}次)`,
                fix: `建议：kubectl logs ${pod.name} -n ${pod.namespace} --previous 查看重启前日志`
            });
        }
        
        // 检测运行时间很短但存在 - 可能是刚创建的
        if (pod.status === 'Running' && (pod.age.includes('s') || pod.age.includes('m'))) {
            const ageNum = parseInt(pod.age);
            if (pod.age.includes('s') || (pod.age.includes('m') && ageNum < 5)) {
                // 新创建的 Pod，给一个信息性提示
            }
        }
        
        // 原有告警逻辑保留
        if (pod.status === 'Failed' || pod.status === 'Error') {
            alerts.critical.push({ title: `Pod 异常: ${pod.name}`, desc: `命名空间: ${pod.namespace}, 状态: ${pod.status}`, fix: `建议：kubectl describe pod ${pod.name} -n ${pod.namespace}` });
        } else if (pod.status === 'Pending') {
            alerts.serious.push({ title: `Pod 等待调度: ${pod.name}`, desc: `命名空间: ${pod.namespace}`, fix: `建议：kubectl describe pod ${pod.name} -n ${pod.namespace}` });
        }
    });
    
    // 更新缓存
    lastPodStates = currentPodStates;
    
    return alerts;
}

// ============= HTTP 服务器 =============
const htmlContent = fs.readFileSync(path.join(__dirname, 'monitor.html'), 'utf8');

const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    
    if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }
    
    const url = req.url.split('?')[0];
    
    if (url === '/' || url === '/monitor.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(htmlContent);
        return;
    }
    
    // Logo 文件
    if (url === '/logo.svg') {
        res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
        res.end(fs.readFileSync(path.join(__dirname, 'logo.svg')));
        return;
    }
    
    // 单依纯图片
    if (url.startsWith('/danyichun')) {
        res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
        res.end(fs.readFileSync(path.join(__dirname, url.slice(1))));
        return;
    }
    
    try {
        if (url === '/api/host/metrics') {
            res.end(JSON.stringify(getHostMetrics()));
        } else if (url === '/api/gpu/metrics') {
            res.end(JSON.stringify(getGpuMetrics()));
        } else if (url === '/api/k8s/pods') {
            res.end(JSON.stringify(getK8sPods()));
        } else if (url === '/api/history') {
            getHistoryMetrics().then(d => res.end(JSON.stringify(d)));
            return;
        } else if (url === '/api/alerts') {
            const host = getHostMetrics();
            const gpu = getGpuMetrics();
            const pods = getK8sPods();
            const alerts = checkAlerts(host, gpu, pods);
            res.end(JSON.stringify(alerts));
            return;
        } else {
            res.writeHead(404); res.end('Not Found');
        }
    } catch (e) {
        res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
    }
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 监控面板已启动: http://localhost:${PORT}`);
});
