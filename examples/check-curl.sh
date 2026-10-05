#!/usr/bin/env bash
# 现场装船核对 —— curl 调用示例
#
# 前置：已存在“已签发清单”。本脚本自包含：登记航次 -> 配载 -> 签发清单，
#       随后演示核对作业的完整生命周期。
#
# 用法: BASE=http://localhost:3000 bash examples/check-curl.sh
set -euo pipefail

BASE="${BASE:-http://localhost:3000}"
API="$BASE/api"

say() { printf '\n=== %s ===\n' "$1"; }
jq_or_cat() { command -v jq >/dev/null 2>&1 && jq . || cat; }

# 0. 准备一个已签发清单（rev=1）
say "0) 准备：登记航次 + 配载 + 签发清单"
VOYAGE_JSON=$(curl -sS -X POST "$API/voyages" -H 'content-type: application/json' -d '{
  "voyageNo": "V-CHECK-'"$(date +%s)"'",
  "bays": 3, "rows": 2, "tiers": 3,
  "defaultColumnWeightLimit": "10000",
  "boxes": [
    { "boxNo": "BOX-1", "weight": "500", "category": "1" },
    { "boxNo": "BOX-2", "weight": "600", "category": "3" },
    { "boxNo": "BOX-3", "weight": "400", "category": "5" },
    { "boxNo": "BOX-4", "weight": "300",   "category": "1" }
  ],
  "incompatRules": [ { "categoryA": "1", "categoryB": "3", "minDistance": 3 } ]
}')
VID=$(echo "$VOYAGE_JSON" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
echo "voyageId=$VID"

curl -sS -X POST "$API/voyages/$VID/moves" -H 'content-type: application/json' -d '{
  "baseRevision": 0,
  "moves": [
    { "boxNo": "BOX-1", "position": { "bay": 1, "row": 1, "tier": 0 } },
    { "boxNo": "BOX-2", "position": { "bay": 3, "row": 2, "tier": 0 } },
    { "boxNo": "BOX-3", "position": { "bay": 2, "row": 2, "tier": 0 } },
    { "boxNo": "BOX-4", "position": { "bay": 1, "row": 1, "tier": 1 } }
  ]
}' >/dev/null
curl -sS -X POST "$API/voyages/$VID/manifests" -H 'content-type: application/json' \
  -d '{ "expectedRevision": 1 }' >/dev/null
echo "已签发清单 rev=1"

# 1. 清单不存在时拒绝开工（404）
say "1) 以不存在的清单修订号开工 -> 404 manifest_not_found"
curl -sS -X POST "$API/voyages/$VID/check-jobs" -H 'content-type: application/json' \
  -d '{ "manifestRevision": 99 }'; echo

# 2. 以已签发清单 rev=1 开启核对作业（201）
say "2) 开启核对作业（基准冻结在清单 rev=1）"
OPEN_JSON=$(curl -sS -X POST "$API/voyages/$VID/check-jobs" -H 'content-type: application/json' \
  -d '{ "manifestRevision": 1 }')
echo "$OPEN_JSON" | jq_or_cat
JOB=$(echo "$OPEN_JSON" | sed -n 's/.*"jobId":"\([^"]*\)".*/\1/p')
echo "jobId=$JOB"

# 3. 同一清单重复开工 -> 409 check_job_exists（details 带回既有作业）
say "3) 同一清单再开工 -> 409 check_job_exists"
curl -sS -X POST "$API/voyages/$VID/check-jobs" -H 'content-type: application/json' \
  -d '{ "manifestRevision": 1 }'; echo

# 4. 查询初始核对状态：应装 4，缺失 4
say "4) 初始核对状态（4 箱全部缺失）"
curl -sS "$API/check-jobs/$JOB" | jq_or_cat

# 5. 上报实装位置
say "5) 上报 BOX-1 实装位置与清单一致"
curl -sS -X POST "$API/check-jobs/$JOB/reports" -H 'content-type: application/json' -d '{
  "reportNo": "RPT-20261004-0001",
  "boxNo": "BOX-1",
  "position": { "bay": 1, "row": 1, "tier": 0 }
}'; echo

# 6. 相同上报号+相同内容重试 -> 200 replay，返回原结果（seq 不变）
say "6) 相同上报号与内容重试 -> 200 replay 原结果"
curl -sS -X POST "$API/check-jobs/$JOB/reports" -H 'content-type: application/json' -d '{
  "reportNo": "RPT-20261004-0001",
  "boxNo": "BOX-1",
  "position": { "bay": 1, "row": 1, "tier": 0 }
}'; echo

