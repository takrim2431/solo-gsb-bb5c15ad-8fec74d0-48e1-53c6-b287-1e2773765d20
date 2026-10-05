# 船舶危险货箱配载审定服务

TypeScript / Node.js + PostgreSQL 实现的危险货箱三维舱位配载审定（stowage plan approval）HTTP 服务。

调度员按**修订号（乐观并发）**整批调整箱位，服务仅按**最终布局**一次性校验全部规则，任一违反即**整批拒绝**并指出相关箱号、舱位与原因；签发装载清单时内容冻结到当时修订号，旧清单永久保留。

**航次安全约束（默认列承重、按列覆盖限额、不相容类别对）同样按修订号演进**：调度员携带所见修订号即可整批替换整套约束；受理前按新约束复验当前完整布局，违反即拒绝、修订号不变，受理后修订号 +1、布局原样继承。约束随每个修订号留痕，**历史布局查询总展示当时生效的约束**；舱位尺寸与箱档案登记后不可变更。

清单签发后，现场以该冻结清单为基准开启**装船核对作业（check job）**：逐箱上报实装位置或撤销（未装），以每箱最后一条上报确定当前状态，服务实时给出应装/已核对/缺失/错位/清单外箱明细；全部与冻结清单一致且无清单外箱方可结案冻结，之后拒绝新上报。核对基准一经开工即固定，后续布局调整、**约束变更**或新签发清单均不影响在办作业。

调度员还可从航次当前修订号建立多个相互独立的**试排方案（stowage plan）**：每个方案以创建时布局为初值、固定当时安全约束快照，记录来源修订号与独立的方案修订号；方案内整批调整沿用正式航次同一套箱号/坐标/最终布局校验规则，按方案修订号防止并发覆盖，失败不改变方案，且**正式航次、清单与核对作业不受试排影响**。仅当航次当前修订号仍等于方案来源修订号时方可**发布**：方案布局原子写入航次新修订号并继承方案约束；否则报告冲突且保留方案。发布成功后方案只读，重复发布幂等返回首次发布结果。

航次修订号前进导致无法发布时，调度员可提交**方案 ID、所见方案修订号与所见航次修订号**把未发布方案**迁移（rebase）到当前航次**：以方案来源修订号的正式布局为**共同基线逐箱三方合并**——仅一方改动（含撤位）采用该方位置，双方改动到同一位置（含双方撤位）视为一致，目标不同则返回冲突箱号及双方位置、方案保持原状；撤位按空位置参与比较。合并后的完整布局用**当前航次约束**复验，违反返回现有规则明细且不迁移。成功后原子更新方案来源修订号与约束快照、保存合并布局、推进方案修订号，旧方案布局仍在方案历史中可追溯；**再次迁移以新的来源修订号为基线**。迁移不改变正式布局、清单与核对作业，迁移后发布仍遵守现有发布冲突与重复发布幂等规则。

清单签发后，调度员还可对任一**已签发冻结清单**发起**港序卸货审查（discharge review）**：提交有序且不重复的卸港列表与清单内每个箱的卸港（箱号必须与清单完全一致、卸港必须出现在列表中），服务**按清单冻结箱位**逐港模拟不倒箱卸货——每港反复卸走列顶（上方已空）且属于本港的箱直到再无可卸箱，被后续港箱压住的本港箱留船，**后续港不回补此前漏卸箱**；返回各港实际卸箱、受阻箱及其同列上方仍在船的全部阻挡箱号与箱位（区分后续港 `later`／同港 `same`／此前漏港 `earlier`）、最终逾港未卸箱与 `feasibleWithoutRestow` 结论。审查结论随提交内容永久留档，**航次后续调整或签发新清单均不改变旧审查结果**；同一清单同一提交内容天然幂等，不同港序/卸港申报可各自独立审查。

卸货审查留档后，港口调度员可据其**预订靠泊窗口（berth booking）**：提交审查 ID、审查内某一卸港、泊位、带时区的起止时刻与提交号。**仅当该港在审查模拟中确有实际卸箱且无受阻箱时受理**；受理即冻结**清单修订号**与**该港实际卸箱数**，审查/清单后续调整或签发新清单**不回写**预订。起点必须严格早于终点；**同港同泊位的有效窗口即使来自不同航次也不得重叠（半开区间，首尾相接可用），并发竞争只有一方成功**；同一审查同一卸港至多一个有效预订。提交号在同一审查内唯一：同号同内容重试返回原预订**当前状态**（幂等），同号改内容报冲突；按预订 ID 取消后记录保留、占用立即释放（重复取消返回已取消状态），重新预订须用新提交号。

已生效的预订还可**改期（adjust）**：提交原预订 ID、新泊位、带时区的起止时刻与调整号。**仅在原预订仍有效时受理**；受理时**释放旧窗口与占用新窗口在同一事务内原子完成**——旧记录保留为已取消并以 `replacedByBookingId` 关联新记录，新记录继承原审查、卸港及冻结的清单修订号与实际卸箱数。无效时刻、已取消原预订、调整号冲突或新窗口被占用时**不改变原预订**；新窗口沿用同审查同港唯一、同港同泊位跨航次不重叠与半开区间首尾相接可用的规则。调整号在同一原预订内唯一：同号同内容重试返回**新记录当前状态**（幂等），同号改内容报冲突；起止时刻按绝对时刻比较。

---

## 1. 模型与规则

### 坐标系（三维舱位）

| 维度 | 字段 | 取值 |
| --- | --- | --- |
| 舱/贝 | `bay` | `1..bays` |
| 列 | `row` | `1..rows` |
| 层（自底向上） | `tier` | `0..tiers-1`，底层为 `tier=0` |

“列”指同一 `(bay, row)` 下垂直堆叠的一列箱。两箱位距离为三维曼哈顿距离：

```
d = |Δbay| + |Δrow| + |Δtier|
```

### 登记数据

- 航次三维舱位尺寸 `bays / rows / tiers`；
- 各列承重上限：默认上限 + 按 `(bay,row)` 覆盖的单列上限（重量单位 kg，支持最多 6 位小数，内部以整数存储，无浮点误差）；
- 箱号、重量（正数）、危险品类别；
- 不相容类别对的**正整数**最小曼哈顿距离；**未设定的类别对视为相容**。

### 整批调整语义

- 每次提交携带调度员所见的 `baseRevision`；
- 一批中可包含任意多条 `{boxNo, position}`，`position=null` 表示该箱**暂留空（撤位）**；
- **允许同批交换**：以最终布局为准（先撤后放只是计算方式，不存在“中间态冲突”）；
- 未出现在批次中的箱保持原位；
- 箱位可以留空（未配位），仅在**签发清单**时要求所有箱已配位。

### 最终布局校验规则（任一违反则整批拒绝）

1. **一箱至多一位**（同一箱在最终布局中不得出现两次）；
2. **一位至多一箱**（同一三维坐标不得放两个箱）；
3. **各列自底向上连续占用**：同列占用层必须恰好为 `tier 0..k-1`，不得悬空；
4. **列总重量不超上限**：按默认/单列上限逐列核算；
5. **不相容类别对距离**：两箱曼哈顿距离必须 ≥ 设定的最小距离。

### 请求级错误（HTTP 400 / 409）

- 未知箱号 → `unknown_box`；
- 坐标越界、重量非法 → `invalid_coordinates` / 请求体校验错误；
- 同一批中同一箱号出现多次 → `duplicate_box_in_batch`；
- `baseRevision` 与当前修订号不一致 → **409 `stale_revision`**（响应中给出当前修订号）。

### 修订号与清单

- 初始修订号为 `0`（空布局）；每接受一批合法调整，修订号 +1，历史布局全量留痕可查；
- 事务内对航次行 `SELECT ... FOR UPDATE`，并发提交只有一个能成功，其余得到 409；
- 签发要求**所有箱已配位**（否则 422 `unplaced_boxes`），且 `expectedRevision` 必须等于当前修订号；
- 清单内容**复制冻结**到独立的 `manifest_items`，之后调整布局不影响旧清单；
- 旧清单继续可查，列表中以 `current` 标识其是否指向当前修订号——因此**永远不存在指向过期布局的“当前清单”**；
- 对同一修订号重复签发幂等（返回已冻结的清单）。

### 安全约束变更语义（`POST /constraints`）

