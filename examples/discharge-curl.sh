#!/usr/bin/env bash
# 港序卸货审查 —— curl 调用示例
#
# 调度员对【已签发并冻结的清单】提交有序卸港列表与每箱卸港，服务按清单冻结
# 箱位逐港模拟不倒箱卸货，给出各港实际卸箱、受阻箱及其上方阻挡箱号/箱位、
# 最终逾港未卸箱与“全程无倒箱是否可行”。
#
# 前置：无。本脚本自包含：登记航次 -> 配载（同列三层堆叠 + 独立列）-> 签发清单。
#
# 用法: BASE=http://localhost:3000 bash examples/discharge-curl.sh
set -euo pipefail

BASE="${BASE:-http://localhost:3000}"
API="$BASE/api"

say() { printf '\n=== %s ===\n' "$1"; }
jq_or_cat() { command -v jq >/dev/null 2>&1 && jq . || cat; }

# 0. 准备：登记航次 + 配载 rev1 + 签发清单
#    列 (bay=1,row=1) 自底向上：BOX-1(tier0) / BOX-2(tier1) / BOX-3(tier2，列顶)
#    列 (bay=2,row=1)：BOX-4(tier0，列顶)
say "0) 准备：登记航次 + 配载 + 签发清单（rev=1）"
VOYAGE_JSON=$(curl -sS -X POST "$API/voyages" -H 'content-type: application/json' -d '{
  "voyageNo": "V-DISCHARGE-'"$(date +%s)"'",
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

REVIEWS_URL="$API/voyages/$VID/manifests/1/discharge-reviews"

# 1. 可行审查：列顶先卸、连锁卸空（全程无倒箱）
say "1) 可行港序：SHA 先卸列顶 BOX-3，SIN 连锁卸 BOX-1/BOX-2，HAM 卸 BOX-4"
OK_JSON=$(curl -sS -X POST "$REVIEWS_URL" -H 'content-type: application/json' -d '{
  "ports": ["SHA", "SIN", "HAM"],
  "items": [
    { "boxNo": "BOX-1", "dischargePort": "SIN" },
    { "boxNo": "BOX-2", "dischargePort": "SIN" },
    { "boxNo": "BOX-3", "dischargePort": "SHA" },
    { "boxNo": "BOX-4", "dischargePort": "HAM" }
  ]
}')
echo "$OK_JSON" | jq_or_cat
OK_ID=$(echo "$OK_JSON" | sed -n 's/.*"reviewId":"\([^"]*\)".*/\1/p' | head -1)
echo "reviewId=$OK_ID"

# 2. 同一提交内容重试 -> 200 replay:true（返回首次结果，不新建审查）
say "2) 同一提交内容重试 -> 200 replay:true"
curl -sS -X POST "$REVIEWS_URL" -H 'content-type: application/json' -d '{
  "ports": ["SHA", "SIN", "HAM"],
  "items": [
    { "boxNo": "BOX-1", "dischargePort": "SIN" },
    { "boxNo": "BOX-2", "dischargePort": "SIN" },
    { "boxNo": "BOX-3", "dischargePort": "SHA" },
    { "boxNo": "BOX-4", "dischargePort": "HAM" }
  ]
}' | jq_or_cat

# 3. 不可行审查：本港箱被后续港箱压住，阻挡箱带箱号与箱位，最终逾港
say "3) 不可行港序：BOX-1(SHA) 被 BOX-2(SIN)/BOX-3(HAM) 压，BOX-4(SHA) 正常卸"
BAD_JSON=$(curl -sS -X POST "$REVIEWS_URL" -H 'content-type: application/json' -d '{
  "ports": ["SHA", "SIN", "HAM"],
  "items": [
    { "boxNo": "BOX-1", "dischargePort": "SHA" },
    { "boxNo": "BOX-2", "dischargePort": "SIN" },
    { "boxNo": "BOX-3", "dischargePort": "HAM" },
    { "boxNo": "BOX-4", "dischargePort": "SHA" }
  ]
}')
echo "$BAD_JSON" | jq_or_cat
BAD_ID=$(echo "$BAD_JSON" | sed -n 's/.*"reviewId":"\([^"]*\)".*/\1/p' | head -1)
echo "reviewId=$BAD_ID"