# 7. 相同上报号+不同内容 -> 409 report_no_conflict
say "7) 上报号复用为不同内容 -> 409 report_no_conflict"
curl -sS -X POST "$API/check-jobs/$JOB/reports" -H 'content-type: application/json' -d '{
  "reportNo": "RPT-20261004-0001",
  "boxNo": "BOX-2",
  "position": { "bay": 3, "row": 2, "tier": 0 }
}'; echo

# 8. 坐标越界 -> 400 invalid_coordinates（不留痕）
say "8) 坐标越界 -> 400 invalid_coordinates"
curl -sS -X POST "$API/check-jobs/$JOB/reports" -H 'content-type: application/json' -d '{
  "reportNo": "RPT-20261004-0002",
  "boxNo": "BOX-2",
  "position": { "bay": 99, "row": 2, "tier": 0 }
}'; echo

# 继续上报：BOX-2 正确；BOX-3 先报错位
say "9) BOX-2 正确；BOX-3 错位实装到 (2,1,0)"
curl -sS -X POST "$API/check-jobs/$JOB/reports" -H 'content-type: application/json' -d '{
  "reportNo": "RPT-20261004-0003",
  "boxNo": "BOX-2",
  "position": { "bay": 3, "row": 2, "tier": 0 }
}' >/dev/null
curl -sS -X POST "$API/check-jobs/$JOB/reports" -H 'content-type: application/json' -d '{
  "reportNo": "RPT-20261004-0004",
  "boxNo": "BOX-3",
  "position": { "bay": 2, "row": 1, "tier": 0 }
}' >/dev/null
curl -sS "$API/check-jobs/$JOB" | jq_or_cat

# 10. 清单外箱
say "10) 上报清单外箱 GHOST -> 计入 extra"
curl -sS -X POST "$API/check-jobs/$JOB/reports" -H 'content-type: application/json' -d '{
  "reportNo": "RPT-20261004-0005",
  "boxNo": "GHOST",
  "position": { "bay": 3, "row": 1, "tier": 0 }
}' >/dev/null
curl -sS "$API/check-jobs/$JOB" | jq_or_cat

# 11. 有差异时结案 -> 409 check_not_closeable，作业继续开放
say "11) 有差异尝试结案 -> 409 check_not_closeable（作业继续开放）"
curl -sS -X POST "$API/check-jobs/$JOB/close"; echo

# 12. 撤销：GHOST 撤销（清单外差异消除）；BOX-3 撤销后按清单位置补报
say "12) 撤销 GHOST；BOX-3 撤销（变缺失）后补报正确位置"
curl -sS -X POST "$API/check-jobs/$JOB/reports" -H 'content-type: application/json' -d '{
  "reportNo": "RPT-20261004-0006",
  "boxNo": "GHOST",
  "position": null
}' >/dev/null
curl -sS -X POST "$API/check-jobs/$JOB/reports" -H 'content-type: application/json' -d '{
  "reportNo": "RPT-20261004-0007",
  "boxNo": "BOX-3",
  "position": null
}' >/dev/null
curl -sS -X POST "$API/check-jobs/$JOB/reports" -H 'content-type: application/json' -d '{
  "reportNo": "RPT-20261004-0008",
  "boxNo": "BOX-3",
  "position": { "bay": 2, "row": 2, "tier": 0 }
}' >/dev/null
# BOX-4 按清单位置上报
curl -sS -X POST "$API/check-jobs/$JOB/reports" -H 'content-type: application/json' -d '{
  "reportNo": "RPT-20261004-0009",
  "boxNo": "BOX-4",
  "position": { "bay": 1, "row": 1, "tier": 1 }
}' >/dev/null
curl -sS "$API/check-jobs/$JOB" | jq_or_cat

# 13. 上报留痕（每次受理均有记录，以箱号最后一条为准）
say "13) 上报留痕（按受理顺序，含撤销）"
curl -sS "$API/check-jobs/$JOB/reports" | jq_or_cat

# 14. 无差异结案 -> 201 冻结
say "14) 结案并冻结结果"
curl -sS -X POST "$API/check-jobs/$JOB/close" | jq_or_cat

# 15. 结案后新上报被拒；已受理上报号仍可重试
say "15) 结案后新上报 -> 409 check_job_closed"
curl -sS -X POST "$API/check-jobs/$JOB/reports" -H 'content-type: application/json' -d '{
  "reportNo": "RPT-NEW",
  "boxNo": "BOX-1",
  "position": { "bay": 1, "row": 1, "tier": 0 }
}'; echo

say "16) 结案后已受理上报号原样重试 -> 200 replay"
curl -sS -X POST "$API/check-jobs/$JOB/reports" -H 'content-type: application/json' -d '{
  "reportNo": "RPT-20261004-0001",
  "boxNo": "BOX-1",
  "position": { "bay": 1, "row": 1, "tier": 0 }
}'; echo

say "完成：voyageId=$VID jobId=$JOB"