- 提交体携带调度员所见 `baseRevision`，并给出**整套**：`defaultColumnWeightLimit`、`columnWeightLimits`（按列覆盖）、`incompatRules`（不相容类别对）；
- **全量替换**：未在本次列出的按列覆盖项、不相容类别对即视为撤销（想保留就得连同再传一次）；
- **舱位尺寸（`bays/rows/tiers`）与箱档案（箱号/重量/类别）登记后不变**，本接口不接收这些字段；
- 沿用登记时的校验：承重必须为**正数**（最多 6 位小数）、按列覆盖的列坐标必须在舱位范围内、不相容类别对**归一化后唯一**（`(a,b)` 与 `(b,a)` 视为同一对），任一不满足 → 400；
- 受理前按**新约束**对**当前完整布局**复验五项配载规则：任一违反 → 422 `validation_failed`（返回箱号、位置、原因），**规则与修订号均不变**；
- `baseRevision` 与当前修订号不一致 → **409 `stale_revision`**（响应给出当前修订号），与整批调整一致；
- 受理后修订号 +1：**当前布局原样继承**到新修订号（箱位不变），新约束自新修订号生效；
- **约束按修订号留痕**：`GET /layout?rev=N` 总返回修订号 N 当时生效的整套约束（默认承重/按列覆盖/类别对），当前布局返回新约束；
- **旧清单与在办核对**以各自冻结清单为基准，约束变更不影响其内容与判定；**后续的整批调整与签发**按新约束复验；
- 事务内对航次行 `SELECT ... FOR UPDATE`，与整批调整共用同一修订号序列，并发提交只有一个成功，其余得到 409。

> 布局调整（`/moves`）与约束变更（`/constraints`）都会使修订号 +1 并各自把“不变的另一半”快照复制到新修订号：`/moves` 沿用当前约束、生成新布局；`/constraints` 沿用当前布局、写入新约束。

### 试排方案语义（`POST /voyages/:id/plans` 等）

- **建立**：`POST /api/voyages/:id/plans` 以航次**当前修订号**为来源建立独立方案——复制当前布局为方案初值（方案修订号 `planRevision=0`），并把当时生效的整套约束**固定**为方案快照（方案存续期间不变）；同一航次可建立多个相互独立的方案，`label` 可空仅作备注；
- **方案内整批调整**：`POST /api/plans/:planId/moves` 与正式航次 `/moves` 同构——携带所见**方案修订号** `baseRevision`，沿用同一套箱号/坐标/最终布局五项校验规则（请求级错误 400、规则违反 422、过期 409 `stale_revision` 返回方案当前修订号）；**失败不改变方案**；受理后方案修订号 +1，正式航次修订号与布局不受任何影响；
- **查询**：`GET /api/plans/:planId` 返回当前试排布局、固定约束与版本（`sourceRevision`/`planRevision`/`status`）；未知方案 404 `plan_not_found`；`GET /api/voyages/:id/plans` 列出航次下全部方案；
- **发布**：`POST /api/plans/:planId/publish` 仅当**航次当前修订号仍等于方案来源修订号**才受理——同一事务内把方案布局写入航次新修订号（rev+1）、新修订号继承方案约束快照、方案置 `published` 只读；航次修订号已偏离 → 409 `publish_conflict`，**方案原样保留**（仍为 `open`，可继续调整或基于最新修订号另建方案）；
- **发布后**：方案只读（继续调整 → 409 `plan_published`）；重复发布幂等返回**首次发布结果**（200 `replay:true`，不产生新修订号）；
- **迁移（航次前进后的 rebase）**：`POST /api/plans/:planId/migrate` 提交所见方案修订号与航次修订号，以**来源修订号正式布局为共同基线逐箱三方合并**（仅一方改动取该方、双方改到同位置一致、目标不同返回冲突箱及双方位置、撤位按空位置比较），合并布局按**当前航次约束**复验；冲突或复验失败均不改变方案，成功则原子换来源修订号+约束快照、保存合并布局、方案修订号 +1（旧方案布局留痕可追溯），再次迁移以新来源修订号为基线；所见版本过期或方案已发布拒绝；**迁移不改变正式布局、清单与核对作业**，迁移后发布仍遵守现有冲突与重复发布规则；
- **隔离与冻结**：试排不触碰正式航次、清单与核对作业；历史布局、旧清单与在办核对仍遵循原有冻结语义，发布产生的新修订号与正式调整产生的修订号完全同构（历史可查、可签发、可开工核对）。

---

## 2. 一键启动（Docker Compose）

前置：Docker 20.10+（支持 Compose v2）。

```bash
# 在项目根目录
docker compose up --build -d
```

启动后：

- API 服务：`http://localhost:3000`
- 健康检查：`http://localhost:3000/health`
- PostgreSQL：`localhost:5432`（库/用户/密码默认均为 `stowage`，数据持久化在命名卷 `stowage-pgdata`）

应用容器会等待数据库健康、自动执行幂等的 `src/schema.sql` 建表，无需手动初始化。

停止与清理：

```bash
docker compose down          # 停止，保留数据
docker compose down -v       # 停止并删除数据库卷
```

### 配置（环境变量 / `.env`）

复制 `.env.example` 为 `.env` 后由 Compose 自动读取：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `API_PORT` | `3000` | API 对宿主端口 |
| `DB_PORT` | `5432` | PostgreSQL 对宿主端口 |
| `POSTGRES_USER` | `stowage` | 数据库用户 |
| `POSTGRES_PASSWORD` | `stowage` | 数据库密码 |
| `POSTGRES_DB` | `stowage` | 数据库名 |
| `PORT`（容器内） | `3000` | 服务监听端口 |
| `DATABASE_URL` | 指向 `db:5432` | 应用连接串 |
| `DB_STARTUP_TIMEOUT_SEC` | `60` | 等待数据库就绪最长秒数 |
| `SCHEMA_PATH` | `/app/src/schema.sql` | 建表脚本路径 |

---

## 3. 本地开发（不用 Docker）

```bash
npm install
npm run build      # tsc 编译到 dist/
# 需自行准备 PostgreSQL 14+，并设置连接串，例如：
export DATABASE_URL='postgres://stowage:stowage@localhost:5432/stowage'
npm start          # 启动（自动等待 DB + 建表）

npm run dev        # 或 tsx watch 热重载
npm test           # 纯函数单元测试（配载规则 + 装船核对）

# 端到端测试（需 devDependency embedded-postgres，首次运行会自动下载本地 PG）
npm run build && node test/e2e.js             # 配载/签发/并发
npm run build && node test/e2e-check.js       # 核对作业/上报/结案/并发
npm run build && node test/e2e-constraints.js # 安全约束变更/历史留痕/冻结基准/并发
npm run build && node test/e2e-plans.js       # 试排方案/发布冲突/只读幂等/并发
npm run build && node test/e2e-migrate.js    # 方案迁移/三方合并/冲突/复验失败/过期/并发
npm run build && node test/e2e-discharge.js  # 港序卸货审查/逐港模拟/阻挡链/逾港/冻结不变/拒绝/幂等
npm run build && node test/e2e-berth.js     # 靠泊预订/窗口互斥/跨航次/并发一方成功/幂等/取消释放/冻结不回写
npm run build && node test/e2e-adjust.js    # 靠泊改期/原子换窗/继承冻结快照/调整号幂等冲突/失败不改原预订/链式/并发
```

---

## 4. HTTP API

