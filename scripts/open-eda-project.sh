#!/usr/bin/env bash
# 可复现地把嘉立创EDA从「开始页」带到指定工程/页面。
# 依赖：EDA 以 --remote-debugging-port=9222 启动（见 scripts/launch-eda.sh）
set -euo pipefail
PROJECT_UUID="${1:-ba4924190e3a4388a097f3dee090da20}"
PAGE_UUID="${2:-87dba2a22fe7096e}"
CDP="${CDP:-http://127.0.0.1:9222}"

echo "[1/3] 导航到工程路由"
node /tmp/cdp_nav.mjs "https://pro.lceda.cn/editor#id=${PROJECT_UUID}" 6000 || true
sleep 20

echo "[2/3] 打开目标原理图页并激活"
cd "$(dirname "$0")/.."
node -e '
import("./.work/eda.mjs").then(async ({exec})=>{
  const r = await exec(`const tabId=await eda.dmt_EditorControl.openDocument("'"$PAGE_UUID"'"); if(!tabId) return {opened:false}; await new Promise(r=>setTimeout(r,1200)); const act=await eda.dmt_EditorControl.activateDocument(tabId); return {opened:true,tabId,act};`,90000);
  console.log(JSON.stringify(r.result||r));
})' || true

echo "[3/3] 校验器件读取；失败则 reload 页面后重试一次"
cd "$(dirname "$0")/.."
node -e '
import("./.work/eda.mjs").then(async ({exec})=>{
  const A=async()=>exec(`const all=((await eda.sch_PrimitiveComponent.getAll())||[]); return {n:all.length};`,60000).catch(e=>({error:String(e.message||e).slice(0,60)}));
  let r=await A(); console.log("first", JSON.stringify(r.result||r));
  if(r.error||!r.result){ await import("node:child_process").then(cp=>cp.execSync("node /tmp/cdp_reload.mjs")); await new Promise(x=>setTimeout(x,30000)); r=await A(); console.log("after-reload", JSON.stringify(r.result||r)); }
})' || true
