#!/bin/bash
# 角色筛选机 2.0 一键启动脚本

PYTHON="/opt/anaconda3/envs/chara-filter/bin/python"
export PYTHONUNBUFFERED=1
DIR="$(cd "$(dirname "$0")" && pwd)"

echo "================================================"
echo "  角色筛选机 2.0 启动中..."
echo "================================================"

# 清理旧的日志
rm -f /tmp/python-proxy.log /tmp/node-server.log

# 杀掉旧进程（如有）
pkill -f "python_proxy.py" 2>/dev/null
pkill -f "node server.js" 2>/dev/null
sleep 1

# 启动 Python API 代理（端口 5005）
echo "[1/2] 启动 Python API 代理（端口 5005）..."
nohup "$PYTHON" "$DIR/python_proxy.py" > /tmp/python-proxy.log 2>&1 &
PROXY_PID=$!
echo "      PID: $PROXY_PID"

# 启动 Node.js 主服务（端口 3115）
echo "[2/2] 启动 Node.js 主服务（端口 3115，内置 JS CLIP）..."
nohup node "$DIR/server.js" > /tmp/node-server.log 2>&1 &
NODE_PID=$!
echo "      PID: $NODE_PID"

# 等待服务启动
echo ""
echo "等待服务启动..."
sleep 4

# 检查状态
echo ""
echo "================================================"
echo "  服务状态检查"
echo "================================================"

check_port() {
    lsof -i :$1 | grep LISTEN > /dev/null 2>&1
}

if check_port 5005; then
    echo "  [OK] Python 代理    http://localhost:5005"
else
    echo "  [!!] Python 代理未就绪"
fi

if check_port 3115; then
    echo "  [OK] 主服务         http://localhost:3115"
else
    echo "  [!!] 主服务未就绪"
fi

echo ""
echo "  浏览器访问: http://localhost:3115"
echo "  JS CLIP 首次启动会自动下载模型到本地缓存，请耐心等待"
echo ""
echo "  日志查看:"
echo "    Python 代理: tail -f /tmp/python-proxy.log"
echo "    Node 服务:   tail -f /tmp/node-server.log"
echo "================================================"
