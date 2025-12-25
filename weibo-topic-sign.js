/*
微博超话签到脚本
每天 10:00 自动执行
最多签到 20 个超话，失败自动重试
*/

const $ = new Env('微博超话签到');

// 固定配置
const MAX_TOPICS = 20;        // 最大签到数量
const ENABLE_RETRY = true;    // 自动重试开关
const RETRY_DELAY = 3000;     // 重试延迟(毫秒)
const SIGN_DELAY = 2000;      // 签到间隔(毫秒)
const MAX_RETRY = 2;          // 最大重试次数

let topicList = [];
let signResults = {
    success: [],
    failed: [],
    repeat: []
};

// 主函数
!(async () => {
    console.log('🚀 开始执行微博超话签到任务');
    console.log(`⏰ 执行时间: ${new Date().toLocaleString('zh-CN', {timeZone: 'Asia/Shanghai'})}`);
    
    const weiboData = getWeiboData();
    if (!weiboData) {
        const msg = '❌ 未获取到Cookie，请先打开微博APP抓取Cookie';
        console.log(msg);
        $.msg('微博超话签到', '失败', msg);
        return;
    }
    
    console.log(`👤 UID: ${weiboData.uid || '未知'}`);
    console.log('🔄 开始获取超话列表...\n');
    
    await getTopicList(weiboData);
    
    if (topicList.length === 0) {
        const msg = '未找到关注的超话，请先在微博APP中关注一些超话';
        console.log(`⚠️ ${msg}`);
        $.msg('微博超话签到', '提示', msg);
        return;
    }
    
    console.log(`📋 共找到 ${topicList.length} 个超话\n`);
    await signAllTopics(weiboData);
    await showResults();
})()
.catch((e) => {
    console.log('❌ 执行出错:', e);
    $.msg('微博超话签到', '执行出错', e.toString());
})
.finally(() => $.done());

// 获取用户数据
function getWeiboData() {
    const data = $.getdata('weibo_topic_data');
    if (!data) return null;
    
    try {
        return JSON.parse(data);
    } catch (e) {
        console.log('❌ Cookie 数据解析失败:', e);
        return null;
    }
}

// 获取超话列表
function getTopicList(weiboData) {
    return new Promise((resolve) => {
        const url = `https://api.weibo.cn/2/cardlist?containerid=100803_-_followsuper&gsid=${weiboData.gsid}&uid=${weiboData.uid}`;
        
        const options = {
            url: url,
            headers: {
                'Cookie': weiboData.cookie,
                'User-Agent': 'Weibo/70.0.0 (iPhone; iOS 16.0; Scale/3.00)',
                'Accept': 'application/json'
            }
        };
        
        $.get(options, (error, response, data) => {
            if (error) {
                console.log('❌ 获取超话列表失败:', error);
                resolve();
                return;
            }
            
            try {
                const result = JSON.parse(data);
                
                if (result.cards && result.cards.length > 0) {
                    result.cards.forEach(card => {
                        if (card.card_group) {
                            card.card_group.forEach(item => {
                                if (item.title_sub && item.scheme) {
                                    const containerid = item.scheme.match(/containerid=(\d+)/)?.[1];
                                    if (containerid) {
                                        topicList.push({
                                            name: item.title_sub,
                                            containerid: containerid
                                        });
                                    }
                                }
                            });
                        }
                    });
                    console.log('✅ 超话列表获取成功');
                } else {
                    console.log('⚠️ 未找到超话数据');
                }
            } catch (e) {
                console.log('❌ 解析超话列表失败:', e);
            }
            
            resolve();
        });
    });
}

// 签到所有超话
async function signAllTopics(weiboData) {
    const signLimit = Math.min(topicList.length, MAX_TOPICS);
    console.log(`⏳ 开始签到，共 ${signLimit} 个超话\n`);
    console.log('='.repeat(50));
    
    for (let i = 0; i < signLimit; i++) {
        const topic = topicList[i];
        console.log(`\n[${i + 1}/${signLimit}] ${topic.name}`);
        
        await signTopic(topic, weiboData, 0);
        
        // 最后一个不需要延迟
        if (i < signLimit - 1) {
            await $.wait(SIGN_DELAY);
        }
    }
    
    console.log('\n' + '='.repeat(50));
}

