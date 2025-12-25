const $ = new Env('微博超话参数抓取');
const KEY = 'weibo_topic_data';

(function () {
  if (typeof $request === 'undefined') return $done({});

  const urlStr = $request.url || '';
  if (!/weibo\.(cn|com)/.test(urlStr)) return $done({});

  const headers = $request.headers || {};
  const ua = headers['User-Agent'] || headers['user-agent'] || '';
  const reqCookie = headers['Cookie'] || headers['cookie'] || '';

  const gsid = urlStr.match(/(?:\?|&)gsid=([^&]+)/)?.[1] || '';
  const uid  = urlStr.match(/(?:\?|&)uid=(\d+)/)?.[1] || '';

  let data = {};
  try { data = JSON.parse($.getdata(KEY) || '{}'); } catch (_) { data = {}; }

  let notify = [];

  // 合并写入：空值不覆盖旧值
  if (ua) data.ua = ua;
  if (reqCookie) data.cookie = reqCookie;
  if (gsid) data.gsid = gsid;
  if (uid) data.uid = uid;

  // ① 捕获关注列表：我的超话（关注列表）
  const isFollowList =
    /\/2\/(cardlist|page)\?/.test(urlStr) &&
    /containerid=100803_-_followsuper/.test(urlStr);

  if (isFollowList && data.cardlist_url !== urlStr) {
    data.cardlist_url = urlStr;
    notify.push('✅ 已捕获关注列表 cardlist_url');
  }

  // ② 捕获签到按钮：/2/page/button
  const isButton = /\/2\/page\/button\?/.test(urlStr);
  if (isButton) {
    data.button_url = urlStr; // 留个原始样本方便你排查
    data.button_method = ($request.method || 'GET').toUpperCase();

    // 生成可复用的 URL 模板：button_url_tpl
    try {
      const u = new URL(urlStr);

      // 去掉极易变化且对功能没帮助的字段（保留也行，但会频繁变化导致你以为没抓到）
      const dropKeys = new Set(['ul_sid', 'ul_hid', 'ul_ctime', 'lcardid']);
      for (const k of dropKeys) u.searchParams.delete(k);

      // fid 通常形如 100808<pageid>_-_recommend，把它变成占位符
      if (u.searchParams.has('fid')) u.searchParams.set('fid', '{fid}');

      // request_url 里包含 active_checkin&pageid=xxxx，把 pageid 替换成占位符
      const ru = u.searchParams.get('request_url');
      if (ru) {
        const decoded = decodeURIComponent(ru);
        const patched = decoded.replace(/([?&])pageid=[^&]+/i, '$1pageid={pageid}');
        u.searchParams.set('request_url', encodeURIComponent(patched));
      }

      const tpl = u.toString();
      if (data.button_url_tpl !== tpl) {
        data.button_url_tpl = tpl;
        notify.push('✅ 已捕获签到模板 button_url_tpl');
      }
    } catch (_) {
      // URL 解析失败就不生成模板，保留原始 button_url
    }
  }

  data.updateTime = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  $.setdata(JSON.stringify(data), KEY);

  // 只在新增关键字段时通知，避免刷屏
  if (notify.length) {
    $.msg('微博超话参数抓取', '已更新', `${notify.join('\n')}\nUID: ${data.uid || '未捕获'}\n${data.updateTime}`);
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
