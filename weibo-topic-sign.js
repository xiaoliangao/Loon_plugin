/*
微博超话自动签到（修复版）
基于抓取的 cardlist/page-button 参数进行签到
*/

const $ = new Env('微博超话签到');

// ===== 配置项 =====
const MAX_TOPICS = 20;           // 最多签到的超话数量
const ENABLE_RETRY = true;        // 是否启用失败重试
const RETRY_DELAY = 3000;         // 重试延迟（毫秒）
const SIGN_DELAY = 2000;          // 签到间隔（毫秒）
const MAX_RETRY = 2;              // 最大重试次数

// ===== 全局变量 =====
let topicList = [];
let signResults = { 
  success: [],  // 签到成功
  failed: [],   // 签到失败
  repeat: []    // 今日已签
};

// ===== 主流程 =====
!(async () => {
  console.log('🚀 开始执行微博超话签到任务');
  console.log(`⏰ 执行时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);
  
  // 1. 读取保存的参数
  const weiboData = getWeiboData();
  if (!weiboData) {
    $.msg('微博超话签到', '失败', '未找到 weibo_topic_data，请先在微博 App 里触发抓取。');
    return;
  }
  
  console.log('📋 已读取参数:', JSON.stringify({
    hasCardlistUrl: !!weiboData.cardlist_url,
    hasButtonUrl: !!weiboData.button_url,
    hasBodyTemplate: !!weiboData.button_body_tpl,
    uid: weiboData.uid || '未捕获'
  }, null, 2));
  
  // 2. 参数完整性检查
  if (!weiboData.cardlist_url) {
    $.msg(
      '微博超话签到',
      '缺少关注列表参数',
      '请打开微博 App → 我 → 超话/社区 → 我的超话（关注列表），下拉刷新一次。'
    );
    return;
  }
  
  if (!weiboData.button_url || !weiboData.button_body_tpl) {
    $.msg(
      '微博超话签到',
      '缺少签到参数',
      '请进入任意已关注超话页面，手动点一次"签到"按钮，然后再运行脚本。\n\n注意：必须实际点击签到按钮才能抓取到 POST body。'
    );
    return;
  }
  
  console.log(`👤 UID: ${weiboData.uid || '未捕获（不影响签到）'}`);
  console.log('📥 开始获取超话列表...\n');
  
  // 3. 获取超话列表
  await getTopicList(weiboData);
  if (topicList.length === 0) {
    $.msg('微博超话签到', '提示', '未解析到关注的超话列表。请确认你已关注超话，且抓到的 cardlist 链接有效。');
    return;
  }
  
  console.log(`✅ 共找到 ${topicList.length} 个超话\n`);
  
  // 4. 执行签到
  await signAllTopics(weiboData);
  
  // 5. 展示结果
  await showResults();
})()
  .catch(e => {
    console.log('❌ 执行出错:', e);
    $.msg('微博超话签到', '执行出错', e.toString());
  })
  .finally(() => $.done());

// ===== 核心函数 =====

/**
 * 读取保存的微博参数
 */
function getWeiboData() {
  const raw = $.getdata('weibo_topic_data');
  if (!raw) return null;
  try { 
    return JSON.parse(raw); 
  } catch (e) { 
    console.log('❌ 解析 weibo_topic_data 失败:', e);
    return null; 
  }
}

/**
 * 构建请求头
 */
function buildHeaders(weiboData, extra = {}) {
  const headers = {
    'User-Agent': weiboData.ua || 'Weibo/70.0.0 (iPhone; iOS 16.0; Scale/3.00)',
    'Accept': 'application/json, text/plain, */*',
    ...extra
  };
  
  if (weiboData.cookie) {
    headers['Cookie'] = weiboData.cookie;
  }
  
  return headers;
}

/**
 * 获取关注的超话列表
 */
function getTopicList(weiboData) {
  return new Promise(resolve => {
    const options = {
      url: weiboData.cardlist_url,
      headers: buildHeaders(weiboData)
    };
    
    console.log('🌐 请求关注列表 URL:', options.url);
    
    $.get(options, (error, response, body) => {
      if (error) {
        console.log('❌ 获取超话列表失败:', error);
        return resolve();
      }
      
      try {
        const result = JSON.parse(body);
        
        // 检查登录状态
        if (result.errno && String(result.errno).match(/^1000(01|03)$/)) {
          console.log('❌ 登录已失效，请重新抓取 Cookie');
          $.msg('微博超话签到', '登录失效', '请重新打开微博 App，刷新关注列表页面以更新 Cookie。');
          return resolve();
        }
        
        const cards = result.cards || [];
        console.log(`📦 收到 ${cards.length} 个卡片`);
        
        for (const card of cards) {
          const group = card.card_group || [];
          for (const item of group) {
            // 提取超话名称和 containerid
            if (item.title_sub && item.scheme) {
              const containerid = item.scheme.match(/containerid=(\d+)/)?.[1];
              if (containerid) {
                topicList.push({ 
                  name: item.title_sub, 
                  containerid 
                });
              }
            }
          }
        }
        
        console.log('✅ 超话列表解析成功');
      } catch (e) {
        console.log('❌ 解析超话列表失败:', e);
      }
      
      resolve();
    });
  });
}

/**
 * 批量签到所有超话
 */
async function signAllTopics(weiboData) {
  const signLimit = Math.min(topicList.length, MAX_TOPICS);
  console.log(`⏳ 开始签到，共 ${signLimit} 个超话\n`);
  console.log('='.repeat(50));
  
  for (let i = 0; i < signLimit; i++) {
    const topic = topicList[i];
    console.log(`\n[${i + 1}/${signLimit}] ${topic.name} (${topic.containerid})`);
    
    await signTopic(topic, weiboData, 0);
    
    // 签到间隔，避免请求过快
    if (i < signLimit - 1) {
      await $.wait(SIGN_DELAY);
    }
  }
  
  console.log('\n' + '='.repeat(50));
}

/**
 * 签到单个超话（支持重试）
 */
function signTopic(topic, weiboData, retryCount) {
  return new Promise(resolve => {
    const url = weiboData.button_url;
    
    // 使用抓到的 body 模板，替换 containerid
    const body = (weiboData.button_body_tpl || '')
      .replace(/{containerid}/g, topic.containerid);
    
    const options = {
      url,
      headers: buildHeaders(weiboData, {
        'Content-Type': 'application/x-www-form-urlencoded'
      }),
      body
    };
    
    console.log('🔄 发送签到请求...');
    if (retryCount > 0) {
      console.log(`   (第 ${retryCount} 次重试)`);
    }
    
    $.post(options, async (error, response, respBody) => {
      // 网络错误处理
      if (error) {
        console.log(`❌ 网络错误: ${error}`);
        if (ENABLE_RETRY && retryCount < MAX_RETRY) {
          console.log(`🔁 等待 ${RETRY_DELAY}ms 后重试...`);
          await $.wait(RETRY_DELAY);
          await signTopic(topic, weiboData, retryCount + 1);
        } else {
          signResults.failed.push(topic.name);
        }
        return resolve();
      }
      
      // 解析响应
      try {
        const result = JSON.parse(respBody);
        console.log('📥 返回结果:', JSON.stringify(result));
        
        // 判断签到结果
        if (result.result === 1 || (result.msg && result.msg.includes('成功'))) {
          console.log('✅ 签到成功');
          signResults.success.push(topic.name);
        } 
        else if (result.msg && (
          result.msg.includes('已签到') || 
          result.msg.includes('已签过') || 
          result.msg.includes('重复')
        )) {
          console.log('⚠️ 今日已签');
          signResults.repeat.push(topic.name);
        } 
        else if (result.errno && String(result.errno).match(/^1000(01|03)$/)) {
          console.log('❌ 登录/会话失效，请重新抓取参数');
          signResults.failed.push(topic.name);
        } 
        else {
          const errMsg = result.msg || result.errmsg || JSON.stringify(result);
          console.log(`❌ 签到失败: ${errMsg}`);
          signResults.failed.push(topic.name);
        }
      } catch (e) {
        console.log(`❌ 解析返回失败: ${e}`);
        console.log('原始返回:', respBody);
        signResults.failed.push(topic.name);
      }
      
      resolve();
    });
  });
}

/**
 * 展示签到结果统计
 */
async function showResults() {
  const total = signResults.success.length + signResults.repeat.length + signResults.failed.length;
  const ok = signResults.success.length + signResults.repeat.length;
  const rate = total > 0 ? ((ok / total) * 100).toFixed(1) : '0.0';
  
  let msg = [
    `📊 签到统计`,
    `✅ 新签到: ${signResults.success.length}`,
    `⚠️ 已签过: ${signResults.repeat.length}`,
    `❌ 失败: ${signResults.failed.length}`,
    `📈 完成率: ${rate}%`
  ].join('\n');
  
  // 如果失败数量较少，列出失败的超话
  if (signResults.failed.length > 0 && signResults.failed.length <= 5) {
    msg += `\n\n失败超话:\n${signResults.failed.join('\n')}`;
  }
  
  console.log('\n' + msg);
  $.msg('微博超话签到完成', `共处理 ${total} 个超话`, msg);
}

// ===== Env 工具类 =====
function Env(t) {
  return new class {
    constructor(t) {
      this.name = t;
      this.startTime = Date.now();
      this.log(`🔔 ${this.name}, 开始!`);
    }
    
    getdata(t) {
      return $persistentStore.read(t);
    }
    
    setdata(t, e) {
      return $persistentStore.write(t, e);
    }
    
    get(t, e = (() => {})) {
      $httpClient.get(t, (t, s, i) => {
        !t && s && (s.body = i, s.statusCode = s.status);
        e(t, s, i);
      });
    }
    
    post(t, e = (() => {})) {
      $httpClient.post(t, (t, s, i) => {
        !t && s && (s.body = i, s.statusCode = s.status);
        e(t, s, i);
      });
    }
    
    msg(t, e, s) {
      $notification.post(t, e, s);
    }
    
    log(t) {
      console.log(t);
    }
    
    wait(t) {
      return new Promise(e => setTimeout(e, t));
    }
    
    done() {
      const t = (Date.now() - this.startTime) / 1e3;
      this.log(`🔔 ${this.name}, 结束! 🕛 ${t} 秒`);
      $done();
    }
  }(t);
}
