/*
微博超话参数抓取（增强调试版）
用途：抓取关注列表 URL 和签到所需的完整参数（URL + Body）
特点：详细日志 + 宽松匹配 + 自动调试
*/

const $ = new Env('微博超话参数抓取');
const KEY = 'weibo_topic_data';

(function () {
  if (typeof $request === 'undefined') {
    console.log('⚠️ 未检测到 $request 对象，脚本未被 HTTP 请求触发');
    return $done({});
  }
  
  const urlStr = $request.url || '';
  const method = ($request.method || 'GET').toUpperCase();
  
  // 调试：打印所有请求信息
  console.log('='.repeat(60));
  console.log('📥 捕获到 HTTP 请求');
  console.log('🔗 URL:', urlStr);
  console.log('📋 Method:', method);
  
  // 检查是否是微博域名
  if (!/weibo\.(cn|com)/.test(urlStr)) {
    console.log('⚠️ 非微博域名，跳过处理');
    console.log('='.repeat(60));
    return $done({});
  }
  
  console.log('✅ 确认是微博请求，继续处理...');
  
  const headers = $request.headers || {};
  const ua = headers['User-Agent'] || headers['user-agent'] || '';
  const reqCookie = headers['Cookie'] || headers['cookie'] || '';
  const body = $request.body || '';
  
  // 提取常见参数
  const gsid = urlStr.match(/(?:\?|&)gsid=([^&]+)/)?.[1] || '';
  const uid = urlStr.match(/(?:\?|&)uid=(\d+)/)?.[1] || '';
  const containerid = urlStr.match(/(?:\?|&)containerid=([^&]+)/)?.[1] || '';
  
  console.log('📊 请求详情:');
  console.log('  - GSID:', gsid || '未找到');
  console.log('  - UID:', uid || '未找到');
  console.log('  - Container ID:', containerid || '未找到');
  console.log('  - Has Cookie:', reqCookie ? '是' : '否');
  console.log('  - Has Body:', body ? '是' : '否');
  
  // 读取已有数据
  let data = {};
  try { 
    const raw = $.getdata(KEY);
    if (raw) {
      data = JSON.parse(raw);
      console.log('📦 读取到已保存的数据:', Object.keys(data).join(', '));
    } else {
      console.log('📦 首次抓取，暂无已保存数据');
    }
  } catch (e) { 
    console.log('⚠️ 解析已保存数据失败:', e);
    data = {}; 
  }
  
  let notify = [];
  let hasUpdate = false;
  
  // 合并基础信息（空值不覆盖旧值）
  if (ua && data.ua !== ua) {
    data.ua = ua;
    hasUpdate = true;
    console.log('✅ 更新 User-Agent');
  }
  
  if (reqCookie && data.cookie !== reqCookie) {
    data.cookie = reqCookie;
    hasUpdate = true;
    console.log('✅ 更新 Cookie');
  }
  
  if (gsid && data.gsid !== gsid) {
    data.gsid = gsid;
    hasUpdate = true;
    console.log('✅ 更新 GSID');
  }
  
  if (uid && data.uid !== uid) {
    data.uid = uid;
    hasUpdate = true;
    console.log('✅ 更新 UID');
  }
  
  // ==========================================
  // ① 捕获关注列表 URL（多种匹配规则）
  // ==========================================
  console.log('\n🔍 检查是否为关注列表请求...');
  
  // 规则1：标准格式 - /2/cardlist?...containerid=100803_-_followsuper
  const isFollowList1 = 
    /\/2\/cardlist\?/.test(urlStr) && 
    /containerid=100803[_-]+followsuper/.test(urlStr);
  
  // 规则2：Page 接口 - /2/page?...containerid=100803...
  const isFollowList2 = 
    /\/2\/page\?/.test(urlStr) && 
    /containerid=100803/.test(urlStr) &&
    /followsuper/.test(urlStr);
  
  // 规则3：宽松匹配 - 任何包含 100803 和 follow 的请求
  const isFollowList3 = 
    containerid && 
    containerid.includes('100803') && 
    (urlStr.includes('follow') || urlStr.includes('super'));
  
  const isFollowList = isFollowList1 || isFollowList2 || isFollowList3;
  
  if (isFollowList1) console.log('✅ 匹配规则1：标准 cardlist 格式');
  if (isFollowList2) console.log('✅ 匹配规则2：Page 接口格式');
  if (isFollowList3) console.log('✅ 匹配规则3：宽松匹配（containerId=100803+follow）');
  
  if (isFollowList) {
    if (data.cardlist_url !== urlStr) {
      data.cardlist_url = urlStr;
      notify.push('✅ 已捕获关注列表参数');
      hasUpdate = true;
      console.log('🎉 成功捕获关注列表 URL！');
      console.log('📝 完整URL:', urlStr);
    } else {
      console.log('ℹ️ 关注列表 URL 已存在且相同，无需更新');
    }
  } else {
    console.log('❌ 不是关注列表请求');
    if (containerid) {
      console.log('💡 提示：当前 containerid 是:', containerid);
      console.log('💡 期望：containerid 应包含 100803 和 followsuper');
    }
  }
  
  // ==========================================
  // ② 捕获签到参数（/2/page/button）
  // ==========================================
  console.log('\n🔍 检查是否为签到按钮请求...');
  
  const isButton = /\/2\/page\/button\?/.test(urlStr);
  
  if (isButton) {
    console.log('✅ 确认是签到按钮请求');
    console.log('📋 请求方法:', method);
    
    // 保存完整 URL
    if (data.button_url !== urlStr) {
      data.button_url = urlStr;
      notify.push('✅ 已捕获签到 URL');
      hasUpdate = true;
      console.log('🎉 成功捕获签到 URL！');
    }
    
    // 保存 POST body（关键！）
    if (method === 'POST' && body) {
      console.log('📦 检测到 POST Body:', body.substring(0, 200) + (body.length > 200 ? '...' : ''));
      
      // 将 body 转为模板：提取 containerid 并替换为占位符
      let bodyTemplate = body;
      const containeridMatch = body.match(/containerid=(\d+)/);
      
      if (containeridMatch) {
        const cid = containeridMatch[1];
        bodyTemplate = body.replace(cid, '{containerid}');
        console.log('🔑 提取到 containerid:', cid);
        console.log('📝 生成 Body 模板:', bodyTemplate.substring(0, 200) + (bodyTemplate.length > 200 ? '...' : ''));
      } else {
        console.log('⚠️ 未在 Body 中找到 containerid，使用原始 body');
      }
      
      if (data.button_body_tpl !== bodyTemplate) {
        data.button_body_tpl = bodyTemplate;
        notify.push('✅ 已捕获签到 Body 模板');
        hasUpdate = true;
        console.log('🎉 成功捕获签到 Body 模板！');
      } else {
        console.log('ℹ️ Body 模板已存在且相同，无需更新');
      }
      
      // 同时保存原始 body 供调试
      data.button_body_sample = body;
      
    } else if (method === 'POST' && !body) {
      console.log('⚠️ 这是 POST 请求，但未捕获到 Body！');
      console.log('💡 请确认插件配置中设置了 requires-body=true');
    } else {
      console.log('ℹ️ 这是 GET 请求，不需要 Body');
    }
    
    data.button_method = method;
    
  } else {
    console.log('❌ 不是签到按钮请求');
    console.log('💡 期望：URL 应包含 /2/page/button');
  }
  
  // ==========================================
  // 保存数据
  // ==========================================
  if (hasUpdate) {
    data.updateTime = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    $.setdata(JSON.stringify(data), KEY);
    console.log('\n💾 数据已保存到持久化存储');
  } else {
    console.log('\n💾 本次未发现新数据，未更新存储');
  }
  
  // 打印当前数据完整性
  console.log('\n📊 当前数据完整性检查:');
  console.log('  ✓ UID:', data.uid ? '已捕获' : '未捕获');
  console.log('  ✓ Cookie:', data.cookie ? '已捕获' : '未捕获');
  console.log('  ✓ 关注列表URL:', data.cardlist_url ? '已捕获 ✅' : '未捕获 ❌');
  console.log('  ✓ 签到URL:', data.button_url ? '已捕获' : '未捕获');
  console.log('  ✓ 签到Body模板:', data.button_body_tpl ? '已捕获 ✅' : '未捕获 ❌');
  
  const ready = data.cardlist_url && data.button_url && data.button_body_tpl;
  console.log('  🎯 签到就绪状态:', ready ? '✅ 可以开始签到' : '❌ 还需要抓取更多参数');
  
  // ==========================================
  // 发送通知
  // ==========================================
  if (notify.length > 0) {
    const summary = [
      ...notify,
      `UID: ${data.uid || '未捕获'}`,
      `更新时间: ${data.updateTime}`
    ].join('\n');
    
    $.msg('微博超话参数抓取', '已更新', summary);
    console.log('\n📢 已发送通知');
  } else {
    console.log('\n📢 无新数据，不发送通知');
  }
  
  console.log('='.repeat(60));
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
