#!/usr/bin/env bash
# 靠泊窗口预订 —— curl 调用示例
#
# 港口调度员依据【已留档的卸货审查】预订靠泊窗口：提交审查 ID、审查内卸港、泊位、
# 带时区起止时刻与提交号。仅当该港在审查模拟中【有实际卸箱且无受阻箱】时受理；
# 受理时冻结清单修订号与该港实际卸箱数，后续调整/签发新清单不回写。
#   - 起点必须严格早于终点；同港同泊位有效窗口不得重叠（首尾相接允许），跨航次同样互斥；
#   - 同审查同卸港至多一个有效预订；提交号在同一审查内唯一：
#       同号同内容重试 -> 原预订当前状态（replay:true）；同号改内容 -> 409 冲突；
#   - 取消保留记录、释放占用（重复取消幂等）；重新预订须用新提交号。
#
# 前置：无。本脚本自包含：登记航次 -> 配载 -> 签发清单 -> 创建可行卸货审查。
#
# 用法: BASE=http://localhost:3000 bash examples/berth-curl.sh
set -euo pipefail

BASE="${BASE:-http://localhost:3000}"
API="$BASE/api"

say() { printf '\n=== %s ===\n' "$1"; }
jq_or_cat() { command -v jq >/dev/null 2>&1 && jq . || cat; }

# 0. 准备：登记航次 + 配载 rev1 + 签发清单 + 可行卸货审查
say "0) 准备：登记航次 + 配载 + 签发清单(rev=1) + 创建卸货审查"
VOYAGE_JSON=$(curl -sS -X POST "$API/voyages" -H 'content-type: application/json' -d '{
  "voyageNo": "V-BERTH-'"$(date +%s)"'",
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

# 可行审查：SHA 卸列顶 BOX-3；SIN 连锁卸 BOX-1/BOX-2；HAM 卸 BOX-4（每港都有实卸、无受阻）
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
BOOK_URL="$API/discharge-reviews/$RID/berth-bookings"

# 1. 首次预订 SIN @ B-7（冻结清单修订号=1、该港卸箱数=2）
say "1) 首次预订 SIN / B-7 / 2026-10-10 08:00-12:00 +08:00 / SUB-001"
BOOK_JSON=$(curl -sS -X POST "$BOOK_URL" -H 'content-type: application/json' -d '{
  "reviewId": "'"$RID"'",
  "dischargePort": "SIN",
  "berth": "B-7",
  "startAt": "2026-10-10T08:00:00+08:00",
  "endAt":   "2026-10-10T12:00:00+08:00",
  "submissionNo": "SUB-001"
}')
echo "$BOOK_JSON" | jq_or_cat
BID=$(echo "$BOOK_JSON" | sed -n 's/.*"bookingId":"\([^"]*\)".*/\1/p' | head -1)
echo "bookingId=$BID"

# 2. 同号同内容重试（用 UTC 等效写法指向同一绝对时刻）-> 200 replay:true
say "2) 同提交号 + 同内容（等效时区）重试 -> replay:true，返回原预订当前状态"
curl -sS -X POST "$BOOK_URL" -H 'content-type: application/json' -d '{
  "reviewId": "'"$RID"'",
  "dischargePort": "SIN",
  "berth": "B-7",
  "startAt": "2026-10-10T00:00:00Z",
  "endAt":   "2026-10-10T04:00:00Z",
  "submissionNo": "SUB-001"
}' | jq_or_cat

# 3. 同号改内容 -> 409 booking_submission_conflict
say "3) 同提交号改泊位 -> 409 booking_submission_conflict"
curl -sS -X POST "$BOOK_URL" -H 'content-type: application/json' -d '{
  "reviewId": "'"$RID"'",
  "dischargePort": "SIN",
  "berth": "B-8",
  "startAt": "2026-10-10T08:00:00+08:00",
  "endAt":   "2026-10-10T12:00:00+08:00",
  "submissionNo": "SUB-001"
}' | jq_or_cat

# 4. 同审查同卸港再订一个 -> 409 booking_exists_for_port
say "4) 同一审查同一卸港重复预订 -> 409 booking_exists_for_port"
curl -sS -X POST "$BOOK_URL" -H 'content-type: application/json' -d '{
  "reviewId": "'"$RID"'",
  "dischargePort": "SIN",
  "berth": "B-9",
  "startAt": "2026-10-11T08:00:00+08:00",
  "endAt":   "2026-10-11T12:00:00+08:00",
  "submissionNo": "SUB-002"
}' | jq_or_cat