基址 `/api`，请求/响应均为 JSON。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/voyages` | 登记航次（舱位、列承重、箱、不相容规则） |
| `GET` | `/api/voyages` | 航次列表 |
| `GET` | `/api/voyages/:id` | 航次元数据（含当前修订号） |
| `GET` | `/api/voyages/:id/layout?rev=N` | 查看布局与该修订号**当时生效的约束**（缺省当前修订号；可查历史） |
| `POST` | `/api/voyages/:id/moves` | **整批调整**（携带 `baseRevision`） |
| `POST` | `/api/voyages/:id/constraints` | **安全约束变更**（整套默认承重/按列覆盖/类别对，携带 `baseRevision`） |
| `POST` | `/api/voyages/:id/manifests` | **签发装载清单**（携带 `expectedRevision`） |
| `GET` | `/api/voyages/:id/manifests` | 清单列表（旧清单保留，带 `current` 标记） |
| `GET` | `/api/voyages/:id/manifests/:rev` | 取某修订号的冻结清单 |
| `POST` | `/api/voyages/:id/check-jobs` | **开启核对作业**（基准为已签发清单修订号） |
| `GET` | `/api/voyages/:id/check-jobs` | 航次下核对作业列表 |
| `GET` | `/api/check-jobs/:jobId` | 核对状态（应装/已核对/缺失/错位/清单外箱） |
| `POST` | `/api/check-jobs/:jobId/reports` | **核对上报**（实装位置/撤销 + 唯一上报号） |
| `GET` | `/api/check-jobs/:jobId/reports` | 上报留痕 |
| `POST` | `/api/check-jobs/:jobId/close` | **结案冻结**（有差异返回 409，作业继续开放） |
| `POST` | `/api/voyages/:id/plans` | **建立试排方案**（以当前布局为初值、固定当前约束快照） |
| `GET` | `/api/voyages/:id/plans` | 航次下试排方案列表 |
| `GET` | `/api/plans/:planId` | 查询方案（当前试排布局 + 固定约束 + 版本） |
| `POST` | `/api/plans/:planId/moves` | **方案内整批调整**（携带方案修订号） |
| `POST` | `/api/plans/:planId/publish` | **发布方案**（原子写入航次新修订号；冲突 409 保留方案） |
| `POST` | `/api/plans/:planId/migrate` | **方案迁移到当前航次**（三方合并；携带所见方案/航次修订号） |
| `POST` | `/api/voyages/:id/manifests/:rev/discharge-reviews` | **港序卸货审查**（对已签发冻结清单提交港序与每箱卸港，逐港模拟） |
| `GET` | `/api/voyages/:id/discharge-reviews` | 卸货审查列表（`?manifestRevision=N` 按清单过滤） |
| `GET` | `/api/discharge-reviews/:reviewId` | 取某次卸货审查的冻结结果 |
| `POST` | `/api/discharge-reviews/:reviewId/berth-bookings` | **预订靠泊窗口**（审查内卸港+泊位+带时区窗口+提交号） |
| `GET` | `/api/discharge-reviews/:reviewId/berth-bookings` | 按审查查询预订与状态 |
| `GET` | `/api/voyages/:id/berth-bookings` | 按航次查询预订与状态 |
| `GET` | `/api/berth-bookings/:bookingId` | 取单条靠泊预订 |
| `POST` | `/api/berth-bookings/:bookingId/cancel` | **取消预订**（保留记录、释放占用；重复取消幂等） |
| `POST` | `/api/berth-bookings/:bookingId/adjust` | **改期预订**（新泊位+带时区窗口+调整号；原子换窗，旧记录关联新记录） |
| `GET` | `/health` | 健康检查（含数据库连通性） |

### 4.1 登记航次

```bash
curl -sS -X POST http://localhost:3000/api/voyages \
  -H 'content-type: application/json' -d '{
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
}'
```

响应（修订号初始为 0）：

```json
{ "id": "…uuid…", "voyageNo": "V-2026-001", "bays": 3, "rows": 2, "tiers": 3,
  "defaultColumnWeightLimit": "10000", "revision": 0, "createdAt": "…" }
```

### 4.2 整批调整（合法）

```bash
curl -sS -X POST http://localhost:3000/api/voyages/<id>/moves \
  -H 'content-type: application/json' -d '{
  "baseRevision": 0,
  "moves": [
    { "boxNo": "BOX-1", "position": { "bay": 1, "row": 1, "tier": 0 } },
    { "boxNo": "BOX-2", "position": { "bay": 3, "row": 2, "tier": 0 } },
    { "boxNo": "BOX-3", "position": { "bay": 2, "row": 2, "tier": 0 } },
    { "boxNo": "BOX-4", "position": { "bay": 1, "row": 1, "tier": 1 } }
  ]
}'
```

`position: null` 表示把该箱撤下留空。成功返回新修订号与完整新布局。

### 4.3 规则违反：整批拒绝（422，含箱号/舱位/原因）

```json
{
  "error": {
    "code": "validation_failed",
    "message": "配载校验未通过，共 1 项违反，整批调整已拒绝",
    "details": {
      "violationCount": 1,
      "violations": [
        {
          "reason": "incompatible_too_close",
          "message": "不相容类别箱 BOX-1(1类) 与 BOX-2(3类) 曼哈顿距离为 1，要求至少 3",
          "boxA": "BOX-1", "boxB": "BOX-2",
          "categoryA": "1", "categoryB": "3",
          "positionA": { "bay": 1, "row": 1, "tier": 0 },
          "positionB": { "bay": 2, "row": 1, "tier": 0 },
          "distance": 1, "minDistance": 3
        }
      ]
    }
  }
}
```

违反原因码：

| `reason` | 含义 | 关键定位字段 |
| --- | --- | --- |
| `box_duplicated` | 一箱多位 | `boxNo`, `positions[]` |
| `position_collision` | 一位多箱 | `position`, `boxNos[]` |
| `column_not_continuous` | 列未自底向上连续/悬空 | `bay`,`row`,`occupiedTiers`,`missingTiers`,`boxNos[]` |
| `column_overweight` | 列总重超限 | `bay`,`row`,`totalWeight`,`weightLimit`,`boxNos[]` |
| `incompatible_too_close` | 不相容箱距离不足 | `boxA`,`boxB`,`positionA`,`positionB`,`distance`,`minDistance` |

### 4.4 过期修订号（409）

```json
{
  "error": {
    "code": "stale_revision",
    "message": "修订号已过期：携带的 0 与当前修订号 2 不一致，请重新读取最新布局后再提交",
    "details": { "expectedRevision": 0, "currentRevision": 2 }
  }
}
```

### 4.5 安全约束变更（整套替换 + 受理前复验）

```bash
curl -sS -X POST http://localhost:3000/api/voyages/<id>/constraints \
  -H 'content-type: application/json' -d '{
  "baseRevision": 1,
  "defaultColumnWeightLimit": "9000",
  "columnWeightLimits": [
    { "bay": 2, "row": 2, "weightLimit": "9999" }
  ],
  "incompatRules": [
    { "categoryA": "1", "categoryB": "5", "minDistance": 2 }
  ]
}'
```

- 三个约束字段按**整套**提交（与登记请求体一致）；省略的 `columnWeightLimits` / `incompatRules` 按空数组处理（即**撤销全部**覆盖项/类别对）；
- 受理成功返回新修订号、`constraintsChanged:true`、`layoutInherited:true`，以及继承后的完整 `layout`（箱位不变，约束字段已是新值）；
- 当前布局在新约束下违反规则 → 422 `validation_failed`，`violations[]` 与整批调整同构（含箱号、位置、原因），修订号与规则保持不变；
- 修订号过期 → 409 `stale_revision`（`details.currentRevision` 为当前修订号）；
- 非正承重、越界列坐标、重复类别对/列覆盖 → 400 `invalid_request_body` 或 `invalid_column_limit` / `duplicate_incompat_rule` / `duplicate_column_limit`。

随后 `GET /layout?rev=1` 仍返回 rev=1 当时生效的旧约束；`GET /layout`（当前）返回新约束。**未变更的接口字段保持不变**，历史布局响应只是在原有字段位置反映各修订号自己的约束。

### 4.6 签发与冻结

```bash
curl -sS -X POST http://localhost:3000/api/voyages/<id>/manifests \
  -H 'content-type: application/json' -d '{ "expectedRevision": 4 }'
```

返回冻结清单（`current:true`）。之后再调整布局，重新 `GET /manifests` 可见旧清单 `current:false` 仍在；只有再次签发才会产生指向当前布局的新清单。

### 4.7 现场装船核对

核对作业以航次**已签发清单的修订号**为基准开启；同一清单最多一个作业。基准引用冻结副本（`manifest_items`），开工后无论布局怎样调整、**安全约束怎样变更**、签发多少新清单，该作业的核对基准都不变。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/voyages/:id/check-jobs` | 以 `{ "manifestRevision": N }` 开启核对作业 |
| `GET` | `/api/voyages/:id/check-jobs` | 航次下的核对作业列表 |
| `GET` | `/api/check-jobs/:jobId` | 查询核对状态（五类明细） |
| `POST` | `/api/check-jobs/:jobId/reports` | 上报一箱（唯一 `reportNo`） |
| `GET` | `/api/check-jobs/:jobId/reports` | 上报留痕（按受理顺序） |
| `POST` | `/api/check-jobs/:jobId/close` | 结案冻结 |

**开工**

