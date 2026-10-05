#!/usr/bin/env bash
# 靠泊预订改期（调整已生效的靠泊预订）—— curl 调用示例
#
# 港口调度员调整【仍有效】的靠泊预订：提交原预订 ID（路径）、新泊位、带时区起止时刻与调整号。
#   - 释放旧窗口与占用新窗口在同一事务内原子完成：旧记录保留为已取消并关联新记录
#     （replacedByBookingId），新记录继承原审查/卸港及冻结的清单修订号与实际卸箱数；
#   - 无效时刻 / 已取消原预订 / 调整号冲突 / 新窗口被占用 -> 不改变原预订；
#   - 新窗口沿用同一套规则：同审查同港唯一、同港同泊位跨航次不重叠、半开区间首尾相接可用；
#   - 调整号在同一原预订内唯一：同号同内容重试 -> 新记录当前状态（replay:true）；
#     同号改内容 -> 409 冲突；起止时刻按绝对时刻比较（等效时区写法视为相同）；
#   - 原提交号重试、取消与查询行为保持不变。
#
# 前置：无。本脚本自包含：登记航次 -> 配载 -> 签发清单 -> 创建可行卸货审查 -> 首次预订。
#
# 用法: BASE=http://localhost:3000 bash examples/adjust-curl.sh
set -euo pipefail

BASE="${BASE:-http://localhost:3000}"
API="$BASE/api"

say() { printf '\n=== %s ===\n' "$1"; }
jq_or_cat() { command -v jq >/dev/null 2>&1 && jq . || cat; }

# 0. 准备：登记航次 + 配载 rev1 + 签发清单 + 可行卸货审查 + 首次预订 SIN
say "0) 准备：登记航次 + 配载 + 签发清单(rev=1) + 卸货审查 + 首次预订"
# 同港同泊位窗口互斥跨航次全局生效：泊位名带本次运行后缀，脚本可重复执行
SUF="$(date +%s)"
B7="B-7-$SUF"; B8="B-8-$SUF"; B9="B-9-$SUF"

VOYAGE_JSON=$(curl -sS -X POST "$API/voyages" -H 'content-type: application/json' -d '{
  "voyageNo": "V-ADJUST-'"$SUF"'",
  "bays": 2, "rows": 1, "tiers": 3,
  "defaultColumnWeightLimit": "10000",
  "boxes": [
    { "boxNo": "BOX-1", "weight": "500", "category": "1" },
    { "boxNo": "BOX-2", "weight": "500", "category": "1" },
    { "boxNo": "BOX-3", "weight": "500", "category": "1" },
    { "boxNo": "BOX-4", "weight": "500", "category": "1" }
  ]
}')
VID=$(echo "$VOYAGE_JSON" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
echo "voyageId=$VID"

curl -sS -X POST "$API/voyages/$VID/moves" -H 'content-type: application/json' -d '{
  "baseRevision": 0,
  "moves": [
    { "boxNo": "BOX-1", "position": { "bay": 1, "row": 1, "tier": 0 } },
    { "boxNo": "BOX-2", "position": { "bay": 1, "row": 1, "tier": 1 } },
    { "boxNo": "BOX-3", "position": { "bay": 1, "row": 1, "tier": 2 } },
    { "boxNo": "BOX-4", "position": { "bay": 2, "row": 1, "tier": 0 } }
  ]
}' >/dev/null
curl -sS -X POST "$API/voyages/$VID/manifests" -H 'content-type: application/json' \
  -d '{ "expectedRevision": 1 }' >/dev/null

REVIEW_JSON=$(curl -sS -X POST "$API/voyages/$VID/manifests/1/discharge-reviews" \
  -H 'content-type: application/json' -d '{
  "ports": ["SHA", "SIN", "HAM"],
  "items": [
    { "boxNo": "BOX-1", "dischargePort": "SIN" },
    { "boxNo": "BOX-2", "dischargePort": "SIN" },
    { "boxNo": "BOX-3", "dischargePort": "SHA" },
    { "boxNo": "BOX-4", "dischargePort": "HAM" }
  ]
}')
RID=$(echo "$REVIEW_JSON" | sed -n 's/.*"reviewId":"\([^"]*\)".*/\1/p' | head -1)
echo "reviewId=$RID"

BOOK_JSON=$(curl -sS -X POST "$API/discharge-reviews/$RID/berth-bookings" \
  -H 'content-type: application/json' -d '{
  "reviewId": "'"$RID"'",
  "dischargePort": "SIN",
  "berth": "'"$B7"'",
  "startAt": "2026-10-10T08:00:00+08:00",
  "endAt":   "2026-10-10T12:00:00+08:00",
  "submissionNo": "SUB-001"
}')
BID=$(echo "$BOOK_JSON" | sed -n 's/.*"bookingId":"\([^"]*\)".*/\1/p' | head -1)
echo "bookingId=$BID  (SIN / $B7 / 2026-10-10 08:00-12:00 +08:00)"

