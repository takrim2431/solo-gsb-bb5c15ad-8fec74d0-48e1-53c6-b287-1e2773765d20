/* eslint-disable no-console */
// 靠泊预订改期（调整已生效预订）端到端验证：embedded-postgres + 真实 Express HTTP
// 运行: npm run build && node test/e2e-adjust.js
const path = require('path');
process.env.SCHEMA_PATH = path.join(__dirname, '..', 'src', 'schema.sql');
const EmbeddedPostgres = require('embedded-postgres').default;

const PORT = 30199;
const BASE = `http://127.0.0.1:${PORT}/api`;
let passed = 0;
let failed = 0;

function check(name, cond, extra) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}`, extra ?? '');
  }
}

async function http(method, url, body, expectedStatus) {
  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (expectedStatus !== undefined && res.status !== expectedStatus) {
    throw new Error(`${method} ${url} 期望 ${expectedStatus} 实际 ${res.status}: ${JSON.stringify(json)}`);
  }
  return { status: res.status, body: json };
}

/** 登记航次 + 配载 + 签发 rev1（清单 4 箱） */
async function setupVoyage(voyageNo) {
  const { body: voyage } = await http('POST', `${BASE}/voyages`, {
    voyageNo,
    bays: 2, rows: 1, tiers: 3,
    defaultColumnWeightLimit: '10000',
    boxes: [
      { boxNo: 'BOX-1', weight: '500', category: '1' },
      { boxNo: 'BOX-2', weight: '500', category: '1' },
      { boxNo: 'BOX-3', weight: '500', category: '1' },
      { boxNo: 'BOX-4', weight: '500', category: '1' },
    ],
  }, 201);
  const vid = voyage.id;
  await http('POST', `${BASE}/voyages/${vid}/moves`, {
    baseRevision: 0,
    moves: [
      { boxNo: 'BOX-1', position: { bay: 1, row: 1, tier: 0 } },
      { boxNo: 'BOX-2', position: { bay: 1, row: 1, tier: 1 } },
      { boxNo: 'BOX-3', position: { bay: 1, row: 1, tier: 2 } },
      { boxNo: 'BOX-4', position: { bay: 2, row: 1, tier: 0 } },
    ],
  }, 200);
  await http('POST', `${BASE}/voyages/${vid}/manifests`, { expectedRevision: 1 }, 201);
  return vid;
}

/** 可行审查：SHA 卸 BOX-3；SIN 连锁卸 BOX-1/2；HAM 卸 BOX-4（每港有实卸、无受阻） */
async function createReview(vid) {
  const { body } = await http('POST', `${BASE}/voyages/${vid}/manifests/1/discharge-reviews`, {
    ports: ['SHA', 'SIN', 'HAM'],
    items: [
      { boxNo: 'BOX-1', dischargePort: 'SIN' },
      { boxNo: 'BOX-2', dischargePort: 'SIN' },
      { boxNo: 'BOX-3', dischargePort: 'SHA' },
      { boxNo: 'BOX-4', dischargePort: 'HAM' },
    ],
  }, 201);
  return body.reviewId;
}

async function book(reviewId, port, berth, startAt, endAt, submissionNo, expected = 201) {
  return http('POST', `${BASE}/discharge-reviews/${reviewId}/berth-bookings`, {
    reviewId, dischargePort: port, berth, startAt, endAt, submissionNo,
  }, expected);
}

async function adjust(bookingId, berth, startAt, endAt, adjustmentNo, expected) {
  return http('POST', `${BASE}/berth-bookings/${bookingId}/adjust`, {
    berth, startAt, endAt, adjustmentNo,
  }, expected);
}

async function main() {
  const pg = new EmbeddedPostgres({
    databaseDir: path.join('/tmp', 'pgdata-e2e-adjust'),
    user: 'stowage',
    password: 'stowage',
    port: 54399,
    persistent: false,
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('stowage');

  const { createPool, waitForDatabase, initSchema } = require('../dist/src/db');
  const { createApp } = require('../dist/src/app');
  const pool = createPool({
    databaseUrl: 'postgres://stowage:stowage@127.0.0.1:54399/stowage',
    schemaPath: process.env.SCHEMA_PATH,
  });
  await waitForDatabase(pool, 30);
  await initSchema(pool, { schemaPath: process.env.SCHEMA_PATH });
  const server = await new Promise((resolve) => {
    const s = createApp(pool).listen(PORT, '127.0.0.1', () => resolve(s));
  });

  try {
    // ---- 准备：四条航次各自签发清单并做可行审查 ----
    const vids = [];
    const reviews = [];
    for (let i = 1; i <= 4; i++) {
      const vid = await setupVoyage(`V-E2E-ADJ-00${i}`);
      vids.push(vid);
      reviews.push(await createReview(vid));
    }
    const [vid1] = vids;
    const [r1, r2, r3, r4] = reviews;

    // ================= 1. 基本改期：原子换窗 + 继承冻结快照 + 关联 =================
    const a = await book(r1, 'SIN', 'B-7',
      '2026-10-10T08:00:00+08:00', '2026-10-10T12:00:00+08:00', 'SUB-001');
    const A = a.body.bookingId;

    const adj1 = await adjust(A, 'B-8',
      '2026-10-10T13:00:00+08:00', '2026-10-10T16:00:00+08:00', 'ADJ-001', 201);
    check('首次改期 201 replay=false adjusted=true',
      adj1.body.replay === false && adj1.body.adjusted === true);
    const B = adj1.body.booking.bookingId;
    check('新记录继承原审查/航次/卸港',
      adj1.body.booking.reviewId === r1 && adj1.body.booking.voyageId === vid1 &&
      adj1.body.booking.dischargePort === 'SIN');
    check('新记录继承冻结的清单修订号与实际卸箱数',
      adj1.body.booking.frozenManifestRevision === 1 && adj1.body.booking.dischargedBoxCount === 2);
    check('新记录使用新泊位与新窗口（UTC 回显）',
      adj1.body.booking.berth === 'B-8' &&
      adj1.body.booking.startAt === '2026-10-10T05:00:00.000Z' &&
      adj1.body.booking.endAt === '2026-10-10T08:00:00.000Z');
    check('新记录关联原预订（adjustmentOfBookingId/adjustmentNo），submissionNo 置空',
      adj1.body.booking.adjustmentOfBookingId === A && adj1.body.booking.adjustmentNo === 'ADJ-001' &&
      adj1.body.booking.submissionNo === null);
    check('新记录 status=booked/open=true',
      adj1.body.booking.status === 'booked' && adj1.body.booking.open === true);
    check('旧记录保留为已取消并关联新记录（replacedByBookingId）',
      adj1.body.previousBooking.bookingId === A &&
      adj1.body.previousBooking.status === 'cancelled' &&
      !!adj1.body.previousBooking.cancelledAt &&
      adj1.body.previousBooking.replacedByBookingId === B);

    const getA = await http('GET', `${BASE}/berth-bookings/${A}`, undefined, 200);
    check('GET 原预订：已取消且关联新记录',
      getA.body.booking.status === 'cancelled' && getA.body.booking.replacedByBookingId === B);

    // 旧窗口已释放：另一航次的审查可占用原窗口
    const oldWindow = await book(r2, 'SIN', 'B-7',
      '2026-10-10T08:00:00+08:00', '2026-10-10T12:00:00+08:00', 'R2-001');
    check('旧窗口释放：其他航次同港同泊位同时段可订', oldWindow.status === 201);

    // 新窗口已占用：第三个航次撞新窗口 -> 409
    const hitNew = await book(r3, 'SIN', 'B-8',
      '2026-10-10T14:00:00+08:00', '2026-10-10T15:00:00+08:00', 'R3-001', 409);
    check('新窗口占用：其他航次撞新窗口 -> 409 berth_window_overlap（冲突方为新记录）',
      hitNew.status === 409 && hitNew.body.error.code === 'berth_window_overlap' &&
      hitNew.body.error.details.conflicting.bookingId === B,
      JSON.stringify(hitNew.body));

    // ---- 2. 同调整号同内容重试（等效时区）-> 200 replay，返回新记录当前状态 ----
    const replay1 = await adjust(A, 'B-8',
      '2026-10-10T05:00:00Z', '2026-10-10T08:00:00Z', 'ADJ-001', 200);
    check('同号同内容（等效时区）重试 -> 200 replay:true 返回新记录',
      replay1.body.replay === true && replay1.body.booking.bookingId === B &&
      replay1.body.booking.status === 'booked' &&
      replay1.body.previousBooking.bookingId === A,
      JSON.stringify(replay1.body));

    // ---- 3. 同调整号改内容 -> 409，新记录不变 ----
    const adjConflict = await adjust(A, 'B-9',
      '2026-10-10T13:00:00+08:00', '2026-10-10T16:00:00+08:00', 'ADJ-001');
    check('同号改内容 -> 409 booking_adjustment_conflict',
      adjConflict.status === 409 && adjConflict.body.error.code === 'booking_adjustment_conflict');
    const getB1 = await http('GET', `${BASE}/berth-bookings/${B}`, undefined, 200);
    check('冲突后新记录不变（仍 B-8 原窗口）',
      getB1.body.booking.berth === 'B-8' && getB1.body.booking.status === 'booked');

    // ---- 4. 原提交号重试行为兼容：仍返回原预订当前状态（已取消） ----
    const subReplay = await book(r1, 'SIN', 'B-7',
      '2026-10-10T08:00:00+08:00', '2026-10-10T12:00:00+08:00', 'SUB-001', 200);
    check('原提交号同内容重试 -> 200 replay，返回原预订（已取消、关联新记录）',
      subReplay.body.replay === true && subReplay.body.bookingId === A &&
      subReplay.body.status === 'cancelled' && subReplay.body.replacedByBookingId === B);

    // ---- 5. 同审查同港唯一沿用到新记录 ----
    const samePort = await book(r1, 'SIN', 'B-10',
      '2026-10-20T08:00:00+08:00', '2026-10-20T09:00:00+08:00', 'SUB-002', 409);
    check('改期后同审查同卸港再订 -> 409 booking_exists_for_port',
      samePort.status === 409 && samePort.body.error.code === 'booking_exists_for_port');

    // ---- 6. 查询：列表含新旧记录及关联字段 ----
    const listR1 = await http('GET', `${BASE}/discharge-reviews/${r1}/berth-bookings`, undefined, 200);
    check('按审查查询：旧（取消）+ 新（有效）都在且互相关联',
      listR1.body.bookings.length === 2 &&
      listR1.body.bookings.some((x) => x.bookingId === A && x.status === 'cancelled' && x.replacedByBookingId === B) &&
      listR1.body.bookings.some((x) => x.bookingId === B && x.status === 'booked' && x.adjustmentOfBookingId === A),
      JSON.stringify(listR1.body.bookings.map((x) => [x.bookingId, x.status])));

    // ================= 7. 失败情形不改变原预订 =================
    const a2 = await book(r1, 'HAM', 'B-2',
      '2026-10-10T08:00:00+08:00', '2026-10-10T12:00:00+08:00', 'SUB-101');
    const A2 = a2.body.bookingId;

    const badTime = await adjust(A2, 'B-3',
      '2026-10-10T13:00:00', '2026-10-10T14:00:00', 'ADJ-T1');
    check('无时区时刻 -> 400 invalid_time_window',
      badTime.status === 400 && badTime.body.error.code === 'invalid_time_window' &&
      badTime.body.error.details.issues.some((i) => i.reason === 'unparsable_time'));

    const badOrder = await adjust(A2, 'B-3',
      '2026-10-10T14:00:00Z', '2026-10-10T13:00:00Z', 'ADJ-T2');
    check('起点不早于终点 -> 400 start_not_before_end',
      badOrder.status === 400 &&
      badOrder.body.error.details.issues.some((i) => i.reason === 'start_not_before_end'));

    const getA2a = await http('GET', `${BASE}/berth-bookings/${A2}`, undefined, 200);
    check('无效时刻后原预订不变（仍 booked、无取消时刻）',
      getA2a.body.booking.status === 'booked' && getA2a.body.booking.cancelledAt === null);

    // 新窗口被占用（r2 的 SIN 订了 B-7 [08:00,12:00+08)；HAM 与 SIN 不同港不互斥，
    // 故用同港 HAM 制造占用：先让 r3 订 HAM @ B-4，再让 A2 改到 B-4 同时段）
    await book(r3, 'HAM', 'B-4',
      '2026-10-10T08:00:00+08:00', '2026-10-10T12:00:00+08:00', 'R3-101');
    const occupied = await adjust(A2, 'B-4',
      '2026-10-10T09:00:00+08:00', '2026-10-10T10:00:00+08:00', 'ADJ-102');
    check('新窗口被占用 -> 409 berth_window_overlap（含冲突方）',
      occupied.status === 409 && occupied.body.error.code === 'berth_window_overlap' &&
      !!occupied.body.error.details.conflicting);
    const getA2b = await http('GET', `${BASE}/berth-bookings/${A2}`, undefined, 200);
    check('占用冲突后原预订不变（仍 booked）', getA2b.body.booking.status === 'booked');
    const stillOccupied = await book(r4, 'HAM', 'B-2',
      '2026-10-10T09:00:00+08:00', '2026-10-10T10:00:00+08:00', 'R4-101', 409);
    check('原窗口仍被原预订占用（其他航次同时段被拒）',
      stillOccupied.status === 409 && stillOccupied.body.error.code === 'berth_window_overlap');

    // 调整号按原预订隔离：A2 可复用 A 用过的调整号 ADJ-001
    const adj2 = await adjust(A2, 'B-3',
      '2026-10-10T13:00:00+08:00', '2026-10-10T14:00:00+08:00', 'ADJ-001', 201);
    check('调整号按原预订隔离（不同原预订可用同一调整号）',
      adj2.status === 201 && adj2.body.booking.adjustmentNo === 'ADJ-001');
    const D = adj2.body.booking.bookingId;

    // 已取消（被改期取代）原预订不可再调整
    const adjCancelled = await adjust(A2, 'B-5',
      '2026-10-10T15:00:00+08:00', '2026-10-10T16:00:00+08:00', 'ADJ-103');
    check('已被改期取代的原预订再调整 -> 409 booking_not_active',
      adjCancelled.status === 409 && adjCancelled.body.error.code === 'booking_not_active');

    // 经 /cancel 取消的预订同样不可调整
    await http('POST', `${BASE}/berth-bookings/${D}/cancel`, undefined, 200);
    const adjCancelled2 = await adjust(D, 'B-5',
      '2026-10-10T15:00:00+08:00', '2026-10-10T16:00:00+08:00', 'ADJ-104');
    check('已取消（cancel）预订调整 -> 409 booking_not_active',
      adjCancelled2.status === 409 && adjCancelled2.body.error.code === 'booking_not_active');

    // 取消（cancel）一个已被改期取代的记录 -> 幂等返回已取消
    const cancelA2 = await http('POST', `${BASE}/berth-bookings/${A2}/cancel`, undefined, 200);
    check('对已被改期取代的原预订取消 -> replay:true 已取消状态',
      cancelA2.body.replay === true && cancelA2.body.booking.status === 'cancelled');

    // 未知 / 非法预订 ID
    const zero = '00000000-0000-0000-0000-000000000000';
    const noBooking = await adjust(zero, 'B-1',
      '2026-10-10T15:00:00+08:00', '2026-10-10T16:00:00+08:00', 'ADJ-X');
    check('未知预订 -> 404 berth_booking_not_found',
      noBooking.status === 404 && noBooking.body.error.code === 'berth_booking_not_found');
    const badId = await http('POST', `${BASE}/berth-bookings/not-a-uuid/adjust`, {
      berth: 'B-1', startAt: '2026-10-10T15:00:00+08:00', endAt: '2026-10-10T16:00:00+08:00',
      adjustmentNo: 'ADJ-X',
    });
    check('非法预订 ID -> 400 invalid_berth_booking_id',
      badId.status === 400 && badId.body.error.code === 'invalid_berth_booking_id');
    const badBody = await http('POST', `${BASE}/berth-bookings/${A}/adjust`, {
      berth: 'B-1', startAt: '2026-10-10T15:00:00+08:00',
    });
    check('缺字段 -> 400 invalid_request_body',
      badBody.status === 400 && badBody.body.error.code === 'invalid_request_body');

    // ================= 8. 自我重叠平移 / 首尾相接 / 链式改期 =================
    const a3 = await book(r3, 'SIN', 'B-5',
      '2026-11-01T08:00:00+08:00', '2026-11-01T10:00:00+08:00', 'SUB-201');
    const A3 = a3.body.bookingId;
    // 新窗口与自身旧窗口重叠（同泊位平移 1 小时）-> 允许
    const shift = await adjust(A3, 'B-5',
      '2026-11-01T09:00:00+08:00', '2026-11-01T11:00:00+08:00', 'ADJ-201', 201);
    check('新窗口与自身旧窗口重叠（平移）-> 允许', shift.status === 201);
    const B3 = shift.body.booking.bookingId;

    // 首尾相接：另一航次订 B-5 从 11:00 开始（新记录终点）-> 允许
    const touch = await book(r4, 'SIN', 'B-5',
      '2026-11-01T11:00:00+08:00', '2026-11-01T12:00:00+08:00', 'R4-201');
    check('新窗口终点与他人起点首尾相接 -> 允许', touch.status === 201);

    // 链式改期：对新记录再次改期（调整号按新记录隔离）
    const chain = await adjust(B3, 'B-9',
      '2026-11-01T09:00:00+08:00', '2026-11-01T11:00:00+08:00', 'ADJ-202', 201);
    check('链式改期：对新记录再调整成功', chain.status === 201);
    const C3 = chain.body.booking.bookingId;
    check('链式关联：B3 已取消并指向 C3，C3 继承同一审查/卸港/冻结快照',
      chain.body.previousBooking.bookingId === B3 &&
      chain.body.previousBooking.replacedByBookingId === C3 &&
      chain.body.booking.adjustmentOfBookingId === B3 &&
      chain.body.booking.reviewId === r3 &&
      chain.body.booking.dischargePort === 'SIN' &&
      chain.body.booking.frozenManifestRevision === 1 &&
      chain.body.booking.dischargedBoxCount === 2);

    // 改期产生的新记录可取消，取消后新窗口释放（r3 的 SIN 已无有效预订，可再订）
    await http('POST', `${BASE}/berth-bookings/${C3}/cancel`, undefined, 200);
    const freed = await book(r3, 'SIN', 'B-9',
      '2026-11-01T09:30:00+08:00', '2026-11-01T10:00:00+08:00', 'R3-202');
    check('新记录取消后其窗口释放（同审查同港可再订）', freed.status === 201);

    // 新记录被取消后，同调整号重试返回新记录【当前状态】（已取消）
    const replayCancelled = await adjust(B3, 'B-9',
      '2026-11-01T09:00:00+08:00', '2026-11-01T11:00:00+08:00', 'ADJ-202', 200);
    check('同号重试返回新记录当前状态（已取消）',
      replayCancelled.body.replay === true &&
      replayCancelled.body.booking.bookingId === C3 &&
      replayCancelled.body.booking.status === 'cancelled');

    // ================= 9. 并发改期 =================
    const a4 = await book(r4, 'HAM', 'B-4',
      '2026-12-01T08:00:00+08:00', '2026-12-01T10:00:00+08:00', 'SUB-401');
    const A4 = a4.body.bookingId;
    // 同一原预订、不同调整号、不同泊位并发：只有一方成功
    const race = await Promise.all([
      adjust(A4, 'B-41', '2026-12-01T11:00:00+08:00', '2026-12-01T12:00:00+08:00', 'ADJ-A'),
      adjust(A4, 'B-42', '2026-12-01T11:00:00+08:00', '2026-12-01T12:00:00+08:00', 'ADJ-B'),
    ]);
    const raceStatuses = race.map((r) => r.status).sort();
    check('并发改期（不同调整号）：一方 201、一方 409',
      JSON.stringify(raceStatuses) === JSON.stringify([201, 409]),
      JSON.stringify(raceStatuses));
    check('失败方为 booking_not_active',
      race.some((r) => r.status === 409 && r.body.error.code === 'booking_not_active'),
      JSON.stringify(race.map((r) => r.body)));
    const winner = race.find((r) => r.status === 201);
    const getA4 = await http('GET', `${BASE}/berth-bookings/${A4}`, undefined, 200);
    check('并发后原预订只被取代一次（replacedBy 指向胜出新记录）',
      getA4.body.booking.status === 'cancelled' &&
      getA4.body.booking.replacedByBookingId === winner.body.booking.bookingId);

    // 同一原预订、同调整号同内容并发：一方 201、一方 200 replay，同一新记录
    const a5 = await book(r2, 'HAM', 'B-6',
      '2026-12-02T08:00:00+08:00', '2026-12-02T10:00:00+08:00', 'SUB-402');
    const A5 = a5.body.bookingId;
    const raceSame = await Promise.all([
      adjust(A5, 'B-61', '2026-12-02T11:00:00+08:00', '2026-12-02T12:00:00+08:00', 'ADJ-SAME'),
      adjust(A5, 'B-61', '2026-12-02T11:00:00+08:00', '2026-12-02T12:00:00+08:00', 'ADJ-SAME'),
    ]);
    const sameStatuses = raceSame.map((r) => r.status).sort();
    check('并发同号同内容：一方 201、一方 200 replay',
      JSON.stringify(sameStatuses) === JSON.stringify([200, 201]),
      JSON.stringify(sameStatuses));
    const newIds = raceSame.map((r) => r.body.booking.bookingId);
    check('并发同号同内容指向同一新记录', newIds[0] === newIds[1], JSON.stringify(newIds));

    // ================= 10. 冻结不回写：签发新清单后改期记录快照不变 =================
    await http('POST', `${BASE}/voyages/${vid1}/moves`, {
      baseRevision: 1,
      moves: [
        { boxNo: 'BOX-3', position: { bay: 1, row: 1, tier: 1 } },
        { boxNo: 'BOX-4', position: { bay: 1, row: 1, tier: 0 } },
        { boxNo: 'BOX-1', position: { bay: 2, row: 1, tier: 0 } },
        { boxNo: 'BOX-2', position: { bay: 2, row: 1, tier: 1 } },
      ],
    }, 200);
    await http('POST', `${BASE}/voyages/${vid1}/manifests`, { expectedRevision: 2 }, 201);
    const getB2 = await http('GET', `${BASE}/berth-bookings/${B}`, undefined, 200);
    check('签发新清单后改期新记录冻结快照不回写（仍 manifest=1、卸箱数=2）',
      getB2.body.booking.frozenManifestRevision === 1 &&
      getB2.body.booking.dischargedBoxCount === 2);

    console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
    process.exitCode = failed === 0 ? 0 : 1;
  } catch (e) {
    console.error('E2E 异常:', e);
    process.exitCode = 1;
  } finally {
    await new Promise((r) => server.close(r));
    await pool.end();
    await pg.stop();
  }
}

main();
