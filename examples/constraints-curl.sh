#!/usr/bin/env bash
# 船舶危险货箱配载审定服务 —— 安全约束变更 curl 调用示例
#
# 用法: BASE=http://localhost:3000 bash examples/constraints-curl.sh
#
# 演示：登记 -> 配位 -> 约束变更复验失败(422) -> 过期修订号(409) ->
#       合法约束变更(修订号+1、布局继承) -> 历史布局展示旧约束 ->
#       旧清单/在办核对不受影响 -> 后续调整按新约束。
set -euo pipefail

BASE="${BASE:-http://localhost:3000}"
API="$BASE/api"

say() { printf '\n=== %s ===\n' "$1"; }

say "健康检查"
curl -sS "$BASE/health"; echo

say "1) 登记航次 V-CSTR-$(date +%S)"
#  3 bay x 3 row x 2 tier；默认列承重 10000kg；(1,1) 覆盖 1200kg；类别1 与 3 最小距离 3
VOYAGE_JSON=$(curl -sS -X POST "$API/voyages" -H 'content-type: application/json' -d '{
  "voyageNo": "V-CSTR-'$(date +%s)'",
  "bays": 3, "rows": 3, "tiers": 2,
  "defaultColumnWeightLimit": "10000",
  "columnWeightLimits": [
    { "bay": 1, "row": 1, "weightLimit": "1200" }
  ],
  "boxes": [
    { "boxNo": "B1", "weight": "500", "category": "1" },
    { "boxNo": "B2", "weight": "600", "category": "3" },
    { "boxNo": "B3", "weight": "400", "category": "5" },
    { "boxNo": "B4", "weight": "300", "category": "1" }
  ],
  "incompatRules": [
    { "categoryA": "1", "categoryB": "3", "minDistance": 3 }
  ]
}')
echo "$VOYAGE_JSON"
VID=$(echo "$VOYAGE_JSON" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
echo "voyageId=$VID"

say "2) 合法配位（产生 revision=1）"
#  B1(1)@(1,1,0)、B4(1)@(1,1,1) 列重 800<=1200；B2(3)@(3,3,0) 距 B1 为 4>=3；B3(5)@(2,2,0)
curl -sS -X POST "$API/voyages/$VID/moves" -H 'content-type: application/json' -d '{
  "baseRevision": 0,
  "moves": [
    { "boxNo": "B1", "position": { "bay": 1, "row": 1, "tier": 0 } },
    { "boxNo": "B4", "position": { "bay": 1, "row": 1, "tier": 1 } },
    { "boxNo": "B2", "position": { "bay": 3, "row": 3, "tier": 0 } },
    { "boxNo": "B3", "position": { "bay": 2, "row": 2, "tier": 0 } }
  ]
}'; echo

say "3) 约束变更复验失败 -> 422（规则与修订号不变）"
#  把 (1,1) 列覆盖承重收紧到 700kg：当前该列 500+300=800kg 超限
curl -sS -X POST "$API/voyages/$VID/constraints" -H 'content-type: application/json' -d '{
  "baseRevision": 1,
  "defaultColumnWeightLimit": "10000",
  "columnWeightLimits": [
    { "bay": 1, "row": 1, "weightLimit": "700" }
  ],
  "incompatRules": [
    { "categoryA": "1", "categoryB": "3", "minDistance": 3 }
  ]
}'; echo

say "4) 过期修订号提交约束变更 -> 409 stale_revision（返回当前修订号）"
curl -sS -X POST "$API/voyages/$VID/constraints" -H 'content-type: application/json' -d '{
  "baseRevision": 0,
  "defaultColumnWeightLimit": "10000",
  "columnWeightLimits": [],
  "incompatRules": []
}'; echo

say "5) 请求级校验：非正重量 / 越界列坐标 / 重复类别对 -> 400"
curl -sS -X POST "$API/voyages/$VID/constraints" -H 'content-type: application/json' -d '{
  "baseRevision": 1,
  "defaultColumnWeightLimit": "-5",
  "columnWeightLimits": [],
  "incompatRules": []
}'; echo
curl -sS -X POST "$API/voyages/$VID/constraints" -H 'content-type: application/json' -d '{
  "baseRevision": 1,
  "defaultColumnWeightLimit": "10000",
  "columnWeightLimits": [{ "bay": 9, "row": 1, "weightLimit": "100" }],
  "incompatRules": []
}'; echo

