#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "============================================"
echo "  Paperclip Docker 一键部署"
echo "============================================"

# -------------------------------------------------------
# Step 0: 前置检查
# -------------------------------------------------------
if ! command -v docker &>/dev/null; then
    echo "❌ docker 未安装或未在 PATH 中"
    exit 1
fi

if ! docker info &>/dev/null; then
    echo "❌ Docker daemon 未运行，请先启动 Docker Desktop 或 OrbStack"
    exit 1
fi

# 检查 .env 文件
if [ ! -f "$SCRIPT_DIR/.env" ]; then
    echo "❌ 缺少 $SCRIPT_DIR/.env 文件"
    exit 1
fi

# -------------------------------------------------------
# Step 1: 预拉取基础镜像（绕过 Docker Hub 网络问题）
# -------------------------------------------------------
echo ""
echo "📦 Step 1/3: 检查基础镜像..."

pull_if_missing() {
    local image="$1"
    local mirror="$2"
    if docker image inspect "$image" &>/dev/null; then
        echo "  ✓ $image 已存在"
    else
        echo "  ⏳ 拉取 $mirror → $image ..."
        docker pull "$mirror" && docker tag "$mirror" "$image"
        echo "  ✓ $image 完成"
    fi
}

pull_if_missing "node:lts-trixie-slim"     "docker.m.daocloud.io/library/node:lts-trixie-slim"
pull_if_missing "postgres:17-alpine"       "docker.m.daocloud.io/library/postgres:17-alpine"

# -------------------------------------------------------
# Step 2: 构建 & 启动
# -------------------------------------------------------
echo ""
echo "🔨 Step 2/3: 构建 Paperclip 镜像并启动服务（首次构建约 3-5 分钟）..."

cd "$SCRIPT_DIR"
docker compose up -d --build

# -------------------------------------------------------
# Step 3: 等待就绪 & 验证
# -------------------------------------------------------
echo ""
echo "⏳ Step 3/3: 等待服务就绪..."

# 等待 PostgreSQL 健康检查通过
echo -n "  等待数据库..."
for i in $(seq 1 60); do
    if docker compose ps db 2>/dev/null | grep -q "healthy"; then
        echo " ✓"
        break
    fi
    sleep 2
    echo -n "."
done

# 再等几秒让 server 完全启动
echo -n "  等待服务启动..."
sleep 5
echo " ✓"

echo ""
echo "============================================"
echo "  ✅ Paperclip 已启动！"
echo "  📍 http://localhost:3100"
echo ""
echo "  管理命令："
echo "    cd $SCRIPT_DIR"
echo "    docker compose logs -f server   # 查看日志"
echo "    docker compose ps               # 查看状态"
echo "    docker compose down             # 停止服务"
echo "============================================"