```bash
curl -sS -X POST http://localhost:3000/api/voyages/<id>/check-jobs \
  -H 'content-type: application/json' -d '{ "manifestRevision": 4 }'
```

清单修订号不存在（未签发过）→ 404 `manifest_not_found`，拒绝开工；同一清单重复开工 → 409 `check_job_exists`（`details.existingJob` 带回既有作业）。返回体含作业信息与冻结的 `expected` 应装明细。

**上报**

```bash
# 实装位置（position 非空）
curl -sS -X POST http://localhost:3000/api/check-jobs/<jobId>/reports \
  -H 'content-type: application/json' -d '{
  "reportNo": "RPT-0001",
  "boxNo": "BOX-1",
  "position": { "bay": 1, "row": 1, "tier": 0 }
}'

# 撤销标记（position=null）：表示该箱未装，回到“缺失”
curl -sS -X POST http://localhost:3000/api/check-jobs/<jobId>/reports \
  -H 'content-type: application/json' -d '{
  "reportNo": "RPT-0002", "boxNo": "BOX-2", "position": null
}'
```

上报语义：

- `reportNo` 为**作业内唯一上报号**（客户端生成，如流水号/UUID）；
- 相同 `reportNo` + **相同内容**重试 → `200 { replay: true, ... }`，返回首次受理的原结果（含原 `seq` 与当时状态），不产生新记录；
- 相同 `reportNo` + **不同内容**（箱号/位置/撤销任一不同）→ 409 `report_no_conflict`；
- 坐标越界（超出航次 `bays/rows/tiers`）→ 400 `invalid_coordinates`，该次不留痕；
- 每次成功受理均**留痕**（自增 `seq`），以**箱号最后一条上报**确定当前实装状态：最后一条为撤销即未装；
- 上报箱号无需预先校验：不在冻结清单中的箱号按“清单外箱”跟踪（实装计入差异、撤销则消失）。

**状态查询**返回五类明细与计数：

| 明细 | 含义 |
| --- | --- |
| `details.expected` | 应装：冻结清单全部箱及其计划位置 |
| `details.checked` | 已核对：清单箱当前坐标与清单完全一致 |
| `details.missing` | 缺失：从未上报（`reason:"none"`）或最后一条为撤销（`reason:"revoked"`） |
| `details.misplaced` | 错位：清单箱当前实装坐标 ≠ 清单坐标（含应装/实装两个坐标） |
| `details.extra` | 清单外箱：不在清单中的箱号当前处于实装状态 |

顶层另有 `counts`、`closeable`（缺失/错位/清单外均为 0）、`status`（`open`/`closed`）、`frozen`。

**结案**

```bash
curl -sS -X POST http://localhost:3000/api/check-jobs/<jobId>/close
```

- 仅当所有清单箱当前坐标与冻结清单一致 **且** 无清单外箱时结案成功（201），作业置 `closed`、记录 `closedAt`、结果冻结；
- 否则 409 `check_not_closeable`，响应 `details.status` 带回全部差异，作业继续开放，可继续上报后重试；
- 已结案重复结案幂等（200 `replay:true`）；
- **结案后新上报号一律 409 `check_job_closed`；已受理过的上报号仍可相同内容重试**（返回冻结的原结果）。

**并发**：所有上报与结案在事务内对作业行 `SELECT ... FOR UPDATE`，严格顺序生效；并发上报的 `seq` 连续无重复，上报与结案并发时以获得锁的先后为准（结案先到则新上报被拒，上报先到则按当时状态判定结案）。

### 4.8 试排方案（建立 → 方案内调整 → 发布）

试排方案是正式航次旁的独立工作区：建立时快照当前布局与约束，方案内调整只演进**方案修订号**，正式发布时才触碰航次。

**建立**（从航次当前修订号派生；`label` 可省）：

```bash
curl -sS -X POST http://localhost:3000/api/voyages/<id>/plans \
  -H 'content-type: application/json' -d '{ "label": "方案A-加密堆存" }'
```

响应（201；初值=创建时布局，约束=当时生效快照，`planRevision=0`）：

```json
{ "planId": "…uuid…", "voyageId": "…", "label": "方案A-加密堆存", "status": "open",
  "sourceRevision": 1, "planRevision": 0, "publishedAt": null, "publishedRevision": null,
  "geometry": { "bays": 3, "rows": 3, "tiers": 2 },
  "defaultColumnWeightLimit": "10000",
  "columnWeightLimits": [ { "bay": 1, "row": 1, "weightLimit": "1200" } ],
  "incompatRules": [ { "categoryA": "1", "categoryB": "3", "minDistance": 3 } ],
  "boxes": [ … ], "placements": [ … ], "unplacedBoxNos": [] }
```

**方案内整批调整**（与 `/moves` 同一套请求体与校验；`baseRevision` 为**方案修订号**）：

```bash
curl -sS -X POST http://localhost:3000/api/plans/<planId>/moves \
  -H 'content-type: application/json' -d '{
  "baseRevision": 0,
  "moves": [
    { "boxNo": "B3", "position": { "bay": 2, "row": 1, "tier": 0 } }
  ]
}'
```

- 成功返回 `{ planRevision, previousPlanRevision, applied, plan }`（`plan` 为方案完整视图）；
- 规则违反 → 422 `validation_failed`（与正式航次同构），**方案不变**；请求级错误 → 400 `invalid_adjustment`；
- 方案修订号过期 → 409 `stale_revision`（`details.currentRevision` 为方案当前修订号，`details.planId` 指明方案）；
- 已发布方案 → 409 `plan_published`。

**查询**：`GET /api/plans/<planId>` 返回当前试排布局、固定约束与版本；未知方案 → 404 `plan_not_found`。`GET /api/voyages/<id>/plans` 返回航次下方案摘要列表。

**发布**：

```bash
curl -sS -X POST http://localhost:3000/api/plans/<planId>/publish
```

- 仅当**航次当前修订号仍等于 `sourceRevision`**：同一事务内把方案布局写入航次新修订号、新修订号继承方案约束快照、方案置 `published` 只读 → 201：

  ```json
  { "published": true, "replay": false, "planId": "…", "voyageId": "…",
    "sourceRevision": 2, "planRevision": 1, "voyageRevision": 3,
    "publishedAt": "…", "layout": { "revision": 3, "current": true, … } }
  ```

- 航次已前进 → 409 `publish_conflict`（`details` 含 `sourceRevision`/`currentRevision`/`planRevision`），**方案保留**仍为 `open`，可继续调整或另建方案；
- 已发布方案重复发布 → 200 `replay:true`，返回**首次发布结果**（同一 `voyageRevision` 与 `publishedAt`，不产生新修订号）；
- 发布产生的新修订号与正式调整完全同构：历史布局可查、可据此签发清单、可开启核对作业；既有历史布局、旧清单与在办核对保持冻结。

### 4.9 方案迁移（航次前进后的 rebase，`POST /api/plans/:planId/migrate`）

航次修订号前进导致 `publish` 返回 `publish_conflict` 时，调度员不必丢弃方案重做，可把方案**迁移到当前航次**。请求体提交所见的两个修订号：

```json
{ "planRevision": 1, "voyageRevision": 2 }
```

- `planRevision`：调度员所见**方案修订号**（`GET /api/plans/:planId` 的 `planRevision`）；
- `voyageRevision`：调度员所见**航次修订号**（`GET /api/voyages/:id` 的 `revision`）。

**逐箱三方合并**（共同基线＝方案**来源修订号的正式布局**；两方＝方案当前布局、航次当前布局；任一布局中缺失的箱按**空位置**即撤位处理）：

| 情形 | 合并结果 |
| --- | --- |
| 双方都未相对基线改动 | 沿用基线位置 |
| 仅方案方改动（含撤位） | 采用**方案**位置 |
| 仅航次方改动（含撤位） | 采用**航次**位置（追上正式布局） |
| 双方改动到**同一位置**（含双方都撤位） | 视为一致，采用该位置 |
| 双方都改动且**目标不同**（一方撤位、一方移动也算） | **冲突**：返回箱号 + `planPosition` + `voyagePosition`，方案保持原状 |

合并后的**完整布局**用**当前航次修订号的约束**复验五项配载规则。成功后在同一事务内：

