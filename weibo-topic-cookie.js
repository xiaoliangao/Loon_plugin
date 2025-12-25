const $ = new Env('微博超话Cookie');

(function () {
  if (typeof $request === 'undefined') return $done({});

  const url = $request.url || '';
  if (!/api\.weibo\.cn/.test(url)) return $done({});

  // 调试时可打开：用于确认到底命中了什么请求
  // console.log('[Weibo HIT] ' + url);

  const headers = $request.headers || {};
  const cookie = headers['Cookie'] || headers['cookie'] || '';

  const gsid = url.match(/(?:\?|&)gsid=([^&]+)/)?.[1] || '';
  const uid  = url.match(/(?:\?|&)uid=(\d+)/)?.[1] || '';

  if (!gsid) {
    $.msg('微博超话Cookie', '⚠️ 命中但无 gsid', '请换入口再试（建议：我→我的超话）');
    return $done({});
  }

  $.setdata(JSON.stringify({
    cookie, // 可能为空，正常
    gsid,
    uid,
    updateTime: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
  }), 'weibo_topic_data');

  $.msg('微博超话Cookie', '✅ 获取成功', `UID: ${uid || '未知'}\n已保存 gsid`);
  return $done({}); // 放行请求（关键）
})();

function Env(name) {
  return new (class {
    getdata(k) { return $persistentStore.read(k); }
    setdata(v, k) { return $persistentStore.write(v, k); }
    msg(t, s, b) { $notification.post(t, s, b); }
  })(name);
}
