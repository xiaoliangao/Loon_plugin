/*
微博超话 Cookie/gsid 获取脚本（Loon）
1) 开启 MITM：api.weibo.cn
2) 配置 [Script] http-request 触发本脚本
3) 打开微博 App -> 我的 -> 我的超话（关注超话列表页）
*/

const $ = new Env('微博超话Cookie');

(function () {
  if (typeof $request === 'undefined') return $done({}); // 防止手动运行报错

  const url = $request.url || '';
  if (!/api\.weibo\.cn/.test(url)) return $done({});

  const headers = $request.headers || {};
  const cookie = headers['Cookie'] || headers['cookie'] || '';

  const gsid = url.match(/(?:\?|&)gsid=([^&]+)/)?.[1] || '';
  const uid  = url.match(/(?:\?|&)uid=(\d+)/)?.[1] || '';

  if (!gsid) {
    $.msg('微博超话Cookie', '⚠️ 未获取到 gsid', '请进入“我的超话”列表页再试');
    return $done({});
  }

  const weiboData = {
    cookie,          // 可能为空
    gsid,
    uid,
    updateTime: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
  };

  $.setdata(JSON.stringify(weiboData), 'weibo_topic_data');
  $.msg('微博超话Cookie', '✅ 获取成功', `UID: ${uid || '未知'}\n更新时间: ${weiboData.updateTime}`);

  return $done({}); // 关键：放行请求
})();

function Env(name) {
  return new (class {
    constructor(name) { this.name = name; console.log(`🔔 ${this.name}, 开始!`); }
    getdata(k) { return $persistentStore.read(k); }
    setdata(v, k) { return $persistentStore.write(v, k); }
    msg(t, s, b) { $notification.post(t, s, b); }
  })(name);
}
