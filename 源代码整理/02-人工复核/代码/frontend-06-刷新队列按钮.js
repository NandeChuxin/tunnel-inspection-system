/* ============================================================================
 * 「刷新队列」按钮：翻页轮换 + 「刷新中…」最小可见反馈 + 播报
 * 出处：C:\Users\17355\.zcode\workspace\default\tunnel-inspection-system\docs\prototype-holo-core.html  第 5060–5090 行（原文照搬，仅加本表头）
 * ========================================================================== */
      return [];
    }).then(function (dets) { busy = false; return dets; });
  }
  function loadPhotoFile(file) {
    var url = URL.createObjectURL(file);
    var img = new Image();
    img.onload = function () {
      URL.revokeObjectURL(url);
      var c = document.createElement('canvas');
      var sc = Math.min(1, 640 / img.naturalWidth);
      c.width = Math.round(img.naturalWidth * sc);
      c.height = Math.round(img.naturalHeight * sc);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      var png = c.toDataURL('image/png');
      drawMini(img, []);
      detectPng(png).then(function (dets) { drawMini(img, dets); });
    };
    img.onerror = function () { URL.revokeObjectURL(url); renderRes([], 0, '图片解码失败：' + file.name); };
    img.src = url;
  }
  function startVideoFile(file) {
    stopVideoCard();
    if (!vEl) { vEl = document.createElement('video'); vEl.muted = true; vEl.playsInline = true; }
    if (vEl._url) URL.revokeObjectURL(vEl._url);
    vEl._url = URL.createObjectURL(file);
    vEl.src = vEl._url;
    vEl.loop = true;
    vFrames = 0; vHits = 0;
    var go = function () {
      vTimer = setInterval(sampleVideo, 900);
      sampleVideo();