say "6) 合法约束变更（revision 1 -> 2）：整套替换、布局原样继承"
#  默认 9000；覆盖项只列 (2,2)=9999（旧的 (1,1) 覆盖即撤销）；
#  类别对只列 1-5 距离 2（旧的 1-3 类别对即撤销）。当前布局复验通过。
curl -sS -X POST "$API/voyages/$VID/constraints" -H 'content-type: application/json' -d '{
  "baseRevision": 1,
  "defaultColumnWeightLimit": "9000",
  "columnWeightLimits": [
    { "bay": 2, "row": 2, "weightLimit": "9999" }
  ],
  "incompatRules": [
    { "categoryA": "1", "categoryB": "5", "minDistance": 2 }
  ]
}'; echo

say "7) 历史布局 rev=1 仍展示当时生效的旧约束（默认10000 / 覆盖(1,1)=1200 / 规则1-3）"
curl -sS "$API/voyages/$VID/layout?rev=1"; echo

say "8) 当前布局 rev=2 展示新约束（默认9000 / 覆盖(2,2) / 规则1-5）"
curl -sS "$API/voyages/$VID/layout"; echo

say "9) 后续整批调整使用新约束：1-3 规则已撤销，B2(3类) 可贴近 B1(1类)"
#  旧约束下 B1@(1,1) 与 B2@(1,2) 距离 1 会违规；新约束无 1-3 类别对，故合法（revision 2 -> 3）
curl -sS -X POST "$API/voyages/$VID/moves" -H 'content-type: application/json' -d '{
  "baseRevision": 2,
  "moves": [
    { "boxNo": "B2", "position": { "bay": 1, "row": 2, "tier": 0 } }
  ]
}'; echo

say "10) 签发冻结 revision=3 的清单"
curl -sS -X POST "$API/voyages/$VID/manifests" -H 'content-type: application/json' -d '{
  "expectedRevision": 3
}'; echo

say "11) 签发后再变更约束（revision 3 -> 4，布局继承）"
curl -sS -X POST "$API/voyages/$VID/constraints" -H 'content-type: application/json' -d '{
  "baseRevision": 3,
  "defaultColumnWeightLimit": "9500",
  "columnWeightLimits": [],
  "incompatRules": []
}'; echo

say "12) 旧清单 rev=3 仍冻结（current=false），与新约束无关"
curl -sS "$API/voyages/$VID/manifests/3"; echo

say "13) 在办核对以冻结清单 rev=3 为基准（约束变更不影响）"
JOB_JSON=$(curl -sS -X POST "$API/voyages/$VID/check-jobs" -H 'content-type: application/json' -d '{
  "manifestRevision": 3
}')
echo "$JOB_JSON"
JOB_ID=$(echo "$JOB_JSON" | sed -n 's/.*"job":{"jobId":"\([^"]*\)".*/\1/p')
echo "jobId=$JOB_ID"
# 按冻结清单坐标逐箱上报
curl -sS -X POST "$API/check-jobs/$JOB_ID/reports" -H 'content-type: application/json' -d '{ "reportNo":"R1","boxNo":"B1","position":{"bay":1,"row":1,"tier":0} }' >/dev/null
curl -sS -X POST "$API/check-jobs/$JOB_ID/reports" -H 'content-type: application/json' -d '{ "reportNo":"R2","boxNo":"B4","position":{"bay":1,"row":1,"tier":1} }' >/dev/null
curl -sS -X POST "$API/check-jobs/$JOB_ID/reports" -H 'content-type: application/json' -d '{ "reportNo":"R3","boxNo":"B2","position":{"bay":1,"row":2,"tier":0} }' >/dev/null
curl -sS -X POST "$API/check-jobs/$JOB_ID/reports" -H 'content-type: application/json' -d '{ "reportNo":"R4","boxNo":"B3","position":{"bay":2,"row":2,"tier":0} }' >/dev/null
curl -sS -X POST "$API/check-jobs/$JOB_ID/close"; echo
