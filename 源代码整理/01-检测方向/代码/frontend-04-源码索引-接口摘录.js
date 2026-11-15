/* ============================================================================
 * 后端 server.js：POST /api/detect/image（检测接口）与参数化管线接口
 * 出处：C:\Users\17355\.zcode\workspace\default\tunnel-inspection-system\backend\server.js  第 267–310 行（原文照搬，仅加本表头）
 * ========================================================================== */
        tunnel: u.searchParams.get('tunnel') || undefined,
      }));
    }

    const mReview = p.match(/^\/api\/defects\/([^/]+)\/review$/);
    if (mReview && req.method === 'POST') {
      const d = store.getDefect(mReview[1]);
      if (!d) return send(res, 404, { error: '病害记录不存在' });
      const body = await readBody(req);
      if (!body.reviewer || !['通过', '驳回'].includes(body.action)) {
        return send(res, 400, { error: 'review 需包含 reviewer 与 action(通过|驳回)' });
      }
      const changes = Array.isArray(body.changes) ? body.changes : [];
      /* 复核前原始值：供前端「AI初始 vs 复核后最终」对比留痕 */
      const review = {
        reviewer: body.reviewer,
        action: body.action,
        note: body.note || '',
        levelOverride: body.levelOverride || null,
        typeOverride: body.typeOverride || null,
        areaOverride: body.areaOverride != null ? String(body.areaOverride) : null,
        rejectReason: body.rejectReason || null,
        decision: body.decision || (body.action === '通过' ? '按建议方案纳入整治计划' : '退回复检'),
        original: { type: d.type, level: d.level, area: (d.physical && d.physical['面积']) || null },
        changes,
        at: new Date().toISOString(),
      };
      const patch = {
        status: body.action === '通过' ? '已审核' : '已驳回',
        decision: review.decision,
        review,
      };
      /* 人工校正：类型 / 等级 / 面积 改判（未改判则沿用 AI 初始值；改动写入 changes 留痕） */
      patch.type = body.typeOverride && body.typeOverride !== d.type ? body.typeOverride : d.type;
      patch.finalLevel = review.levelOverride || d.level;
      if (review.levelOverride) patch.level = review.levelOverride;
      if (review.areaOverride != null) {
        patch.physical = Object.assign({}, d.physical || {}, { 面积: review.areaOverride });
      }
      /* 复核留痕：追加一条审计日志（含修改前后对比），全部操作可追溯 */
      patch.auditLog = (d.auditLog || []).concat({
        at: review.at,
        reviewer: review.reviewer,
        action: review.action,
