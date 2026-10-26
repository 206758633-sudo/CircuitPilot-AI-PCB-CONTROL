#!/usr/bin/env bash
# 启动嘉立创EDA（专业版）并开启 CDP 调试端口。
#
# 关键：本机 shell 环境里存在 ELECTRON_RUN_AS_NODE=1（DSH/Node 工具链设置），
# 它会让 Electron 以 Node 模式运行 app.js，表现为"双击没反应/进程秒退/参数报 bad option"。
# 因此这里必须 env -u 清掉它再启动。
set -euo pipefail
APP="/Applications/嘉立创EDA(专业版).app"
PORT="${1:-9222}"
if pgrep -f "LCEDA-Pro" >/dev/null 2>&1; then
  echo "EDA 已在运行（pid $(pgrep -f LCEDA-Pro | head -1)），跳过启动"
else
  env -u ELECTRON_RUN_AS_NODE "$APP/Contents/MacOS/LCEDA-Pro" --remote-debugging-port="$PORT" \
    > /tmp/lceda-run.log 2>&1 &
  echo "已启动 EDA（CDP 端口 $PORT）"
fi
for i in $(seq 1 30); do
  if curl -s -m 2 "http://127.0.0.1:${PORT}/json/list" | grep -q '"type": "page"'; then
    echo "CDP 就绪: http://127.0.0.1:${PORT}"
    exit 0
  fi
  sleep 1
done
echo "CDP 未就绪，检查 /tmp/lceda-run.log" >&2
exit 1