1. `source_rev` 更新为当前航次修订号（**再次迁移即以该新来源修订号为基线**）；
2. 方案约束快照整体替换为当前航次修订号版本（方案固定快照随之换版）；
3. 合并布局写入新的方案修订号（`planRevision + 1`），**旧方案修订号布局在方案历史中继续留痕**；
4. 方案仍为 `open`，不触碰正式航次、清单与核对作业。

成功响应（200）：

```json
{
  "migrated": true,
  "planId": "…", "voyageId": "…",
  "previousSourceRevision": 1, "sourceRevision": 2,
  "previousPlanRevision": 1, "planRevision": 2,
  "voyageRevision": 2,
  "merge": {
    "totalBoxes": 5, "unchanged": 2, "planOnly": 1,
    "voyageOnly": 2, "bothSame": 0,
    "conflictCount": 0, "conflicts": []
  },
  "plan": { "sourceRevision": 2, "planRevision": 2, "status": "open", "placements": [ … ], … }
}
```

**拒绝情形（均不改变方案与正式航次）**：

| 场景 | 状态 / 错误码 | 说明 |
| --- | --- | --- |
| 所见方案修订号过期 | 409 `stale_revision` | `details.scope:"plan"`、`details.currentRevision` 为方案当前修订号 |
| 所见航次修订号过期 | 409 `stale_revision` | `details.scope:"voyage"`、`details.currentRevision` 为航次当前修订号 |
| 方案已发布 | 409 `plan_published` | 已发布方案只读，无需迁移 |
| 来源修订号仍等于航次当前修订号 | 409 `migration_not_needed` | 航次未前进，可直接发布；`details` 含双方修订号 |
| 双方改动目标不同 | 409 `migration_conflict` | `details.conflicts[]`：`{boxNo, planPosition, voyagePosition}`（撤位一方位置为 `null`），方案保持原状；调度员在方案内调整冲突箱后可重试 |
| 合并布局违反当前航次约束 | 422 `validation_failed` | 与整批调整同构的 `violations[]`（箱号/位置/原因），**不迁移** |
| 请求体非法 / 方案 ID 非法 | 400 | `invalid_request_body` / `invalid_plan_id` |
| 方案不存在 | 404 `plan_not_found` | — |

> 迁移只重定方案基线与方案快照，**不产生航次修订号、不改变正式布局/清单/核对作业**；迁移后方案的 `sourceRevision` 等于航次当前修订号，即可按 4.8 节正常发布，发布仍遵守 `publish_conflict` 与重复发布幂等规则。

### 4.10 港序卸货审查（按冻结清单逐港模拟，不倒箱判定）

调度员判断**已签发清单能否按港序卸货而不倒箱**。审查基准是某修订号的**已签发冻结清单**（`manifest_items` 独立副本）：按清单冻结箱位模拟，不读取当前布局，因此航次后续调整、约束变更、签发新清单都**不改变**任何既有审查结果。

**提交**（路径 `:rev` 为清单修订号；请求体为有序卸港列表 + 清单内每箱卸港）：

```bash
curl -sS -X POST http://localhost:3000/api/voyages/<id>/manifests/1/discharge-reviews \
  -H 'content-type: application/json' -d '{
  "ports": ["SHA", "SIN", "HAM"],
  "items": [
    { "boxNo": "BOX-1", "dischargePort": "SIN" },
    { "boxNo": "BOX-2", "dischargePort": "SIN" },
    { "boxNo": "BOX-3", "dischargePort": "SHA" },
    { "boxNo": "BOX-4", "dischargePort": "HAM" }
  ]
}'
```

请求要求（任一不满足即**明确拒绝**，见错误码表）：

- 清单修订号必须已签发（未知清单 → 404 `manifest_not_found`，未知航次 → 404 `voyage_not_found`）；
- `ports` 必须**有序、非空、不重复**（空列表 → 400 `invalid_request_body`；重复港 → 400 `invalid_discharge_request`，issue `duplicate_port_in_order`）；
- `items` 箱号集合必须与清单**完全一致**：缺漏 → `manifest_box_missing`，多余/清单外箱 → `unknown_box_for_manifest`，同箱重复申报 → `duplicate_box_in_request`；
- 每箱 `dischargePort` 必须出现在 `ports` 中，否则 `unknown_discharge_port`。业务问题一次性在 `details.issues[]` 全部返回。

**模拟语义**（列＝同一 `(bay,row)` 垂直堆叠，只有列顶箱可直接卸）：

1. 按 `ports` 顺序逐港作业；
2. 每港对全船反复扫描，卸走所有“**列顶（同列上方已空）且卸港为本港**”的箱；只要本轮有箱卸下就继续扫描，直到再无可卸箱（同港箱叠放可连锁卸出）；
3. 本港结束时仍在船的本港箱记入 `blocked`（受阻留船），其 `blockers[]` 列出**同列上方仍在船的全部阻挡箱**，自近而远（tier 由低到高）给出 `boxNo` 与冻结 `position`，并标注相对本港的关系：
   - `later`：后续港箱（典型“被后续港箱压住”）；
   - `same`：同为当前港箱（其本身这一港也受阻）；
   - `earlier`：此前港次已漏卸的逾港箱（漏港箱在后续港反过来压住本港箱）；
4. **后续港不回补此前漏卸箱**：箱在其卸港未卸即永久留船；全部港次走完后仍在船的箱进入 `overCarried[]`（含其应卸港序号 `dischargePortIndex` 与冻结箱位）；
5. `feasibleWithoutRestow` 为 `true` 当且仅当最终无逾港未卸箱（全部箱都在其卸港当港卸空）。

**响应**（201 首次创建；`simulation` 为完整模拟结果）：

```json
{
  "reviewId": "…uuid…", "replay": false,
  "voyageId": "…", "manifestRevision": 1,
  "requestHash": "…sha256…", "createdAt": "…",
  "ports": ["SHA", "SIN", "HAM"],
  "items": [ …与提交一致… ],
  "simulation": {
    "ports": ["SHA", "SIN", "HAM"],
    "portResults": [
      {
        "port": "SHA", "portIndex": 1,
        "discharged": [ { "boxNo": "BOX-3", "position": { "bay": 1, "row": 1, "tier": 2 } } ],
        "blocked": []
      },
      {
        "port": "SIN", "portIndex": 2,
        "discharged": [
          { "boxNo": "BOX-1", "position": { "bay": 1, "row": 1, "tier": 0 } },
          { "boxNo": "BOX-2", "position": { "bay": 1, "row": 1, "tier": 1 } }
        ],
        "blocked": []
      },
      {
        "port": "HAM", "portIndex": 3,
        "discharged": [ { "boxNo": "BOX-4", "position": { "bay": 2, "row": 1, "tier": 0 } } ],
        "blocked": []
      }
    ],
    "overCarried": [],
    "feasibleWithoutRestow": true,
    "counts": { "totalBoxes": 4, "discharged": 4, "blockedAtOwnPort": 0, "overCarried": 0 }
  }
}
```

不可行示例（BOX-1 为 SHA 箱被压在 SIN/HAM 箱下方）的受阻明细形如：

```json
{
  "port": "SHA", "portIndex": 1,
  "discharged": [ { "boxNo": "BOX-4", "position": { "bay": 2, "row": 1, "tier": 0 } } ],
  "blocked": [
    {
      "boxNo": "BOX-1",
      "position": { "bay": 1, "row": 1, "tier": 0 },
      "dischargePort": "SHA",
      "blockers": [
        { "boxNo": "BOX-2", "position": { "bay": 1, "row": 1, "tier": 1 }, "dischargePort": "SIN", "relation": "later" },
        { "boxNo": "BOX-3", "position": { "bay": 1, "row": 1, "tier": 2 }, "dischargePort": "HAM", "relation": "later" }
      ]
    }
  ]
}
```

**冻结、幂等与查询**：

- 同一清单 + 同一提交内容（`ports` 与按箱号排序后的 `items` 的 sha256 指纹）重复提交 → **200 `replay:true`**，返回首次审查的同一 `reviewId` 与冻结结果，不重新模拟、不新建记录；
- 同一清单允许按**不同港序/不同卸港申报**多次审查，各自独立留档；
- `GET /api/voyages/:id/discharge-reviews`（可带 `?manifestRevision=N`）列出审查；`GET /api/discharge-reviews/:reviewId` 取单条冻结结果（未知审查 → 404 `discharge_review_not_found`）；
- 审查结果在创建时即随提交内容落库（`discharge_reviews`），航次后续调整或签发新清单后，旧审查仍返回原冻结结论。

