/*
微博超话Cookie获取脚本
使用方法：
1. 在 Loon 中配置 MITM 和重写规则
2. 打开微博 APP，进入"我的超话"页面
3. 等待通知提示 Cookie 获取成功
*/

const $ = new Env('微博超话Cookie');

if ($request && $request.url.match(/api\.weibo\.cn/)) {
    const cookie = $request.headers['Cookie'] || $request.headers['cookie'];
    const url = $request.url;
    
    if (cookie) {
        // 提取关键参数
        const sub = cookie.match(/SUB=([^;]+)/)?.[1];
        const gsid = url.match(/gsid=([^&]+)/)?.[1];
        const uid = url.match(/uid=(\d+)/)?.[1];
        
        if (sub || gsid) {
            const weiboData = {
                cookie: cookie,
                gsid: gsid || '',
                uid: uid || '',
                updateTime: new Date().toLocaleString('zh-CN', {timeZone: 'Asia/Shanghai'})
            };
            
            $.setdata(JSON.stringify(weiboData), 'weibo_topic_data');
            console.log('✅ 微博Cookie获取成功');
            console.log(`UID: ${uid || '未知'}`);
            console.log(`更新时间: ${weiboData.updateTime}`);
            
            $.msg('微博超话Cookie', '✅ 获取成功', `UID: ${uid || '未知'}\n更新时间: ${weiboData.updateTime}`);
        } else {
            console.log('⚠️ Cookie 中未找到关键信息');
        }
    }
}

$.done();

// Env 封装
function Env(t){return new class{constructor(t){this.name=t,this.startTime=Date.now(),this.log(`🔔 ${this.name}, 开始!`)}isLoon(){return"undefined"!=typeof $loon}getdata(t){return $persistentStore.read(t)}setdata(t,e){return $persistentStore.write(t,e)}msg(t,e,s){$notification.post(t,e,s)}log(t){console.log(t)}done(){const t=(Date.now()-this.startTime)/1e3;this.log(`🔔 ${this.name}, 结束! 🕛 ${t} 秒`),$done()}}(t)}
