const $ = new Env('微博超话参数抓取');
const KEY = 'weibo_topic_data';

(function () {
  if (typeof $request === 'undefined') return $done({});

  const url = $request.url || '';
  if (!/weibo\.(cn|com)/.test(url)) return $done({});

  const headers = $request.headers || {};
  const ua = headers['User-Agent'] || headers['user-agent'] || '';
  const reqCookie = headers['Cookie'] || headers['cookie'] || '';
  const gsid = url.match(/(?:\?|&)gsid=([^&]+)/)?.[1] || '';
  const uid  = url.match(/(?:\?|&)uid=(\d+)/)?.[1] || '';

  let data = {};
  try { data = JSON.parse($.getdata(KEY) || '{}'); } catch (_) {}

  let notify = [];

  // 合并写入：空值不覆盖旧值
  if (ua) data.ua = ua;
  if (reqCookie) data.cookie = reqCookie;
  if (gsid) data.gsid = gsid;
  if (uid) data.uid = uid;

  // ① 关注列表（保存完整 URL）
  const isFollowList =
    /\/2\/(cardlist|page)\?/.test(url) && /containerid=100803_-_followsuper/.test(url);
  if (isFollowList && data.cardlist_url !== url) {
    data.cardlist_url = url;
    notify.push('✅ 已捕获关注列表 cardlist_url');
  }

  // ② 签到按钮（保存 URL + body 模板）
  const isButton = /\/2\/page\/button\?/.test(url);
  if (isButton && data.button_url !== url) {
    data.button_url = url;
    notify.push('✅ 已捕获签到 button_url');
  }

  if (isButton) {
    const body = ($request.body || '').trim();
    if (body) {
      // 把 body 里的 containerid=123 替换为 containerid={containerid}
      const tpl = body.replace(/(^|&)containerid=\d+/, '$1containerid={containerid}');
      if (data.button_body_tpl !== tpl) {
        data.button_body_tpl = tpl;
        notify.push('✅ 已捕获签到 button_body_tpl');
      }
    }
  }

  data.updateTime = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  $.setdata(JSON.stringify(data), KEY);

  // 只在新增关键字段时通知，避免刷屏
  if (notify.length) {
    $.msg('微博超话参数抓取', '已更新', `${notify.join('\n')}\nUID: ${data.uid || '未捕获'}`);
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