### 4.11 靠泊窗口预订（依据已留档卸货审查）

卸货审查留档后，**港口调度员**依据某次审查为其中某一卸港预订靠泊窗口。预订基准是该审查**已冻结的模拟结果**：只有该港在模拟中**确有实际卸箱（`discharged > 0`）且无受阻箱（`blocked = 0`）**才受理——有受阻箱意味着该港不倒箱就卸不完，不安排靠泊。受理时把**清单修订号**与**该港实际卸箱数**随预订冻结，之后无论审查所基于的布局怎样调整、是否签发新清单，预订快照都**不回写**。

**提交**（路径 `:reviewId` 为已留档审查；请求体给出港、泊位、窗口与提交号）：

```bash
curl -sS -X POST http://localhost:3000/api/discharge-reviews/<reviewId>/berth-bookings \
  -H 'content-type: application/json' -d '{
  "reviewId": "<reviewId>",
  "dischargePort": "SIN",
  "berth": "B-7",
  "startAt": "2026-10-10T08:00:00+08:00",
  "endAt":   "2026-10-10T12:00:00+08:00",
  "submissionNo": "SUB-001"
}'
```

字段要求：

- `reviewId`：已留档的卸货审查 ID（未知审查 → 404 `discharge_review_not_found`；路径与体不一致时以路径为准）；
- `dischargePort`：**审查内**的卸港，必须出现在该审查的 `ports` 港序中（否则 400 `unknown_discharge_port_for_review`），且满足受理条件（否则 422 `port_not_dischargeable`，`details` 给出该港实际卸箱数/受阻箱数）；
- `berth`：泊位标识（非空文本，最长 64）；
- `startAt` / `endAt`：**带时区**的 ISO 8601 时刻（如 `2026-10-10T08:00:00+08:00` 或 `...Z`，**不接受无时区**的本地时刻），且起点必须**严格早于**终点（相等也拒绝）；否则 400 `invalid_time_window`（`details.issues[]` 区分 `unparsable_time` / `start_not_before_end`）；
- `submissionNo`：客户端生成的提交号，**同一审查内唯一**，是重试幂等键。

**响应**（首次受理 201；时刻统一按绝对瞬间以 UTC ISO 8601 回显）：

```json
{
  "replay": false,
  "bookingId": "…uuid…",
  "reviewId": "…", "voyageId": "…",
  "dischargePort": "SIN", "berth": "B-7",
  "startAt": "2026-10-10T00:00:00.000Z",
  "endAt":   "2026-10-10T04:00:00.000Z",
  "submissionNo": "SUB-001",
  "status": "booked", "open": true,
  "frozenManifestRevision": 1,
  "dischargedBoxCount": 2,
  "createdAt": "…", "cancelledAt": null
}
```

**窗口互斥与“同一审查同一港”**（均由数据库约束最终保证）：

- **同港同泊位的有效窗口不得重叠**：以半开区间 `[startAt, endAt)` 判定，故一个窗口的 `end` 恰好等于下一窗口的 `start`（**首尾相接**）允许，只要有任何瞬间重叠即冲突。该互斥是**全局**的——即使两个窗口来自**不同航次的不同审查**，只要卸港名与泊位名相同就互斥；冲突 → 409 `berth_window_overlap`，`details.conflicting` 回带占窗方预订。并发竞争时由部分 GiST 排他约束决出**唯一胜者**，其余事务收到 409；
- 不同泊位即使完全同时段也互不影响；
- **同一审查同一卸港至多一个有效预订** → 否则 409 `booking_exists_for_port`（`details.existingBooking` 回带既有预订）；要改期可用 `POST /api/berth-bookings/:bookingId/adjust`（见 4.12），或先取消再用**新提交号**重新预订。

**提交号幂等 / 冲突**：

- 相同 `submissionNo` + **相同内容**（港/泊位/起止，时刻按**绝对瞬间**比较——不同时区写法指向同一时刻即相同）重试 → **200 `replay:true`**，返回首次预订的**当前状态**（预订仍有效则 `booked`，已被取消则返回 `cancelled`），不产生新记录；
- 相同 `submissionNo` + **不同内容** → 409 `booking_submission_conflict`；重新预订必须换用新提交号。

**取消**：`POST /api/berth-bookings/:bookingId/cancel`

- 预订记录**永久保留**，状态置 `cancelled`、记录 `cancelledAt`；因互斥/唯一约束只作用于有效（`booked`）记录，取消后窗口占用与“同审查同港”名额**立即释放**；
- 首次取消 200；对已取消预订重复取消 → 200 `replay:true` 返回**已取消状态**（幂等）；
- 未知预订 → 404 `berth_booking_not_found`。

**查询**：

- `GET /api/discharge-reviews/:reviewId/berth-bookings`：按审查列出全部预订（含已取消，记录保留），未知审查 → 404；
- `GET /api/voyages/:id/berth-bookings`：按航次列出其各审查下的预订，未知航次 → 404；
- `GET /api/berth-bookings/:bookingId`：取单条预订（`{ booking: {...} }`），未知预订 → 404。

**错误码一览（本节新增）**：

| 状态 | 错误码 | 场景 |
| --- | --- | --- |
| 400 | `invalid_request_body` | 请求体缺字段/类型不符（zod 校验） |
| 400 | `invalid_discharge_review_id` / `invalid_berth_booking_id` | 路径 ID 非 UUID |
| 400 | `invalid_time_window` | 时刻无法解析/缺时区（`unparsable_time`）或起点不早于终点（`start_not_before_end`） |
| 400 | `unknown_discharge_port_for_review` | 卸港不在该审查港序列表中（`details.reviewPorts`） |
| 404 | `discharge_review_not_found` / `berth_booking_not_found` | 未知审查 / 未知预订 |
| 409 | `berth_window_overlap` | 同港同泊位有效窗口重叠（含跨航次、并发竞争失败方） |
| 409 | `booking_exists_for_port` | 同一审查同一卸港已有有效预订 |
| 409 | `booking_submission_conflict` | 提交号已用于不同内容 / 被并发抢先占用 |
| 422 | `port_not_dischargeable` | 该港无实际卸箱或存在受阻箱，不满足靠泊受理条件 |

### 4.12 靠泊预订改期（调整已生效的预订，原子换窗）

已生效（`booked`）的靠泊预订可由港口调度员**改期**：换泊位、换窗口或两者一起。改期不修改原记录，而是**在同一事务内**取消旧记录并创建继承其上下文的新记录——**释放旧窗口与占用新窗口原子完成**，任何一步失败都整体回滚，原预订保持不变。

**提交**（路径 `:bookingId` 为仍有效的原预订；请求体给出新泊位、新窗口与调整号）：

```bash
curl -sS -X POST http://localhost:3000/api/berth-bookings/<bookingId>/adjust \
  -H 'content-type: application/json' -d '{
  "berth": "B-8",
  "startAt": "2026-10-10T13:00:00+08:00",
  "endAt":   "2026-10-10T16:00:00+08:00",
  "adjustmentNo": "ADJ-001"
}'
```

字段要求：

- `berth`：新泊位标识（非空文本，最长 64）；
- `startAt` / `endAt`：**带时区**的 ISO 8601 时刻，起点必须严格早于终点（否则 400 `invalid_time_window`，与预订同一套 `unparsable_time` / `start_not_before_end` 判定）；
- `adjustmentNo`：客户端生成的调整号，**同一原预订内唯一**，是改期重试的幂等键（不同原预订之间互不影响，可各自使用同名调整号）；
- 审查、卸港与冻结的清单修订号/实际卸箱数**继承自原预订**，不在请求体内（改期不重新判定卸港受理条件，快照随新记录继续冻结、不回写）。

**响应**（首次受理 201；`booking` 为新记录，`previousBooking` 为已取消并关联新记录的原记录）：

```json
{
  "adjusted": true,
  "replay": false,
  "booking": {
    "bookingId": "…新 uuid…",
    "reviewId": "…", "voyageId": "…",
    "dischargePort": "SIN", "berth": "B-8",
    "startAt": "2026-10-10T05:00:00.000Z",
    "endAt":   "2026-10-10T08:00:00.000Z",
    "submissionNo": null,
    "adjustmentOfBookingId": "…原预订…",
    "adjustmentNo": "ADJ-001",
    "replacedByBookingId": null,
    "status": "booked", "open": true,
    "frozenManifestRevision": 1,
    "dischargedBoxCount": 2,
    "createdAt": "…", "cancelledAt": null
  },
  "previousBooking": {
    "bookingId": "…原预订…", "berth": "B-7",
    "status": "cancelled", "open": false,
    "replacedByBookingId": "…新 uuid…",
    "cancelledAt": "…"
  }
}
```

