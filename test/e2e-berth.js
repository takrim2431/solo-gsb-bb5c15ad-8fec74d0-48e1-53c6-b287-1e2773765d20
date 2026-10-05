/* eslint-disable no-console */
// 靠泊窗口预订 端到端验证：embedded-postgres + 真实 Express HTTP
// 运行: npm run build && node test/e2e-berth.js
const path = require('path');
process.env.SCHEMA_PATH = path.join(__dirname, '..', 'src', 'schema.sql');
const EmbeddedPostgres = require('embedded-postgres').default;

const PORT = 30198;
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

/** 登记航次 + 配载 + 签发 rev1，并返回 { vid, reviewUrl }（清单 4 箱） */
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

async function createReview(vid, items) {
  const { body } = await http('POST', `${BASE}/voyages/${vid}/manifests/1/discharge-reviews`, {
    ports: ['SHA', 'SIN', 'HAM'],
    items,
  }, 201);
  return body.reviewId;
}

async function main() {
  const pg = new EmbeddedPostgres({
    databaseDir: path.join('/tmp', 'pgdata-e2e-berth'),
    user: 'stowage',
    password: 'stowage',
    port: 54398,
    persistent: false,
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('stowage');

  const { createPool, waitForDatabase, initSchema } = require('../dist/src/db');
  const { createApp } = require('../dist/src/app');
  const pool = createPool({
    databaseUrl: 'postgres://stowage:stowage@127.0.0.1:54398/stowage',
    schemaPath: process.env.SCHEMA_PATH,
  });
  await waitForDatabase(pool, 30);
  await initSchema(pool, { schemaPath: process.env.SCHEMA_PATH });
  const server = await new Promise((resolve) => {
    const s = createApp(pool).listen(PORT, '127.0.0.1', () => resolve(s));
  });

  try {
    // ---- 准备：两条航次，各自签发清单并做审查 ----
    const vid = await setupVoyage('V-E2E-BERTH-001');
    // 可行审查：列顶 BOX-3=SHA，BOX-1/2=SIN 连锁，BOX-4=HAM（每港都有实际卸箱、无受阻）
    const goodItems = [
      { boxNo: 'BOX-1', dischargePort: 'SIN' },
      { boxNo: 'BOX-2', dischargePort: 'SIN' },
      { boxNo: 'BOX-3', dischargePort: 'SHA' },
      { boxNo: 'BOX-4', dischargePort: 'HAM' },
    ];
    const reviewId = await createReview(vid, goodItems);
    const bookUrl = `${BASE}/discharge-reviews/${reviewId}/berth-bookings`;

    // 第二个航次（不同航次/不同审查），用于验证“跨航次同港同泊位也不得重叠”
    const vid2 = await setupVoyage('V-E2E-BERTH-002');
    const reviewId2 = await createReview(vid2, goodItems);
    const bookUrl2 = `${BASE}/discharge-reviews/${reviewId2}/berth-bookings`;

    // 第三个航次/审查：用于制造“来自不同航次”的重叠/并发竞争
    const vid3 = await setupVoyage('V-E2E-BERTH-003');
    const reviewId3 = await createReview(vid3, goodItems);
    const bookUrl3 = `${BASE}/discharge-reviews/${reviewId3}/berth-bookings`;

    // 第四个航次/审查：专用于取消/释放占用场景
    const vid4 = await setupVoyage('V-E2E-BERTH-004');
    const reviewId4 = await createReview(vid4, goodItems);
    const bookUrl4 = `${BASE}/discharge-reviews/${reviewId4}/berth-bookings`;

    // 不可行审查：BOX-1(SHA) 被压，SHA 无实际卸箱且有受阻
    const badId = await createReview(vid, [
      { boxNo: 'BOX-1', dischargePort: 'SHA' },
      { boxNo: 'BOX-2', dischargePort: 'SIN' },
      { boxNo: 'BOX-3', dischargePort: 'HAM' },
      { boxNo: 'BOX-4', dischargePort: 'SHA' },
    ]);
    // bad 审查：SHA 实卸 BOX-4（另一列列顶）、BOX-1 受阻；SIN 受阻无实卸；HAM 实卸 BOX-3

    // ---- 1. 首次预订成功，冻结修订号与该港卸箱数 ----
    const b1 = await http('POST', bookUrl, {
      reviewId,
      dischargePort: 'SIN',
      berth: 'B-7',
      startAt: '2026-10-10T08:00:00+08:00',
      endAt: '2026-10-10T12:00:00+08:00',
      submissionNo: 'SUB-001',
    }, 201);
    check('首次预订 201 replay=false', b1.body.replay === false && !!b1.body.bookingId);
    check('冻结清单修订号=1', b1.body.frozenManifestRevision === 1);
    check('冻结该港实际卸箱数=2（BOX-1、BOX-2）', b1.body.dischargedBoxCount === 2);
    check('status=booked/open=true', b1.body.status === 'booked' && b1.body.open === true);
    check('时刻按绝对时刻回显（UTC ISO）',
      b1.body.startAt === '2026-10-10T00:00:00.000Z' && b1.body.endAt === '2026-10-10T04:00:00.000Z',
      JSON.stringify({ s: b1.body.startAt, e: b1.body.endAt }));

    // ---- 2. 同号同内容重试 -> 200 replay，返回原预订当前状态 ----
    const replay = await http('POST', bookUrl, {
      reviewId, dischargePort: 'SIN', berth: 'B-7',
      // 用不同时区写法指向同一绝对时刻，仍应视为同内容
      startAt: '2026-10-10T00:00:00Z',
      endAt: '2026-10-10T12:00:00+08:00',
      submissionNo: 'SUB-001',
    }, 200);
    check('同号同内容（等效时区）replay=true 同一 bookingId',
      replay.body.replay === true && replay.body.bookingId === b1.body.bookingId,
      JSON.stringify(replay.body));

    // ---- 3. 同号改内容 -> 409 booking_submission_conflict ----
    const conflict = await http('POST', bookUrl, {
      reviewId, dischargePort: 'SIN', berth: 'B-8',
      startAt: '2026-10-10T08:00:00+08:00',
      endAt: '2026-10-10T12:00:00+08:00',
      submissionNo: 'SUB-001',
    });
    check('同号改泊位 -> 409 booking_submission_conflict',
      conflict.status === 409 && conflict.body.error.code === 'booking_submission_conflict');

    // ---- 4. 同一审查同一卸港第二个有效预订（不同泊位/新提交号）-> 409 ----
    const samePort = await http('POST', bookUrl, {
      reviewId, dischargePort: 'SIN', berth: 'B-9',
      startAt: '2026-10-11T08:00:00+08:00',
      endAt: '2026-10-11T12:00:00+08:00',
      submissionNo: 'SUB-002',
    });
    check('同审查同卸港重复预订 -> 409 booking_exists_for_port',
      samePort.status === 409 && samePort.body.error.code === 'booking_exists_for_port');

    // 但同审查的另一卸港（HAM，另一泊位、不冲突时段）可以预订
    const ham = await http('POST', bookUrl, {
      reviewId, dischargePort: 'HAM', berth: 'B-2',
      startAt: '2026-10-10T08:00:00+08:00',
      endAt: '2026-10-10T12:00:00+08:00',
      submissionNo: 'SUB-003',
    }, 201);
    check('同审查另一卸港可预订，HAM 卸箱数=1',
      ham.body.dischargedBoxCount === 1 && ham.body.status === 'booked');

    // ---- 5. 同港同泊位窗口重叠（不同泊位名不互斥；首尾相接允许）----
    // B-7 已占 [10-10 08:00, 12:00 +08)
    const touch = await http('POST', bookUrl2, {
      reviewId: reviewId2, dischargePort: 'SIN', berth: 'B-7',
      startAt: '2026-10-10T12:00:00+08:00', // 正好首尾相接
      endAt: '2026-10-10T14:00:00+08:00',
      submissionNo: 'XA-1',
    }, 201);
    check('首尾相接允许（即使来自不同航次）', touch.status === 201);

    // ---- 6. 跨航次：同港同泊位重叠 -> 409 berth_window_overlap ----
    // 用第三个航次的新审查（其 SIN 尚无预订），直接撞 vid 的 B-7 窗口
    const overlap = await http('POST', bookUrl3, {
      reviewId: reviewId3, dischargePort: 'SIN', berth: 'B-7',
      startAt: '2026-10-10T11:59:00+08:00',
      endAt: '2026-10-10T13:00:00+08:00',
      submissionNo: 'XA-2',
    });
    check('跨航次同港同泊位重叠 -> 409 berth_window_overlap（含冲突方）',
      overlap.status === 409 && overlap.body.error.code === 'berth_window_overlap' &&
      !!overlap.body.error.details.conflicting,
      JSON.stringify(overlap.body));

    // 不同泊位即便完全同时段也不冲突
    const otherBerth = await http('POST', bookUrl3, {
      reviewId: reviewId3, dischargePort: 'SIN', berth: 'B-77',
      startAt: '2026-10-10T09:00:00+08:00',
      endAt: '2026-10-10T10:00:00+08:00',
      submissionNo: 'XA-3',
    }, 201);
    check('不同泊位同时段不互斥', otherBerth.status === 201);

    // ---- 7. 并发竞争同港同泊位重叠窗口：只成功一方 ----
    // 两笔来自【不同审查/不同航次】（绕开“同审查同港一个有效”，直接竞争全局窗口排他约束），
    // 时间完全相同，并发提交。
    const mkConcurrent = (url, rid, sub) =>
      http('POST', url, {
        reviewId: rid, dischargePort: 'HAM', berth: 'B-5',
        startAt: '2026-11-01T08:00:00+08:00',
        endAt: '2026-11-01T10:00:00+08:00',
        submissionNo: sub,
      });
    const rs = await Promise.all([
      mkConcurrent(bookUrl2, reviewId2, 'C-1'),
      mkConcurrent(bookUrl3, reviewId3, 'C-2'),
    ]);
    const statuses = rs.map((r) => r.status).sort();
    check('并发竞争：一方 201、一方 409',
      JSON.stringify(statuses) === JSON.stringify([201, 409]),
      JSON.stringify(statuses));
    check('失败方为 berth_window_overlap',
      rs.some((r) => r.status === 409 && r.body.error.code === 'berth_window_overlap'));

    // ---- 8. 受理条件：该港无实际卸箱或有受阻箱 -> 422 port_not_dischargeable ----
    const sinBlocked = await http('POST', `${BASE}/discharge-reviews/${badId}/berth-bookings`, {
      reviewId: badId, dischargePort: 'SIN', berth: 'B-1',
      startAt: '2026-12-01T08:00:00Z', endAt: '2026-12-01T09:00:00Z',
      submissionNo: 'BAD-1',
    });
    check('SIN 无实卸且有受阻 -> 422 port_not_dischargeable',
      sinBlocked.status === 422 && sinBlocked.body.error.code === 'port_not_dischargeable' &&
      sinBlocked.body.error.details.dischargedBoxCount === 0 &&
      sinBlocked.body.error.details.blockedBoxCount === 1,
      JSON.stringify(sinBlocked.body));

    // bad 审查 SHA：实卸 BOX-4=1 但受阻 BOX-1=1 -> 仍不受理
    const shaMixed = await http('POST', `${BASE}/discharge-reviews/${badId}/berth-bookings`, {
      reviewId: badId, dischargePort: 'SHA', berth: 'B-1',
      startAt: '2026-12-01T08:00:00Z', endAt: '2026-12-01T09:00:00Z',
      submissionNo: 'BAD-2',
    });
    check('SHA 既有实卸又有受阻 -> 422（blocked=1）',
      shaMixed.status === 422 && shaMixed.body.error.details.blockedBoxCount === 1);

    // ---- 9. 非法时刻 -> 400 invalid_time_window ----
    const noTz = await http('POST', bookUrl, {
      reviewId, dischargePort: 'HAM', berth: 'B-3',
      startAt: '2026-10-20T08:00:00', endAt: '2026-10-20T09:00:00',
      submissionNo: 'T-1',
    });
    check('无时区时刻 -> 400 invalid_time_window(unparsable_time)',
      noTz.status === 400 && noTz.body.error.code === 'invalid_time_window' &&
      noTz.body.error.details.issues.some((i) => i.reason === 'unparsable_time'));

    const badOrder = await http('POST', bookUrl, {
      reviewId, dischargePort: 'HAM', berth: 'B-3',
      startAt: '2026-10-20T09:00:00Z', endAt: '2026-10-20T08:00:00Z',
      submissionNo: 'T-2',
    });
    check('起点晚于终点 -> 400 start_not_before_end',
      badOrder.status === 400 &&
      badOrder.body.error.details.issues.some((i) => i.reason === 'start_not_before_end'));

    const equal = await http('POST', bookUrl, {
      reviewId, dischargePort: 'HAM', berth: 'B-3',
      startAt: '2026-10-20T08:00:00Z', endAt: '2026-10-20T08:00:00Z',
      submissionNo: 'T-3',
    });
    check('起点等于终点 -> 400', equal.status === 400);

    // ---- 10. 未知审查 / 未知卸港 ----
    const zero = '00000000-0000-0000-0000-000000000000';
    const noReview = await http('POST', `${BASE}/discharge-reviews/${zero}/berth-bookings`, {
      reviewId: zero, dischargePort: 'SIN', berth: 'B-1',
      startAt: '2026-10-20T08:00:00Z', endAt: '2026-10-20T09:00:00Z',
      submissionNo: 'X',
    });
    check('未知审查 -> 404 discharge_review_not_found',
      noReview.status === 404 && noReview.body.error.code === 'discharge_review_not_found');

    const unknownPort = await http('POST', bookUrl, {
      reviewId, dischargePort: 'XXX', berth: 'B-3',
      startAt: '2026-10-20T08:00:00Z', endAt: '2026-10-20T09:00:00Z',
      submissionNo: 'T-4',
    });
    check('审查内不存在的卸港 -> 400 unknown_discharge_port_for_review',
      unknownPort.status === 400 &&
      unknownPort.body.error.code === 'unknown_discharge_port_for_review');

    const badReviewId = await http('POST', `${BASE}/discharge-reviews/not-a-uuid/berth-bookings`, {
      reviewId: 'not-a-uuid', dischargePort: 'SIN', berth: 'B-1',
      startAt: '2026-10-20T08:00:00Z', endAt: '2026-10-20T09:00:00Z',
      submissionNo: 'X',
    });
    check('非法审查 ID -> 400 invalid_discharge_review_id',
      badReviewId.status === 400 && badReviewId.body.error.code === 'invalid_discharge_review_id');

    // ---- 11. 查询：按审查 / 按航次 / 单条 ----
    const listReview = await http('GET', bookUrl, undefined, 200);
    check('按审查列出预订（SIN+HAM 共 2 条）',
      listReview.body.bookings.length === 2 &&
      listReview.body.bookings.every((b) => b.reviewId === reviewId),
      JSON.stringify(listReview.body.bookings.map((b) => b.dischargePort)));

    const listVoyage = await http('GET', `${BASE}/voyages/${vid}/berth-bookings`, undefined, 200);
    check('按航次列出预订（含 bad 审查？bad 未成功预订，故 2 条）',
      listVoyage.body.bookings.length === 2,
      JSON.stringify(listVoyage.body.bookings.length));

    const one = await http('GET', `${BASE}/berth-bookings/${b1.body.bookingId}`, undefined, 200);
    check('单条查询返回预订', one.body.booking.bookingId === b1.body.bookingId);

    const noBooking = await http('GET', `${BASE}/berth-bookings/${zero}`, undefined);
    check('未知预订 -> 404 berth_booking_not_found',
      noBooking.status === 404 && noBooking.body.error.code === 'berth_booking_not_found');

    // ---- 12. 取消：释放占用；重复取消幂等；重新预订须新提交号 ----
    // vid 的 ham 预订占着 HAM B-2（10-10 08-12 +08）。用全新审查 review4 撞同时段验证占用，
    // 再取消 vid 的 ham，随后 review4 同时段应可订。
    const before = await http('POST', bookUrl4, {
      reviewId: reviewId4, dischargePort: 'HAM', berth: 'B-2',
      startAt: '2026-10-10T09:00:00+08:00', endAt: '2026-10-10T10:00:00+08:00',
      submissionNo: 'K-1',
    });
    check('取消前：B-2 重叠被拒 409',
      before.status === 409 && before.body.error.code === 'berth_window_overlap');

    const cancel = await http('POST', `${BASE}/berth-bookings/${ham.body.bookingId}/cancel`, undefined, 200);
    check('取消成功 status=cancelled 且记录 cancelledAt',
      cancel.body.booking.status === 'cancelled' && !!cancel.body.booking.cancelledAt &&
      cancel.body.replay === false);

    const cancelAgain = await http('POST', `${BASE}/berth-bookings/${ham.body.bookingId}/cancel`, undefined, 200);
    check('重复取消幂等 replay=true 返回已取消状态',
      cancelAgain.body.replay === true && cancelAgain.body.booking.status === 'cancelled');

    // 取消后占用释放：另一审查（不同航次）同港同泊位同时段可订
    const after = await http('POST', bookUrl4, {
      reviewId: reviewId4, dischargePort: 'HAM', berth: 'B-2',
      startAt: '2026-10-10T09:00:00+08:00', endAt: '2026-10-10T10:00:00+08:00',
      submissionNo: 'K-2',
    }, 201);
    check('取消后同港同泊位同时段（不同航次）可订', after.status === 201);

    // 同一审查同一卸港取消后可重新预订，但必须用新提交号（用不与 review4 K-2 冲突的时段）
    const rebookOldNo = await http('POST', bookUrl, {
      reviewId, dischargePort: 'HAM', berth: 'B-2',
      startAt: '2026-10-10T14:00:00+08:00', endAt: '2026-10-10T15:00:00+08:00',
      submissionNo: 'SUB-003', // 已用过的提交号
    });
    check('重新预订复用旧提交号 -> 409（同号内容不同）',
      rebookOldNo.status === 409 && rebookOldNo.body.error.code === 'booking_submission_conflict');

    const rebook = await http('POST', bookUrl, {
      reviewId, dischargePort: 'HAM', berth: 'B-2',
      startAt: '2026-10-10T14:00:00+08:00', endAt: '2026-10-10T15:00:00+08:00',
      submissionNo: 'SUB-004',
    }, 201);
    check('取消后同审查同卸港用新提交号重新预订成功', rebook.status === 201);

    // ---- 13. 已取消预订的同号同内容重试返回【已取消】当前状态 ----
    const replayCancelled = await http('POST', bookUrl, {
      reviewId, dischargePort: 'HAM', berth: 'B-2',
      startAt: '2026-10-10T08:00:00+08:00',
      endAt: '2026-10-10T12:00:00+08:00',
      submissionNo: 'SUB-003',
    }, 200);
    check('旧提交号同内容重放返回已取消的原预订状态',
      replayCancelled.body.replay === true && replayCancelled.body.status === 'cancelled' &&
      replayCancelled.body.bookingId === ham.body.bookingId);

    // ---- 14. 冻结不回写：推进航次并签发新清单后，预订快照不变 ----
    // rev2：交换布局后签发新清单
    await http('POST', `${BASE}/voyages/${vid}/moves`, {
      baseRevision: 1,
      moves: [
        { boxNo: 'BOX-3', position: { bay: 1, row: 1, tier: 1 } },
        { boxNo: 'BOX-4', position: { bay: 1, row: 1, tier: 0 } },
        { boxNo: 'BOX-1', position: { bay: 2, row: 1, tier: 0 } },
        { boxNo: 'BOX-2', position: { bay: 2, row: 1, tier: 1 } },
      ],
    }, 200);
    await http('POST', `${BASE}/voyages/${vid}/manifests`, { expectedRevision: 2 }, 201);
    const frozenOne = await http('GET', `${BASE}/berth-bookings/${b1.body.bookingId}`, undefined, 200);
    check('签发新清单后预订冻结快照不回写（仍 manifest=1、卸箱数=2）',
      frozenOne.body.booking.frozenManifestRevision === 1 &&
      frozenOne.body.booking.dischargedBoxCount === 2);

    // ---- 15. 列表含已取消记录（记录保留）----
    const listWithCancelled = await http('GET', bookUrl, undefined, 200);
    const statusesAll = listWithCancelled.body.bookings.map((x) => x.status).sort();
    check('按审查查询保留已取消记录（booked/cancelled 都在）',
      listWithCancelled.body.bookings.length === 3 &&
      statusesAll[0] === 'booked' && statusesAll[2] === 'cancelled',
      JSON.stringify(statusesAll));

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
