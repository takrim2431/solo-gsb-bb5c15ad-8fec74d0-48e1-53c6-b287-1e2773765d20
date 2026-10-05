#!/usr/bin/env bash
# 船舶危险货箱配载审定服务 —— curl 调用示例
# 用法: BASE=http://localhost:3000 bash examples/curl-examples.sh
set -euo pipefail

BASE="${BASE:-http://localhost:3000}"
API="$BASE/api"

say() { printf '\n=== %s ===\n' "$1"; }

say "健康检查"
curl -sS "$BASE/health"; echo

say "1) 登记航次 V-2026-001"
#  舱位: 3 bay x 2 row x 3 tier（tier 自底向上 0 起）
#  默认列承重 10000kg；列 (1,1) 单独上限 1200kg
#  不相容类别对: 类别1 与 类别3 最小曼哈顿距离 3
VOYAGE_JSON=$(curl -sS -X POST "$API/voyages" -H 'content-type: application/json' -d '{
  "voyageNo": "V-2026-001",
  "bays": 3, "rows": 2, "tiers": 3,
  "defaultColumnWeightLimit": "10000",
  "columnWeightLimits": [
    { "bay": 1, "row": 1, "weightLimit": "1200" }
  ],
  "boxes": [
    { "boxNo": "BOX-1", "weight": "500",    "category": "1" },
    { "boxNo": "BOX-2", "weight": "600",    "category": "3" },
    { "boxNo": "BOX-3", "weight": "400",    "category": "5" },
    { "boxNo": "BOX-4", "weight": "300.25", "category": "1" }
  ],
  "incompatRules": [
    { "categoryA": "1", "categoryB": "3", "minDistance": 3 }
  ]
}')
echo "$VOYAGE_JSON"
VID=$(echo "$VOYAGE_JSON" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
echo "voyageId=$VID"

say "2) 查看当前布局（revision=0，全部未配位）"
curl -sS "$API/voyages/$VID/layout" | head -c 600; echo

say "3) 违规尝试：BOX-1(1类) 与 BOX-2(3类) 距离仅 1 -> 整批拒绝 422"
curl -sS -X POST "$API/voyages/$VID/moves" -H 'content-type: application/json' -d '{
  "baseRevision": 0,
  "moves": [
    { "boxNo": "BOX-1", "position": { "bay": 1, "row": 1, "tier": 0 } },
    { "boxNo": "BOX-2", "position": { "bay": 2, "row": 1, "tier": 0 } }
  ]
}'; echo

say "4) 未知箱 / 无效坐标 -> 400"
curl -sS -X POST "$API/voyages/$VID/moves" -H 'content-type: application/json' -d '{
  "baseRevision": 0,
  "moves": [
    { "boxNo": "GHOST", "position": { "bay": 1, "row": 1, "tier": 0 } },
    { "boxNo": "BOX-1", "position": { "bay": 99, "row": 1, "tier": 0 } }
  ]
}'; echo

say "5) 合法整批：距离达标且自底向上（产生 revision=1）"
#  BOX-2(3类)@(3,2,0)；BOX-1(1类)@(1,1,0) 距离 3；BOX-4(1类)@(1,1,1) 距离 4
curl -sS -X POST "$API/voyages/$VID/moves" -H 'content-type: application/json' -d '{
  "baseRevision": 0,
  "moves": [
    { "boxNo": "BOX-1", "position": { "bay": 1, "row": 1, "tier": 0 } },
    { "boxNo": "BOX-2", "position": { "bay": 3, "row": 2, "tier": 0 } },
    { "boxNo": "BOX-3", "position": { "bay": 2, "row": 2, "tier": 0 } },
    { "boxNo": "BOX-4", "position": { "bay": 1, "row": 1, "tier": 1 } }
  ]
}'; echo

say "6) 同批交换 BOX-1 与 BOX-4（同列上下互换，携带 revision=1）"
curl -sS -X POST "$API/voyages/$VID/moves" -H 'content-type: application/json' -d '{
  "baseRevision": 1,
  "moves": [
    { "boxNo": "BOX-1", "position": { "bay": 1, "row": 1, "tier": 1 } },
    { "boxNo": "BOX-4", "position": { "bay": 1, "row": 1, "tier": 0 } }
  ]
}'; echo

say "7) 过期修订号提交 -> 409 stale_revision"
curl -sS -X POST "$API/voyages/$VID/moves" -H 'content-type: application/json' -d '{
  "baseRevision": 0,
  "moves": [
    { "boxNo": "BOX-3", "position": null }
  ]
}'; echo

say "8) 暂留空：把 BOX-3 撤下（携带当前 revision=2）"
curl -sS -X POST "$API/voyages/$VID/moves" -H 'content-type: application/json' -d '{
  "baseRevision": 2,
  "moves": [
    { "boxNo": "BOX-3", "position": null }
  ]
}'; echo

say "9) 箱未全配位时签发 -> 422 unplaced_boxes"
curl -sS -X POST "$API/voyages/$VID/manifests" -H 'content-type: application/json' -d '{
  "expectedRevision": 3
}'; echo

say "10) BOX-3 复位（revision=3 -> 4）"
curl -sS -X POST "$API/voyages/$VID/moves" -H 'content-type: application/json' -d '{
  "baseRevision": 3,
  "moves": [
    { "boxNo": "BOX-3", "position": { "bay": 2, "row": 2, "tier": 0 } }
  ]
}'; echo

say "11) 签发装载清单（冻结 revision=4）"
curl -sS -X POST "$API/voyages/$VID/manifests" -H 'content-type: application/json' -d '{
  "expectedRevision": 4
}'; echo

say "12) 签发后再调整 -> revision=5"
curl -sS -X POST "$API/voyages/$VID/moves" -H 'content-type: application/json' -d '{
  "baseRevision": 4,
  "moves": [
    { "boxNo": "BOX-3", "position": { "bay": 2, "row": 1, "tier": 0 } }
  ]
}'; echo

say "13) 清单列表：旧清单保留且 current=false"
curl -sS "$API/voyages/$VID/manifests"; echo

say "14) 取冻结的旧清单 rev=4 / 当前布局 rev=5"
curl -sS "$API/voyages/$VID/manifests/4"; echo
curl -sS "$API/voyages/$VID/layout" | head -c 300; echo