# 1. 无效时刻改期 -> 400 invalid_time_window（原预订保持不变，随后第 2 步可正常改期）
say "1) 缺少时区的时刻 -> 400 invalid_time_window（原预订不变）"
curl -sS -X POST "$API/berth-bookings/$BID/adjust" -H 'content-type: application/json' -d '{
  "berth": "'"$B8"'",
  "startAt": "2026-10-10T13:00:00",
  "endAt":   "2026-10-10T16:00:00",
  "adjustmentNo": "ADJ-000"
}' | jq_or_cat

# 2. 首次改期：B-7 -> B-8，窗口平移到 13:00-16:00（原子：旧记录取消并关联新记录）
say "2) 首次改期 $BID -> $B8 / 2026-10-10 13:00-16:00 +08:00 / ADJ-001"
ADJ_JSON=$(curl -sS -X POST "$API/berth-bookings/$BID/adjust" -H 'content-type: application/json' -d '{
  "berth": "'"$B8"'",
  "startAt": "2026-10-10T13:00:00+08:00",
  "endAt":   "2026-10-10T16:00:00+08:00",
  "adjustmentNo": "ADJ-001"
}')
echo "$ADJ_JSON" | jq_or_cat
NEW_BID=$(echo "$ADJ_JSON" | sed -n 's/.*"booking":{"bookingId":"\([^"]*\)".*/\1/p' | head -1)
echo "newBookingId=$NEW_BID （继承审查/卸港/冻结快照；旧记录 replacedByBookingId 指向它）"

# 3. 同调整号同内容重试（UTC 等效写法指向同一绝对时刻）-> 200 replay:true 返回新记录当前状态
say "3) 同调整号 + 同内容（等效时区）重试 -> replay:true，返回新记录当前状态"
curl -sS -X POST "$API/berth-bookings/$BID/adjust" -H 'content-type: application/json' -d '{
  "berth": "'"$B8"'",
  "startAt": "2026-10-10T05:00:00Z",
  "endAt":   "2026-10-10T08:00:00Z",
  "adjustmentNo": "ADJ-001"
}' | jq_or_cat

# 4. 同调整号改内容 -> 409 booking_adjustment_conflict（新记录不变）
say "4) 同调整号改泊位 -> 409 booking_adjustment_conflict"
curl -sS -X POST "$API/berth-bookings/$BID/adjust" -H 'content-type: application/json' -d '{
  "berth": "'"$B9"'",
  "startAt": "2026-10-10T13:00:00+08:00",
  "endAt":   "2026-10-10T16:00:00+08:00",
  "adjustmentNo": "ADJ-001"
}' | jq_or_cat

# 5. 原预订已被改期取代（不再是有效预订）-> 409 booking_not_active
say "5) 用新调整号再改原预订（已被取代）-> 409 booking_not_active"
curl -sS -X POST "$API/berth-bookings/$BID/adjust" -H 'content-type: application/json' -d '{
  "berth": "'"$B9"'",
  "startAt": "2026-10-10T13:00:00+08:00",
  "endAt":   "2026-10-10T16:00:00+08:00",
  "adjustmentNo": "ADJ-003"
}' | jq_or_cat

# 6. 链式改期：对新记录再次改期（调整号按各原预订隔离，新窗口与自身旧窗口重叠也允许）
say "6) 链式改期：调整新记录 $NEW_BID -> 同泊位窗口后移 / ADJ-101"
curl -sS -X POST "$API/berth-bookings/$NEW_BID/adjust" -H 'content-type: application/json' -d '{
  "berth": "'"$B8"'",
  "startAt": "2026-10-10T15:00:00+08:00",
  "endAt":   "2026-10-10T19:00:00+08:00",
  "adjustmentNo": "ADJ-101"
}' | jq_or_cat

# 7. 原提交号重试行为不变：仍返回原预订当前状态（已取消并关联新记录）
say "7) 原提交号 SUB-001 同内容重试 -> replay:true，返回原预订（已取消）"
curl -sS -X POST "$API/discharge-reviews/$RID/berth-bookings" -H 'content-type: application/json' -d '{
  "reviewId": "'"$RID"'",
  "dischargePort": "SIN",
  "berth": "'"$B7"'",
  "startAt": "2026-10-10T08:00:00+08:00",
  "endAt":   "2026-10-10T12:00:00+08:00",
  "submissionNo": "SUB-001"
}' | jq_or_cat

# 8. 查询：按审查列出全部记录（改期链保留、互相关联）
say "8) 按审查查询预订列表（含已取消的改期链）"
curl -sS "$API/discharge-reviews/$RID/berth-bookings" | jq_or_cat

echo
echo "完成。"
