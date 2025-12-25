const $ = new Env('微博超话Cookie');
const KEY = 'weibo_topic_data';

(function () {
  if (typeof $request === 'undefined') return $done({});

  const url = $request.url || '';
  if (!/api\.weibo\.cn/.test(url)) return $done({});

  const headers = $request.headers || {};
  let cookie = headers['Cookie'] || headers['cookie'] || '';
  let gsid = url.match(/(?:\?|&)gsid=([^&]+)/)?.[1] || '';
  let uid  = url.match(/(?:\?|&)uid=(\d+)/)?.[1] || '';

  // 读取旧数据，避免“抓到不完整参数就覆盖掉”
  let old = null;
  try { old = JSON.parse($.getdata(KEY) || 'null'); } catch (_) {}

  if (!cookie && old?.cookie) cookie = old.cookie;
  if (!uid && old?.uid) uid = old.uid;

  if (!gsid) return $done({});              // 没 gsid 没意义
  if (!uid) return $done({});               // 没 uid 先别通知（等你打开能带 uid 的页面）

  const next = {
    cookie,
    gsid,
    uid,
    updateTime: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
  };

  const unchanged =
    old && old.gsid === next.gsid && old.uid === next.uid && (old.cookie || '') === (next.cookie || '');

  if (!unchanged) {
    $.setdata(JSON.stringify(next), KEY);
    $.msg('微博超话Cookie', '✅ 已更新', `UID: ${uid}\n更新时间: ${next.updateTime}`);
  }

  return $done({}); // 放行请求
})();

function Env(name) {
  return new (class {
    getdata(k) { return $persistentStore.read(k); }
    setdata(v, k) { return $persistentStore.write(v, k); }
    msg(t, s, b) { $notification.post(t, s, b); }
  })(name);
}
