/*
微博超话自动签到（基于抓取的 cardlist/page-button 参数）
*/

const $ = new Env('微博超话签到');

const MAX_TOPICS = 20;
const ENABLE_RETRY = true;
const RETRY_DELAY = 3000;
const SIGN_DELAY = 2000;
const MAX_RETRY = 2;

let topicList = [];
let signResults = { success: [], failed: [], repeat: [] };

!(async () => {
  console.log('🚀 开始执行微博超话签到任务');
  console.log(`⏰ 执行时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);

  const weiboData = getWeiboData();
  if (!weiboData) {
    $.msg('微博超话签到', '失败', '未找到 weibo_topic_data，请先在微博 App 里触发抓取。');
    return;
  }

  // 必要参数校验：优先用抓到的 URL 模板
  if (!weiboData.cardlist_url) {
    $.msg(
      '微博超话签到',
      '需要抓取关注列表参数',
      '请打开微博 App → 我 → 超话/社区 → 我的超话（关注列表），下拉刷新一次。'
    );
    return;
  }
  if (!weiboData.button_url || !weiboData.button_body_tpl) {
    $.msg(
      '微博超话签到',
      '需要抓取签到参数',
      '请进入任意已关注超话页面，手动点一次“签到”，然后再运行脚本。'
    );
    return;
  }

  console.log(`👤 UID: ${weiboData.uid || '未捕获（不一定影响）'}`);
  console.log('📥 开始获取超话列表...\n');

  await getTopicList(weiboData);
  if (topicList.length === 0) {
    $.msg('微博超话签到', '提示', '未解析到关注的超话列表。请确认你已关注超话，且抓到的 cardlist 链接有效。');
    return;
  }

  console.log(`✅ 共找到 ${topicList.length} 个超话\n`);
  await signAllTopics(weiboData);
  await showResults();
})()
  .catch(e => {
    console.log('❌ 执行出错:', e);
    $.msg('微博超话签到', '执行出错', e.toString());
  })
  .finally(() => $.done());

function getWeiboData() {
  const raw = $.getdata('weibo_topic_data');
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (_) { return null; }
}

function buildHeaders(weiboData, extra = {}) {
  const h = {
    'User-Agent': weiboData.ua || 'Weibo/70.0.0 (iPhone; iOS 16.0; Scale/3.00)',
    'Accept': 'application/json',
    ...extra
  };
  if (weiboData.cookie) h['Cookie'] = weiboData.cookie;
  return h;
}

function getTopicList(weiboData) {
  return new Promise(resolve => {
    const options = {
      url: weiboData.cardlist_url,
      headers: buildHeaders(weiboData)
    };

    $.get(options, (error, response, body) => {
      if (error) {
        console.log('❌ 获取超话列表失败:', error);
        return resolve();
      }
      try {
        const result = JSON.parse(body);
        const cards = result.cards || [];
        for (const card of cards) {
          const group = card.card_group || [];
          for (const item of group) {
            if (item.title_sub && item.scheme) {
              const containerid = item.scheme.match(/containerid=(\d+)/)?.[1];
              if (containerid) topicList.push({ name: item.title_sub, containerid });
            }
          }
        }
        console.log('✅ 超话列表获取成功');
      } catch (e) {
        console.log('❌ 解析超话列表失败:', e);
      }
      resolve();
    });
  });
}

async function signAllTopics(weiboData) {
  const signLimit = Math.min(topicList.length, MAX_TOPICS);
  console.log(`⏳ 开始签到，共 ${signLimit} 个超话\n`);
  console.log('='.repeat(50));

  for (let i = 0; i < signLimit; i++) {
    const topic = topicList[i];
    console.log(`\n[${i + 1}/${signLimit}] ${topic.name}`);
    await signTopic(topic, weiboData, 0);
    if (i < signLimit - 1) await $.wait(SIGN_DELAY);
  }

  console.log('\n' + '='.repeat(50));
}

function signTopic(topic, weiboData, retryCount) {
  return new Promise(resolve => {
    const url = weiboData.button_url;

    // 用抓到的 body 模板，仅替换 containerid
    const body = (weiboData.button_body_tpl || '')
      .replace('{containerid}', topic.containerid);

    const options = {
      url,
      headers: buildHeaders(weiboData, {
        'Content-Type': 'application/x-www-form-urlencoded'
      }),
      body
    };

    $.post(options, async (error, response, respBody) => {
      if (error) {
        console.log(`❌ 网络错误: ${error}`);
        if (ENABLE_RETRY && retryCount < MAX_RETRY) {
          console.log(`🔁 第 ${retryCount + 1} 次重试...`);
          await $.wait(RETRY_DELAY);
          await signTopic(topic, weiboData, retryCount + 1);
        } else {
          signResults.failed.push(topic.name);
        }
        return resolve();
      }

      try {
        const result = JSON.parse(respBody);

        if (result.result === 1 || (result.msg && result.msg.includes('成功'))) {
          console.log('✅ 签到成功');
          signResults.success.push(topic.name);
        } else if (result.msg && (result.msg.includes('已签到') || result.msg.includes('已签过') || result.msg.includes('重复'))) {
          console.log('⚠️ 今日已签');
          signResults.repeat.push(topic.name);
        } else if (result.errno && (String(result.errno) === '100001' || String(result.errno) === '100003')) {
          console.log('❌ 登录/会话失效，请重新抓取参数');
          signResults.failed.push(topic.name);
        } else {
          console.log(`❌ 签到失败: ${result.msg || result.errmsg || '未知错误'}`);
          signResults.failed.push(topic.name);
        }
      } catch (e) {
        console.log(`❌ 解析返回失败: ${e}`);
        signResults.failed.push(topic.name);
      }

      resolve();
    });
  });
}

async function showResults() {
  const total = signResults.success.length + signResults.repeat.length + signResults.failed.length;
  const ok = signResults.success.length + signResults.repeat.length;
  const rate = total > 0 ? ((ok / total) * 100).toFixed(1) : '0.0';

  let msg = `签到统计\n✅ 新签到: ${signResults.success.length}\n⚠️ 已签过: ${signResults.repeat.length}\n❌ 失败: ${signResults.failed.length}\n完成率: ${rate}%`;
  if (signResults.failed.length > 0 && signResults.failed.length <= 5) {
    msg += `\n\n失败超话:\n${signResults.failed.join('\n')}`;
  }

  $.msg('微博超话签到完成', `共处理 ${total} 个超话`, msg);
}

// Env
function Env(t){return new class{constructor(t){this.name=t,this.startTime=Date.now(),this.log(`🔔 ${this.name}, 开始!`)}getdata(t){return $persistentStore.read(t)}setdata(t,e){return $persistentStore.write(t,e)}get(t,e=(()=>{})){$httpClient.get(t,(t,s,i)=>{!t&&s&&(s.body=i,s.statusCode=s.status),e(t,s,i)})}post(t,e=(()=>{})){$httpClient.post(t,(t,s,i)=>{!t&&s&&(s.body=i,s.statusCode=s.status),e(t,s,i)})}msg(t,e,s){$notification.post(t,e,s)}log(t){console.log(t)}wait(t){return new Promise(e=>setTimeout(e,t))}done(){const t=(Date.now()-this.startTime)/1e3;this.log(`🔔 ${this.name}, 结束! 🕛 ${t} 秒`),$done()}}(t)}