# 5. 另一卸港 HAM 可订；首尾相接窗口可订
say "5) 预订另一卸港 HAM / B-2（与 SIN 互不影响）"
curl -sS -X POST "$BOOK_URL" -H 'content-type: application/json' -d '{
  "reviewId": "'"$RID"'",
  "dischargePort": "HAM",
  "berth": "B-2",
  "startAt": "2026-10-10T08:00:00+08:00",
  "endAt":   "2026-10-10T12:00:00+08:00",
  "submissionNo": "SUB-003"
}' | jq_or_cat

# 6. 非法时刻 -> 400 invalid_time_window
say "6) 起点不早于终点 -> 400 invalid_time_window"
curl -sS -X POST "$BOOK_URL" -H 'content-type: application/json' -d '{
  "reviewId": "'"$RID"'",
  "dischargePort": "HAM",
  "berth": "B-3",
  "startAt": "2026-10-20T09:00:00Z",
  "endAt":   "2026-10-20T08:00:00Z",
  "submissionNo": "SUB-BADTIME"
}' | jq_or_cat

say "6b) 缺少时区的本地时刻 -> 400 invalid_time_window"
curl -sS -X POST "$BOOK_URL" -H 'content-type: application/json' -d '{
  "reviewId": "'"$RID"'",
  "dischargePort": "HAM",
  "berth": "B-3",
  "startAt": "2026-10-20T08:00:00",
  "endAt":   "2026-10-20T09:00:00",
  "submissionNo": "SUB-NOTZ"
}' | jq_or_cat

# 7. 不可受理港（审查港序外）-> 400；未知审查 -> 404
say "7) 审查港序外的卸港 -> 400 unknown_discharge_port_for_review"
curl -sS -X POST "$BOOK_URL" -H 'content-type: application/json' -d '{
  "reviewId": "'"$RID"'",
  "dischargePort": "XXX",
  "berth": "B-3",
  "startAt": "2026-10-20T08:00:00Z",
  "endAt":   "2026-10-20T09:00:00Z",
  "submissionNo": "SUB-UNKNOWNPORT"
}' | jq_or_cat

say "7b) 未知审查 -> 404 discharge_review_not_found"
curl -sS -X POST "$API/discharge-reviews/00000000-0000-0000-0000-000000000000/berth-bookings" \
  -H 'content-type: application/json' -d '{
  "reviewId": "00000000-0000-0000-0000-000000000000",
  "dischargePort": "SIN",
  "berth": "B-7",
  "startAt": "2026-10-20T08:00:00Z",
  "endAt":   "2026-10-20T09:00:00Z",
  "submissionNo": "SUB-NOREVIEW"
}' | jq_or_cat

# 8. 查询：按审查 / 按航次 / 单条
say "8) 按审查查询预订列表"
curl -sS "$BOOK_URL" | jq_or_cat
say "8b) 按航次查询预订列表"
curl -sS "$API/voyages/$VID/berth-bookings" | jq_or_cat
say "8c) 查询单条预订"
curl -sS "$API/berth-bookings/$BID" | jq_or_cat

# 9. 取消 -> 200；重复取消 -> replay:true 已取消
say "9) 取消预订 $BID（记录保留、释放占用）"
curl -sS -X POST "$API/berth-bookings/$BID/cancel" | jq_or_cat
say "9b) 重复取消 -> replay:true，返回已取消状态"
curl -sS -X POST "$API/berth-bookings/$BID/cancel" | jq_or_cat

# 10. 取消后同港同泊位同时段（新提交号）可重新预订
say "10) 取消后同审查同卸港用新提交号重新预订成功"
curl -sS -X POST "$BOOK_URL" -H 'content-type: application/json' -d '{
  "reviewId": "'"$RID"'",
  "dischargePort": "SIN",
  "berth": "B-7",
  "startAt": "2026-10-10T08:00:00+08:00",
  "endAt":   "2026-10-10T12:00:00+08:00",
  "submissionNo": "SUB-004"
}' | jq_or_cat

echo
echo "完成。"
