/*
微博超话参数抓取（修复版）
用途：抓取关注列表 URL 和签到所需的完整参数（URL + Body）
*/

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
  const uid = urlStr.match(/(?:\?|&)uid=(\d+)/)?.[1] || '';
  
  // 读取已有数据
  let data = {};
  try { 
    data = JSON.parse($.getdata(KEY) || '{}'); 
  } catch (_) { 
    data = {}; 
  }
  
  let notify = [];
  
  // 合并基础信息（空值不覆盖旧值）
  if (ua) data.ua = ua;
  if (reqCookie) data.cookie = reqCookie;
  if (gsid) data.gsid = gsid;
  if (uid) data.uid = uid;
  
  // ① 捕获关注列表 URL：我的超话（关注列表）
  const isFollowList = 
    /\/2\/(cardlist|page)\?/.test(urlStr) && 
    /containerid=100803_-_followsuper/.test(urlStr);
  
  if (isFollowList && data.cardlist_url !== urlStr) {
    data.cardlist_url = urlStr;
    notify.push('✅ 已捕获关注列表参数');
    console.log('[关注列表] URL:', urlStr);
  }
  
  // ② 捕获签到参数：/2/page/button
  const isButton = /\/2\/page\/button\?/.test(urlStr);
  
  if (isButton) {
    const method = ($request.method || 'GET').toUpperCase();
    const body = $request.body || '';
    
    // 保存完整 URL（不做模板化，避免复杂度）
    if (data.button_url !== urlStr) {
      data.button_url = urlStr;
      notify.push('✅ 已捕获签到 URL');
      console.log('[签到按钮] URL:', urlStr);
    }
    
    // 保存 POST body（关键！）
    if (method === 'POST' && body) {
      // 将 body 转为模板：提取 containerid 并替换为占位符
      let bodyTemplate = body;
      const containeridMatch = body.match(/[?&]containerid=(\d+)/);
      if (containeridMatch) {
        const cid = containeridMatch[1];
        bodyTemplate = body.replace(cid, '{containerid}');
        console.log('[签到按钮] 原始 containerid:', cid);
      }
      
      if (data.button_body_tpl !== bodyTemplate) {
        data.button_body_tpl = bodyTemplate;
        notify.push('✅ 已捕获签到 Body 模板');
        console.log('[签到按钮] Body 模板:', bodyTemplate);
      }
      
      // 同时保存原始 body 供调试
      data.button_body_sample = body;
    }
    
    data.button_method = method;
  }
  
  // 记录更新时间
  data.updateTime = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  
  // 保存数据
  $.setdata(JSON.stringify(data), KEY);
  
  // 只在新增关键字段时通知
  if (notify.length) {
    const summary = [
      ...notify,
      `UID: ${data.uid || '未捕获'}`,
      `更新时间: ${data.updateTime}`
    ].join('\n');
    
    $.msg('微博超话参数抓取', '已更新', summary);
    console.log('[汇总] 已保存数据:', JSON.stringify(data, null, 2));
  }
  
  return $done({}); // 放行请求
})();

// Env 工具类
function Env(name) {
  return new (class {
    constructor(name) {
      this.name = name;
    }
    getdata(k) { 
      return $persistentStore.read(k); 
    }
    setdata(v, k) { 
      return $persistentStore.write(v, k); 
    }
    msg(t, s, b) { 
      $notification.post(t, s, b); 
    }
  })(name);
}