**受理与拒绝**（以下任一不满足即拒绝且**原预订保持不变**）：

- 原预订必须存在（未知 → 404 `berth_booking_not_found`）且**仍有效**：已取消（含被先前改期取代）→ 409 `booking_not_active`（`details` 给出当前状态与 `replacedByBookingId`）；
- 新起止时刻必须合法（否则 400 `invalid_time_window`）；
- 新窗口沿用同一套互斥规则：**同港同泊位的其他有效窗口不得重叠**（半开区间，首尾相接可用，跨航次同样互斥）→ 409 `berth_window_overlap`（`details.conflicting` 回带占窗方）。原预订自身不参与判定——它在同事务内被先行取消，因此**同泊位平移（新窗口与自身旧窗口重叠）允许**；
- **同审查同港唯一**同样沿用：新记录继承原审查与卸港，旧记录取消后名额即刻让位于新记录。

**调整号幂等 / 冲突**：

- 相同 `adjustmentNo` + **相同内容**（泊位/起止，时刻按**绝对瞬间**比较——不同时区写法指向同一时刻即相同）重试 → **200 `replay:true`**，返回**新记录当前状态**（新记录此后可能已被取消或再次改期，如实返回），不产生新记录；
- 相同 `adjustmentNo` + **不同内容** → 409 `booking_adjustment_conflict`（`details.stored` 为已受理的新记录）；再次改期须换用新调整号。

**链式改期与兼容行为**：

- 改期产生的新记录本身也是有效预订，可再次改期（调整号按其自身隔离）或按既有接口取消（取消后其窗口立即释放）；
- 改期记录的 `submissionNo` 为 `null`：**原提交号永远指向原记录**——用原提交号同内容重试创建接口仍返回原预订的当前状态（已取消、含 `replacedByBookingId`），既有预订/取消/查询/提交号重试行为完全不变；
- 查询接口（按审查/按航次/单条）返回全部记录（含已取消的改期链），每条带 `adjustmentOfBookingId` / `adjustmentNo` / `replacedByBookingId` 关联字段；
- 并发：同一原预订的并发改期按行锁串行化，只有一方成功（其余 409 `booking_not_active` 或按调整号幂等回放）；不同原预订竞争同一新窗口时由排他约束决出唯一胜者（败方 409 `berth_window_overlap`，其原预订不变）。

**错误码一览（本节新增）**：

| 状态 | 错误码 | 场景 |
| --- | --- | --- |
| 400 | `invalid_request_body` | 请求体缺字段/类型不符（zod 校验） |
| 400 | `invalid_berth_booking_id` / `invalid_time_window` | 路径 ID 非 UUID；时刻无法解析/缺时区或起点不早于终点 |
| 404 | `berth_booking_not_found` | 未知原预订 |
| 409 | `booking_not_active` | 原预订已取消（含已被先前改期取代），仅有效预订可改期 |
| 409 | `booking_adjustment_conflict` | 调整号已用于该原预订的不同改期内容 |
| 409 | `berth_window_overlap` | 新窗口与同港同泊位其他有效窗口重叠（含并发竞争失败方） |

### 状态码约定

