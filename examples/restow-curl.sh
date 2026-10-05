#!/usr/bin/env bash
# 逐港倒箱作业方案 —— curl 调用示例
#
# 调度员对【已留档的港序卸货审查】提交逐港倒箱作业方案：非负临时堆位容量 +
# 每港按序的暂存（stage）/回放（replay）操作。服务以审查对应清单的冻结箱位及
# 该清单修订号当时的安全约束为基准逐港模拟：
#   - 每港开始及每步后反复卸走列顶且属于本港的可及箱；
#   - 只能暂存“当前列顶且属于后续港”的箱，回放只能落回原列当前栈顶空位；
#   - 同箱不得重复暂存、容量不得超限、暂存箱不得跨港滞留；
#   - 任一步违反列承重/危险品间距，或港末仍有本港箱受阻，整份拒绝、不留档。
# 成功则按港返回操作后箱位、实际卸箱与倒箱次数（每次暂存计一次），方案冻结供查询。
#
# 前置：无。本脚本自包含：登记 -> 配载 -> 签发清单 -> 卸货审查。
#
# 用法: BASE=http://localhost:3000 bash examples/restow-curl.sh
set -euo pipefail

BASE="${BASE:-http://localhost:3000}"
API="$BASE/api"

say() { printf '\n=== %s ===\n' "$1"; }
jq_or_cat() { command -v jq >/dev/null 2>&1 && jq . || cat; }

# 0. 准备：2 bay × 1 row × 3 tier；列1 三层 BOX-1/2/3，列2 BOX-4；配载并签发清单 rev=1
say "0) 准备：登记航次 + 配载 + 签发清单（rev=1）"
VOYAGE_JSON=$(curl -sS -X POST "$API/voyages" -H 'content-type: application/json' -d '{
  "voyageNo": "V-RESTOW-'"$(date +%s)"'",
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
echo "已签发清单 rev=1"

# 卸货审查（不倒箱不可行：BOX-1(SHA) 被 BOX-2(SIN)/BOX-3(HAM) 压住）
REVIEW_JSON=$(curl -sS -X POST "$API/voyages/$VID/manifests/1/discharge-reviews" \
  -H 'content-type: application/json' -d '{
  "ports": ["SHA", "SIN", "HAM"],
  "items": [
    { "boxNo": "BOX-1", "dischargePort": "SHA" },
    { "boxNo": "BOX-2", "dischargePort": "SIN" },
    { "boxNo": "BOX-3", "dischargePort": "HAM" },
    { "boxNo": "BOX-4", "dischargePort": "SHA" }
  ]
}')
RID=$(echo "$REVIEW_JSON" | sed -n 's/.*"reviewId":"\([^"]*\)".*/\1/p' | head -1)
echo "reviewId=$RID（feasibleWithoutRestow=$(echo "$REVIEW_JSON" | sed -n 's/.*"feasibleWithoutRestow":\([a-z]*\).*/\1/p' | head -1)）"
PLANS_URL="$API/discharge-reviews/$RID/restow-plans"

# 1. 成功倒箱方案：容量 2；SHA 暂存 BOX-3、BOX-2 露出 BOX-1，
#    回放时先放远港箱 BOX-3(HAM) 落 t0、再放近港箱 BOX-2(SIN) 落 t1，
#    使近港箱回列顶 -> SIN 自动卸 BOX-2、HAM 自动卸 BOX-3，每箱仅暂存一次（共 2 次倒箱）。
say "1) 成功方案：SHA 暂存两压箱卸 BOX-1，远港箱先回放使后续港无需再倒箱"
PLAN_JSON=$(curl -sS -X POST "$PLANS_URL" -H 'content-type: application/json' -d '{
  "temporaryCapacity": 2,
  "portPlans": [
    {
      "port": "SHA",
      "operations": [
        { "op": "stage",  "boxNo": "BOX-3" },
        { "op": "stage",  "boxNo": "BOX-2" },
        { "op": "replay", "boxNo": "BOX-3" },
        { "op": "replay", "boxNo": "BOX-2" }
      ]
    },
    { "port": "SIN", "operations": [] },
    { "port": "HAM", "operations": [] }
  ]
}')
echo "$PLAN_JSON" | jq_or_cat
PID=$(echo "$PLAN_JSON" | sed -n 's/.*"planId":"\([^"]*\)".*/\1/p' | head -1)
echo "planId=$PID"

# 2. 同一审查同一内容重试 -> 200 replay:true（返回首次冻结结果）
say "2) 同一内容重试 -> 200 replay:true"
curl -sS -X POST "$PLANS_URL" -H 'content-type: application/json' -d '{
  "temporaryCapacity": 2,
  "portPlans": [
    {
      "port": "SHA",
      "operations": [
        { "op": "stage",  "boxNo": "BOX-3" },
        { "op": "stage",  "boxNo": "BOX-2" },
        { "op": "replay", "boxNo": "BOX-3" },
        { "op": "replay", "boxNo": "BOX-2" }
      ]
    },
    { "port": "SIN", "operations": [] },
    { "port": "HAM", "operations": [] }
  ]
}' | jq_or_cat

