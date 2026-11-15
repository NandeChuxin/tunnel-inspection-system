/* ============================================================================
 * 后端 server.js：GET /api/defects（台账查询）/ POST /api/defects/:id/review（通过·驳回）/ GET /api/defects/:id（单条详情）—— 人工复核的全部写入口
 * 出处：C:\Users\17355\.zcode\workspace\default\tunnel-inspection-system\backend\server.js  第 223–262 行（原文照搬，仅加本表头）
 * ========================================================================== */

    // GET /api/live/frame?streamId=default&after=123：无新帧返回 204。
    if (p === '/api/live/frame' && req.method === 'GET') {
      const streamId = String(u.searchParams.get('streamId') || 'default');
      const frame = liveStreams.get(streamId);
      if (!frame || frame.seq <= Number(u.searchParams.get('after') || 0)) {
        res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
        return res.end();
      }
      res.setHeader('Cache-Control', 'no-store');
      return send(res, 200, frame);
    }

    if (p === '/api/live/status' && req.method === 'GET') {
      return send(res, 200, { streams: Array.from(liveStreams.values()).map((f) => ({
        streamId: f.streamId, seq: f.seq, capturedAt: f.capturedAt, device: f.device,
      })) });
    }

    if (p === '/api/ingest' && req.method === 'POST') {
      const frame = await readBody(req);
      if (!frame.image || !Array.isArray(frame.image.rois)) {
        return send(res, 400, { error: '数据包缺少 image.rois 字段' });
      }
      return send(res, 200, ingestFrame(frame));
    }

    if (p === '/api/simulate' && req.method === 'POST') {
      const opt = await readBody(req);
      return send(res, 200, ingestFrame(simulator.makeFrame(opt)));
    }

    if (p === '/api/import/video' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.url) return send(res, 400, { error: '请提供视频链接或 BV 号' });
      const out = await importOnlineVideo(String(body.url));
      return send(res, 200, out);
    }

    if (p === '/api/defects' && req.method === 'GET') {