| 状态 | 场景 |
| --- | --- |
| 200 / 201 | 查询成功 / 创建或首次签发、首次受理上报、首次结案成功、首次发布方案（幂等重试返回 200） |
| 400 | 请求体非法、未知箱、坐标越界、靠泊预订的非法/缺时区时刻（`invalid_time_window`：`unparsable_time`/`start_not_before_end`，预订与改期共用）、同港同泊位冲突的请求级前置校验；同批重复箱号；约束变更的非正承重/越界列坐标/重复类别对或重复列覆盖；方案 ID 格式非法；**卸货审查的空/重复港序（`invalid_discharge_request`，issues：`empty_port_order`/`duplicate_port_in_order`/`duplicate_box_in_request`/`unknown_box_for_manifest`/`manifest_box_missing`/`unknown_discharge_port`）；靠泊预订审查外卸港（`unknown_discharge_port_for_review`）** |
| 404 | 航次/修订号/清单/核对作业/试排方案/**卸货审查/靠泊预订**不存在（含以未签发清单开工或审查） |
| 409 | 修订号过期（整批调整、约束变更、签发、方案内调整、**方案迁移（分方案/航次两个 scope）**共用）；同清单重复开工、上报号内容冲突、结案后新上报、核对有差异不可结案；方案已发布（`plan_published`）、航次修订号偏离方案来源（`publish_conflict`）、**方案迁移双方改动目标不同（`migration_conflict`）或无需迁移（`migration_not_needed`）；靠泊窗口重叠（`berth_window_overlap`，含跨航次与并发竞争）、同审查同卸港重复有效预订（`booking_exists_for_port`）、提交号内容冲突（`booking_submission_conflict`）；改期时原预订已失效（`booking_not_active`）、调整号内容冲突（`booking_adjustment_conflict`）** |
| 422 | 配载规则违反整批拒绝（整批调整、约束变更复验、方案内调整、**方案迁移按当前航次约束复验**）；或尚有箱未配位即签发；**靠泊预订的卸港无实际卸箱或有受阻箱（`port_not_dischargeable`）** |
| 503 | `/health` 数据库不可达 |

---

## 5. 调用示例

- `examples/curl-examples.sh` —— 全流程 curl（登记→违规拒绝→合法整批→同批交换→撤位→签发→后续调整→旧清单）：

  ```bash
  BASE=http://localhost:3000 bash examples/curl-examples.sh
  ```

- `examples/check-curl.sh` —— 现场核对全流程 curl（自备已签发清单→开工→上报/重试/冲突/越界→错位/清单外→撤销→结案→结案后行为）：

  ```bash
  BASE=http://localhost:3000 bash examples/check-curl.sh
  ```

- `examples/constraints-curl.sh` —— 安全约束变更全流程 curl（配位→复验失败 422→过期 409→请求级 400→整套替换成功/布局继承→历史布局旧约束→旧清单与在办核对不受影响→后续调整按新约束）：

  ```bash
  BASE=http://localhost:3000 bash examples/constraints-curl.sh
  ```

- `examples/plans-curl.sh` —— 试排方案全流程 curl（建立两个独立方案→方案内调整 200/422/409→查询方案→正式航次不受影响→发布冲突 409 保留方案→新方案发布 201→只读/重复发布幂等→签发与核对照常）：

  ```bash
  BASE=http://localhost:3000 bash examples/plans-curl.sh
  ```

- `examples/migrate-curl.sh` —— 方案迁移全流程 curl（航次前进后发布冲突→提交方案/航次所见修订号迁移：逐箱合并成功→换基线发布→双方目标不同 409 冲突保持原状→所见版本过期 409）：

  ```bash
  BASE=http://localhost:3000 bash examples/migrate-curl.sh
  ```

- `examples/discharge-curl.sh` —— 港序卸货审查全流程 curl（自备已签发清单→可行审查连锁卸空→同内容重放→不可行审查的受阻箱/阻挡箱/逾港箱→空/重复港序与箱号缺漏/多余/未知港拒绝→列表与单条查询→签发新清单后旧审查结论不变）：

  ```bash
  BASE=http://localhost:3000 bash examples/discharge-curl.sh
  ```

- `examples/berth-curl.sh` —— 靠泊窗口预订全流程 curl（自备可行卸货审查→首次预订冻结修订号/卸箱数→同号同内容重放/改内容冲突→同审查同港拒绝/首尾相接→非法时刻/未知港/未知审查→查询→取消与重复取消幂等→取消后新提交号重新预订）：

  ```bash
  BASE=http://localhost:3000 bash examples/berth-curl.sh
  ```

- `examples/adjust-curl.sh` —— 靠泊预订改期全流程 curl（自备有效预订→无效时刻 400 原预订不变→首次改期 201 原子换窗/继承冻结快照/旧记录关联新记录→同调整号同内容重放/改内容冲突→已取代原预订 409→链式改期→原提交号重试兼容→改期链查询）：

  ```bash
  BASE=http://localhost:3000 bash examples/adjust-curl.sh
  ```

- `examples/api.http` —— REST Client / JetBrains HTTP Client 文件（含核对段落）；
- `examples/demo.ts` —— Node 示例（内置 fetch）：

  ```bash
  BASE=http://localhost:3000 npx tsx examples/demo.ts
  ```

---

## 6. 项目结构

```
src/
  domain.ts        领域模型 + 纯函数规则校验（最终布局五项规则、请求级检查、十进制重量、迁移三方合并）
  check.ts         装船核对纯函数（最后上报汇总、应装/已核对/缺失/错位/清单外、结案条件）
  discharge.ts     港序卸货模拟纯函数（请求级校验、逐港列顶卸货迭代、阻挡链关系、逾港未卸、可行性）
  berthing.ts      靠泊预订纯函数（带时区窗口解析/起点早于终点、卸港受理判定=有实卸且无受阻、提交/改期内容一致性）
  service.ts       事务编排：乐观修订号、整批调整、签发冻结、并发互斥
  check-service.ts 核对作业事务：开工/上报幂等与冲突/留痕/状态/结案冻结（行级互斥）
  discharge-service.ts 卸货审查事务：清单冻结箱位读取、请求校验、模拟落档、同内容幂等（永久留档）
  berth-service.ts 靠泊预订事务：审查冻结结果读取、受理判定、提交号幂等/冲突、窗口排他与同港唯一（DB 约束兜底并发）、取消释放；改期=原子换窗（旧记录取消并关联新记录、新记录继承冻结快照、调整号幂等/冲突）
  plan-service.ts  试排方案事务：建立快照/方案内整批调整/查询/发布/迁移rebase（方案行 + 航次行互斥）
  db.ts            连接池、等待就绪、幂等建表
  schema.sql       PostgreSQL 表结构（航次/列限/箱/不相容规则/修订布局/清单/核对作业与上报/试排方案/卸货审查/靠泊预订）
  http/            Express 路由与 zod 请求校验
  config.ts errors.ts app.ts start.ts
test/
  validator.test.ts  配载规则单元测试（node --test）
  check.test.ts      核对纯函数单元测试
  merge.test.ts      方案迁移三方合并纯函数单元测试（一方改动/双方同位/撤位/冲突）
  discharge.test.ts  港序卸货模拟纯函数单元测试（列顶迭代/连锁卸/阻挡 same/later/earlier/逾港/请求拒绝）
  berthing.test.ts   靠泊预订纯函数单元测试（带时区窗口/起点早于终点、等效时区、卸港受理判定、提交/改期内容一致性）
  e2e.js             对真实 PostgreSQL 的端到端/并发验证（开发辅助）
  e2e-check.js       核对作业端到端/并发验证（开发辅助）
  e2e-constraints.js 安全约束变更端到端/历史留痕/并发验证（开发辅助）
  e2e-plans.js       试排方案端到端/发布冲突/只读幂等/并发验证（开发辅助）
  e2e-migrate.js     方案迁移端到端/三方合并/冲突/复验失败/过期/连续迁移/并发（开发辅助）
  e2e-discharge.js   港序卸货审查端到端/逐港模拟/阻挡链/逾港/冻结不变/拒绝/幂等（开发辅助）
  e2e-berth.js       靠泊预订端到端/窗口互斥/首尾相接/跨航次/并发一方成功/幂等冲突/取消释放/冻结不回写（开发辅助）
  e2e-adjust.js      靠泊改期端到端/原子换窗/继承冻结快照/调整号幂等冲突/失败不改原预订/自我平移/链式/并发（开发辅助）
examples/          curl / .http / Node 调用示例
Dockerfile  docker-compose.yml
```

### 存储要点

- `voyages.rev` 为当前修订号；`placements` 按 `(voyage_id, rev)` 全量保存每个接受批次后的完整布局（历史可追溯）；
- **约束随修订号快照**：`constraint_defaults` / `constraint_column_limits` / `constraint_incompat_rules` 按 `(voyage_id, rev)` 保存每个修订号当时生效的整套默认列承重、按列覆盖与不相容类别对。整批调整把当前约束复制到新修订号；约束变更把当前布局复制到新修订号并写入新约束；
- 舱位尺寸存于 `voyages`、箱档案存于 `boxes`，二者登记后不可变更（约束变更不触碰）；
- `manifests` + `manifest_items` 保存签发时刻的**独立冻结副本**，与后续布局/约束解耦；
- 重量以 `BIGINT` 微千克（1kg = 10⁶）存储，精确支持小数重量；
- `check_jobs` 以 `(voyage_id, manifest_rev)` 唯一引用冻结清单（同一清单最多一个作业，外键随清单删除级联）；
- `check_reports` 每次受理上报一行：`(job_id, report_no)` 唯一保证上报号幂等、`(job_id, seq)` 唯一记录受理顺序；`revoked=true` 时坐标为空。当前实装状态取每箱 `seq` 最大的一条。
- `stowage_plans` 记录试排方案：来源修订号 `source_rev`、独立的方案修订号 `rev`、状态（`open`/`published`）与发布结果（`published_rev`/`published_at`，供重复发布幂等重放）；
- `plan_placements` 按 `(plan_id, rev)` 全量保存方案每个方案修订号的试排布局（与 `placements` 同构留痕）；
- `plan_constraint_defaults` / `plan_constraint_column_limits` / `plan_constraint_incompat_rules` 保存方案创建时固定的约束快照（每方案一份，不随方案修订号演进）；发布时把方案布局与这套约束原子复制为航次新修订号的 `placements` 与约束快照。
- `discharge_reviews` 保存港序卸货审查：`(voyage_id, manifest_rev, request_hash)` 唯一使“同清单 + 同提交内容”天然幂等；`request_jsonb` 冻结有序港序与每箱卸港，`result_jsonb` 冻结逐港模拟结果（各港实卸/受阻/阻挡箱与箱位/逾港未卸/可行性）。审查只读取 `manifest_items` 冻结箱位，**航次后续调整或签发新清单不改变旧审查结论**；同一清单的不同港序/卸港申报各自独立留档。
- `berth_bookings` 保存靠泊窗口预订：`(review_id, submission_no)` 唯一保证提交号在审查内唯一（支撑同号同内容幂等）；**部分唯一索引** `(review_id, discharge_port) WHERE status='booked'` 保证同一审查同一卸港至多一个有效预订；**部分 GiST 排他约束** `EXCLUDE (discharge_port WITH =, berth WITH =, tstzrange(start_at,end_at,'[)') WITH &&) WHERE status='booked'` 保证同港同泊位有效窗口不重叠（半开区间故首尾相接可用），该约束不区分审查/航次，故**跨航次同名港+同名泊位同样互斥，并发 INSERT 只成功一方**（依赖 `btree_gist` 扩展为文本列提供 GiST `=` 操作类）。取消只把 `status` 置 `cancelled` 并记 `cancelled_at`：记录保留，且因两个部分约束只含 `booked`，占用立即释放。`manifest_rev` 与 `port_box_count` 在受理时从审查冻结结果复制快照，**后续审查调整或签发新清单不回写**；时刻以 `TIMESTAMPTZ` 存储，对外统一 UTC ISO 8601。
- **改期**在同一事务内完成“旧记录置 `cancelled` + 插入新记录 + 旧记录回写 `replaced_by_id`”：新记录继承原 `review_id`/`voyage_id`/`discharge_port`/`manifest_rev`/`port_box_count`（冻结快照延续），`submission_no` 置空（原提交号永远指向原记录，其重试行为不变），并以 `adjustment_of_id` 指回原预订、`adjustment_no` 记录调整号；**部分唯一索引** `(adjustment_of_id, adjustment_no) WHERE adjustment_no IS NOT NULL` 保证同一原预订的调整号唯一（支撑同号同内容幂等）。新记录同样受上述两个 `booked` 部分约束把关，故同审查同港唯一与跨航次窗口互斥对改期窗口同样生效；同一原预订的并发改期由原预订行锁串行化。以上对既有库通过幂等 `ALTER TABLE ... IF NOT EXISTS` / `DROP NOT NULL` 就地升级。

> 从早期“约束不随修订号留痕”的版本升级时，`src/schema.sql` 启动会幂等地把旧的 `column_weight_limits` / `incompat_rules`（当时全局且不可变）回填为每个历史修订号的快照，再删除旧表；新库不受影响。