// 签到单个超话
function signTopic(topic, weiboData, retryCount) {
    return new Promise((resolve) => {
        const url = `https://api.weibo.cn/2/page/button?gsid=${weiboData.gsid}&uid=${weiboData.uid}`;
        
        const body = `containerid=${topic.containerid}&request_url=http://i.huati.weibo.com/mobile/super/active_checkin`;
        
        const options = {
            url: url,
            headers: {
                'Cookie': weiboData.cookie,
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent': 'Weibo/70.0.0 (iPhone; iOS 16.0; Scale/3.00)',
                'Accept': 'application/json'
            },
            body: body
        };
        
        $.post(options, async (error, response, data) => {
            if (error) {
                console.log(`  ❌ 网络错误: ${error}`);
                
                // 自动重试
                if (ENABLE_RETRY && retryCount < MAX_RETRY) {
                    console.log(`  🔄 第 ${retryCount + 1} 次重试...`);
                    await $.wait(RETRY_DELAY);
                    await signTopic(topic, weiboData, retryCount + 1);
                    resolve();
                    return;
                } else {
                    signResults.failed.push(topic.name);
                    resolve();
                    return;
                }
            }
            
            try {
                const result = JSON.parse(data);
                
                // 判断签到结果
                if (result.result === 1 || (result.msg && result.msg.includes('成功'))) {
                    console.log(`  ✅ 签到成功`);
                    signResults.success.push(topic.name);
                } else if (result.msg && (result.msg.includes('已签到') || result.msg.includes('已签过') || result.msg.includes('重复'))) {
                    console.log(`  ⚠️ 今日已签`);
                    signResults.repeat.push(topic.name);
                } else if (result.errno && result.errno === '100001') {
                    console.log(`  ❌ 登录失效，请重新抓取Cookie`);
                    signResults.failed.push(topic.name);
                } else {
                    console.log(`  ❌ 签到失败: ${result.msg || result.errmsg || '未知错误'}`);
                    signResults.failed.push(topic.name);
                }
            } catch (e) {
                console.log(`  ❌ 解析返回数据失败: ${e}`);
                signResults.failed.push(topic.name);
            }
            
            resolve();
        });
    });
}

// 显示结果
async function showResults() {
    const total = signResults.success.length + signResults.repeat.length + signResults.failed.length;
    const successCount = signResults.success.length + signResults.repeat.length;
    const successRate = total > 0 ? ((successCount / total) * 100).toFixed(1) : 0;
    
    console.log('\n📊 签到结果统计:');
    console.log(`✅ 新签到: ${signResults.success.length} 个`);
    console.log(`⚠️ 已签过: ${signResults.repeat.length} 个`);
    console.log(`❌ 失败: ${signResults.failed.length} 个`);
    console.log(`📈 完成率: ${successRate}%`);
    
    // 构建通知消息
    let notifyMsg = `📊 签到统计\n`;
    notifyMsg += `✅ 新签到: ${signResults.success.length}\n`;
    notifyMsg += `⚠️ 已签过: ${signResults.repeat.length}\n`;
    notifyMsg += `❌ 失败: ${signResults.failed.length}\n`;
    notifyMsg += `📈 完成率: ${successRate}%`;
    
    // 如果有失败的，列出失败超话
    if (signResults.failed.length > 0 && signResults.failed.length <= 5) {
        notifyMsg += `\n\n失败超话:\n${signResults.failed.join('\n')}`;
    }
    
    $.msg('微博超话签到完成', `共处理 ${total} 个超话`, notifyMsg);
}

// Env 封装
function Env(t){return new class{constructor(t){this.name=t,this.startTime=Date.now(),this.log(`🔔 ${this.name}, 开始!`)}isLoon(){return"undefined"!=typeof $loon}getdata(t){return $persistentStore.read(t)}setdata(t,e){return $persistentStore.write(t,e)}get(t,e=(()=>{})){$httpClient.get(t,(t,s,i)=>{!t&&s&&(s.body=i,s.statusCode=s.status),e(t,s,i)})}post(t,e=(()=>{})){$httpClient.post(t,(t,s,i)=>{!t&&s&&(s.body=i,s.statusCode=s.status),e(t,s,i)})}msg(t,e,s){$notification.post(t,e,s)}log(t){console.log(t)}wait(t){return new Promise(e=>setTimeout(e,t))}done(){const t=(Date.now()-this.startTime)/1e3;this.log(`🔔 ${this.name}, 结束! 🕛 ${t} 秒`),$done()}}(t)}
