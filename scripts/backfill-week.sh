#!/usr/bin/env bash
# 本周补跑：单浏览器会话（推荐）
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p logs
LOG="logs/backfill-week-$(date +%Y%m%d).log"
echo "日志: $LOG"
node backfill-week.js "$@" 2>&1 | tee -a "$LOG"
