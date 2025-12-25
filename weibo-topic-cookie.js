const $ = new Env('微博超话参数抓取');
const KEY = 'weibo_topic_data';

// 简单通知节流：同类通知 5 分钟最多一次
function shouldNotify(flagKey) {
  const k = `weibo_topic_notify_${flagKey}`;
  const last = parseInt($.getdata(k) || '0', 10);
  const now = Date.now();
  if (now - last > 5 * 60 * 1000) {
    $.setdata(String(now), k);
    return true;
  }
  return false;
}

(function () {
  if (typeof $request === 'undefined') return $done({});

  const url = $request.url || '';
  if (!/api\.weibo\.cn/.test(url)) return $done({});

  const headers = $request.headers || {};
  const ua = headers['User-Agent'] || headers['user-agent'] || '';
  const reqCookie = headers['Cookie'] || headers['cookie'] || '';
  const gsid = url.match(/(?:\?|&)gsid=([^&]+)/)?.[1] || '';
  const uid  = url.match(/(?:\?|&)uid=(\d+)/)?.[1] || '';

  let data = {};
  try { data = JSON.parse($.getdata(KEY) || '{}'); } catch (_) { data = {}; }

  let changed = false;
  let notifyLines = [];

  // 合并写入（缺失不覆盖）
  if (ua && data.ua !== ua) { data.ua = ua; changed = true; }
  if (reqCookie && data.cookie !== reqCookie) { data.cookie = reqCookie; changed = true; }
  if (gsid && data.gsid !== gsid) { data.gsid = gsid; changed = true; }
  if (uid && data.uid !== uid) { data.uid = uid; changed = true; }

  // ① 捕获“关注超话列表” cardlist 链接（保留完整 URL，避免丢签名参数）
  const isFollowList = /\/2\/cardlist\?/.test(url) && /containerid=100803_-_followsuper/.test(url);
  if (isFollowList && data.cardlist_url !== url) {
    data.cardlist_url = url;
    changed = true;
    if (shouldNotify('cardlist')) notifyLines.push('✅ 已捕获关注超话列表参数（cardlist）');
  }

  // ② 捕获“签到按钮” page/button 链接 + body 模板
  const isButton = /\/2\/page\/button\?/.test(url);
  if (isButton) {
    if (data.button_url !== url) {
      data.button_url = url;
      changed = true;
      if (shouldNotify('button')) notifyLines.push('✅ 已捕获签到接口参数（page/button）');
    }

    const body = ($request.body || '').trim();
    if (body) {
      // 将 body 中 containerid=xxxxx 替换为占位符
      const tpl = body.replace(/(^|&)containerid=\d+/, '$1containerid={containerid}');
      if (data.button_body_tpl !== tpl) {
        data.button_body_tpl = tpl;
        changed = true;
      }
    }
  }

  if (changed) {
    data.updateTime = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    $.setdata(JSON.stringify(data), KEY);
  }

  if (notifyLines.length) {
    $.msg('微博超话参数抓取', '已更新', `${notifyLines.join('\n')}\nUID: ${data.uid || '未捕获'}\n${data.updateTime || ''}`);
  }

  return $done({});
})();

function Env(name) {
  return new (class {
    getdata(k) { return $persistentStore.read(k); }
    setdata(v, k) { return $persistentStore.write(v, k); }
    msg(t, s, b) { $notification.post(t, s, b); }
  })(name);
}