# 4. 请求级拒绝：空/重复港序、箱号缺漏/多余、卸港不在列表
say "4a) 重复港序 -> 400 invalid_discharge_request"
curl -sS -X POST "$REVIEWS_URL" -H 'content-type: application/json' -d '{
  "ports": ["SHA", "SHA"],
  "items": [
    { "boxNo": "BOX-1", "dischargePort": "SHA" },
    { "boxNo": "BOX-2", "dischargePort": "SHA" },
    { "boxNo": "BOX-3", "dischargePort": "SHA" },
    { "boxNo": "BOX-4", "dischargePort": "SHA" }
  ]
}'; echo

say "4b) 箱号缺漏（少 BOX-1）+ 多余箱（GHOST）+ 卸港不在列表（一次返回全部 issues）"
curl -sS -X POST "$REVIEWS_URL" -H 'content-type: application/json' -d '{
  "ports": ["SHA", "SIN", "HAM"],
  "items": [
    { "boxNo": "BOX-2", "dischargePort": "SIN" },
    { "boxNo": "BOX-3", "dischargePort": "HAM" },
    { "boxNo": "BOX-4", "dischargePort": "ZZZ" },
    { "boxNo": "GHOST", "dischargePort": "SHA" }
  ]
}'; echo

say "4c) 空港序列表 -> 400 invalid_request_body"
curl -sS -X POST "$REVIEWS_URL" -H 'content-type: application/json' -d '{
  "ports": [],
  "items": [ { "boxNo": "BOX-1", "dischargePort": "SHA" } ]
}'; echo

# 5. 未知清单 / 未知审查 -> 404
say "5a) 未签发清单修订号 -> 404 manifest_not_found"
curl -sS -X POST "$API/voyages/$VID/manifests/99/discharge-reviews" \
  -H 'content-type: application/json' -d '{
    "ports": ["SHA"],
    "items": [
      { "boxNo": "BOX-1", "dischargePort": "SHA" },
      { "boxNo": "BOX-2", "dischargePort": "SHA" },
      { "boxNo": "BOX-3", "dischargePort": "SHA" },
      { "boxNo": "BOX-4", "dischargePort": "SHA" }
    ]
  }'; echo

# 6. 查询列表 / 单条冻结结果
say "6a) 审查列表（同一清单允许多次不同审查）"
curl -sS "$API/voyages/$VID/discharge-reviews" | jq_or_cat

say "6b) 按清单修订号过滤"
curl -sS "$API/voyages/$VID/discharge-reviews?manifestRevision=1" | jq_or_cat

say "6c) 取单条审查冻结结果"
curl -sS "$API/discharge-reviews/$BAD_ID" | jq_or_cat

# 7. 旧审查结果不可变：航次调整 + 签发新清单后，旧审查仍是原结论
say "7) 签发 rev=2 新清单后，再查旧审查 -> feasibleWithoutRestow 仍为 false"
curl -sS -X POST "$API/voyages/$VID/moves" -H 'content-type: application/json' -d '{
  "baseRevision": 1,
  "moves": [
    { "boxNo": "BOX-3", "position": { "bay": 1, "row": 1, "tier": 1 } },
    { "boxNo": "BOX-4", "position": { "bay": 1, "row": 1, "tier": 0 } },
    { "boxNo": "BOX-1", "position": { "bay": 2, "row": 1, "tier": 0 } },
    { "boxNo": "BOX-2", "position": { "bay": 2, "row": 1, "tier": 1 } }
  ]
}' >/dev/null
curl -sS -X POST "$API/voyages/$VID/manifests" -H 'content-type: application/json' \
  -d '{ "expectedRevision": 2 }' >/dev/null
curl -sS "$API/discharge-reviews/$BAD_ID" | jq_or_cat
echo "（旧审查仍记录 rev=1 冻结箱位下的模拟结果；新清单可在 /manifests/2/discharge-reviews 另行审查）"