# 3. 容量不足：容量 1 只能暂存 BOX-3，露出的列顶是 BOX-2(SIN)，BOX-1 仍被压 -> 港末受阻
say "3) 容量 1 解不开两层压箱 -> 422 restow_plan_rejected / port_boxes_blocked（BOX-1）"
curl -sS -X POST "$PLANS_URL" -H 'content-type: application/json' -d '{
  "temporaryCapacity": 1,
  "portPlans": [
    { "port": "SHA", "operations": [
      { "op": "stage", "boxNo": "BOX-3" },
      { "op": "replay", "boxNo": "BOX-3" }
    ] },
    { "port": "SIN", "operations": [] },
    { "port": "HAM", "operations": [] }
  ]
}'; echo

# 4. 超容量：容量 1 却连续暂存两个
say "4) 暂存超容量 -> 422 temporary_capacity_exceeded（BOX-2）"
curl -sS -X POST "$PLANS_URL" -H 'content-type: application/json' -d '{
  "temporaryCapacity": 1,
  "portPlans": [
    { "port": "SHA", "operations": [
      { "op": "stage", "boxNo": "BOX-3" },
      { "op": "stage", "boxNo": "BOX-2" }
    ] },
    { "port": "SIN", "operations": [] },
    { "port": "HAM", "operations": [] }
  ]
}'; echo

# 5. 非法操作：暂存非列顶箱 / 暂存本港箱（已自动卸走）/ 同箱重复暂存 / 回放未暂存箱
say "5a) 暂存非列顶箱 -> 422 stage_box_not_column_top（列顶为 BOX-3）"
curl -sS -X POST "$PLANS_URL" -H 'content-type: application/json' -d '{
  "temporaryCapacity": 2,
  "portPlans": [
    { "port": "SHA", "operations": [{ "op": "stage", "boxNo": "BOX-2" }] },
    { "port": "SIN", "operations": [] },
    { "port": "HAM", "operations": [] }
  ]
}'; echo

say "5b) 同箱重复暂存（回放后再暂存）-> 422 box_already_staged"
curl -sS -X POST "$PLANS_URL" -H 'content-type: application/json' -d '{
  "temporaryCapacity": 2,
  "portPlans": [
    { "port": "SHA", "operations": [
      { "op": "stage",  "boxNo": "BOX-3" },
      { "op": "replay", "boxNo": "BOX-3" },
      { "op": "stage",  "boxNo": "BOX-3" }
    ] },
    { "port": "SIN", "operations": [] },
    { "port": "HAM", "operations": [] }
  ]
}'; echo

say "5c) 回放未暂存箱 -> 422 replay_box_not_staged"
curl -sS -X POST "$PLANS_URL" -H 'content-type: application/json' -d '{
  "temporaryCapacity": 2,
  "portPlans": [
    { "port": "SHA", "operations": [{ "op": "replay", "boxNo": "BOX-1" }] },
    { "port": "SIN", "operations": [] },
    { "port": "HAM", "operations": [] }
  ]
}'; echo

say "5d) 港末暂存箱未回放（跨港滞留）-> 422 staged_boxes_left_at_port_end"
curl -sS -X POST "$PLANS_URL" -H 'content-type: application/json' -d '{
  "temporaryCapacity": 2,
  "portPlans": [
    { "port": "SHA", "operations": [
      { "op": "stage", "boxNo": "BOX-3" },
      { "op": "stage", "boxNo": "BOX-2" }
    ] },
    { "port": "SIN", "operations": [] },
    { "port": "HAM", "operations": [] }
  ]
}'; echo

# 6. 结构级 400：港序与审查不一致 / 清单外箱 / 负容量
say "6a) 港序与审查不一致 -> 400 invalid_restow_request（port_order_mismatch）"
curl -sS -X POST "$PLANS_URL" -H 'content-type: application/json' -d '{
  "temporaryCapacity": 2,
  "portPlans": [
    { "port": "SIN", "operations": [] },
    { "port": "SHA", "operations": [] },
    { "port": "HAM", "operations": [] }
  ]
}'; echo

say "6b) 负容量 -> 400 invalid_request_body"
curl -sS -X POST "$PLANS_URL" -H 'content-type: application/json' -d '{
  "temporaryCapacity": -1,
  "portPlans": [
    { "port": "SHA", "operations": [] },
    { "port": "SIN", "operations": [] },
    { "port": "HAM", "operations": [] }
  ]
}'; echo

# 7. 未知审查 / 未知方案 -> 404
say "7) 未知审查 -> 404 discharge_review_not_found"
curl -sS -X POST "$API/discharge-reviews/00000000-0000-0000-0000-000000000000/restow-plans" \
  -H 'content-type: application/json' -d '{
  "temporaryCapacity": 1,
  "portPlans": [{ "port": "SHA", "operations": [] }]
}'; echo

# 8. 查询：按审查列出全部方案 / 取单条冻结结果
say "8a) 按审查列出倒箱方案（不同内容分别留档；被拒绝的不留档）"
curl -sS "$PLANS_URL" | jq_or_cat

say "8b) 取单条方案冻结结果"
curl -sS "$API/restow-plans/$PID" | jq_or_cat
