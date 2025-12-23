/**
 * 股票 / 指数 / 基金行情推送（较昨收涨跌为主）
 *
 * 修复点：
 * 1) 参数解析：兼容插件传入的“纯字符串 000001,399001,012414,AAPL”
 * 2) timeout 单位：毫秒（默认 5000ms；避免误用 15 这种导致必超时）
 * 3) node 自动选用 final/global_proxy（可通过 argument 传入 node 覆盖）
 *
 * 支持：
 * - A股/ETF/指数：腾讯行情（qt.gtimg.cn）
 * - 港股：腾讯行情（qt.gtimg.cn）
 * - 美股：腾讯行情（qt.gtimg.cn）优先 us*，失败回退 s_us*（仅能得到较昨收涨跌）
 * - 场外基金（如 012414）：东方财富基金估值（fundgz.1234567.com.cn），展示「估值涨跌」
 */

const TITLE = formatDateCN(new Date()) + ' 的奏折';
const TENCENT_API = 'https://qt.gtimg.cn/q=';
const FUNDGZ_API = 'https://fundgz.1234567.com.cn/js/';  // 例：.../012414.js
const TIMEOUT_MS = 15000;


function hostOf(url) {
  const m = String(url || '').match(/^https?:\/\/([^\/]+)/i);
  return m ? m[1].toLowerCase() : '';
}

function isDirectNode(node) {
  return String(node || '').trim().toUpperCase() === 'DIRECT';
}

/**
 * 行情/基金接口（qt.gtimg.cn / fundgz.1234567.com.cn）在多数情况下建议直连，
 * 避免走“出海代理组”导致超时或被拦。
 */
function effectiveNodeForUrl(url, preferNode) {
  const host = hostOf(url);
  if (/(^|\.)qt\.gtimg\.cn$/.test(host) || /(^|\.)fundgz\.1234567\.com\.cn$/.test(host)) {
    return isDirectNode(preferNode) ? 'DIRECT' : 'DIRECT';
  }
  return preferNode || '';
}



function isPlaceholder(v) {
  return typeof v === 'string' && /^\{[A-Za-z0-9_]+\}$/.test(v.trim());
}

function readUI(key, defVal = '') {
  try {
    const v = $persistentStore.read(key);
    if (v === undefined || v === null) return defVal;
    return String(v);
  } catch (_) {
    return defVal;
  }
}

function pickEffectiveArgs(args) {
  // argument 优先，其次读取插件 UI（$persistentStore）
  const stockCodesArg = (args && (args.stockCodes || args.codes || args.code || args.list)) || '';
  const nodeArg = (args && (args.node || args.netNode)) || '';

  const stockCodes = (!stockCodesArg || isPlaceholder(stockCodesArg)) ? readUI('stockCodes', '') : String(stockCodesArg);
  const node = (!nodeArg || isPlaceholder(nodeArg)) ? readUI('netNode', '') : String(nodeArg);

  return { stockCodes: stockCodes.trim(), node: node.trim() };
}


function main() {
  const args = parseArgs();
  console.log(`📋 参数类型: ${typeof $argument}`);
  console.log(`📋 参数内容: ${typeof $argument === 'string' ? $argument : JSON.stringify($argument)}`);
    const eff = pickEffectiveArgs(args);
  console.log(`📋 输入(插件设置): ${readUI("stockCodes","")}`);
  console.log(`✅ 生效 codes: ${eff.stockCodes || "(空)"}`);
  console.log(`✅ 生效 node: ${(!eff.node || /^auto$/i.test(eff.node)) ? "(自动)" : eff.node}`);

  const node = pickNode(eff.node || "");
  const raw = (eff.stockCodes || "").trim();
  if (!raw) {
    $notification.post(
      TITLE,
      '配置提示',
      [
        '请配置股票/指数/基金代码（英文逗号分隔）：',
        'A股/指数：000001,399001,600519,159915',
        '港股：00700,09988',
        '美股：AAPL,TSLA（可带后缀：TSLA.OQ / BABA.N）',
        '场外基金：012414（或 fund:012414）',
        '',
        '你也可以在 cron 的 argument 里传入：',
        'stockCodes=000001,399001,012414,AAPL&node=节点选择',
      ].join('\n')
    );
    return $done();
  }

  const inputList = raw.split(',').map(s => s.trim()).filter(Boolean);
  console.log(`📋 输入: ${inputList.join(',')}`);
  console.log(`🌐 代理策略(prefer): ${node || '(默认)'}`);
  console.log('🌐 行情接口：默认使用 DIRECT（直连）');

  const uniqTencent = [];
  const fundList = [];
  const unresolved = [];

  inputList.forEach(s => {
    const parsed = parseCode(s);
    if (!parsed) { unresolved.push(s); return; }
    if (parsed.kind === 'fund') fundList.push(parsed);
    else uniqTencent.push.apply(uniqTencent, parsed.tencentCodes);
  });

  if (unresolved.length) console.log('⚠️ 无法识别: ' + unresolved.join(','));

  const need = (uniqTencent.length ? 1 : 0) + (fundList.length ? 1 : 0);
  if (need === 0) {
    $notification.post(TITLE, '无有效代码', '请检查你的 stockCodes 配置。');
    return $done();
  }

  let doneCount = 0;
  let results = [];

  if (uniqTencent.length) {
    queryTencent(unique(uniqTencent), node, (err, list) => {
      doneCount += 1;
      if (err) console.log('❌ 腾讯行情失败: ' + String(err));
      else results = results.concat(list || []);
      if (doneCount === need) finish(results);
    });
  }

  if (fundList.length) {
    queryFunds(fundList, node, (err, list) => {
      doneCount += 1;
      if (err) console.log('❌ 基金估值失败: ' + String(err));
      else results = results.concat(list || []);
      if (doneCount === need) finish(results);
    });
  }
}

/** ---------- 参数解析 ---------- */
function parseArgs() {
  // 插件 argument=[{a},{b}] 时，$argument 是对象：可用 $argument.a 访问
  if (typeof $argument === 'object' && $argument !== null) return $argument;
  // 支持：
  // 1) 纯字符串：000001,399001,012414,AAPL
  // 2) query-string：stockCodes=...&node=节点选择
  // 3) JSON：{"stockCodes":"...","node":"..."}
  const a = (typeof $argument === 'string') ? $argument.trim() : '';
  if (!a) return {};

  if (a.startsWith('{') && a.endsWith('}')) {
    try { return JSON.parse(a); } catch (_) {}
  }

  if (a.includes('=') && a.includes('&')) return parseQuery(a);

  return { stockCodes: a };
}

function parseQuery(qs) {
  const out = {};
  String(qs).split('&').forEach(p => {
    const i = p.indexOf('=');
    if (i <= 0) return;
    const k = decodeURIComponent(p.slice(0, i));
    const v = decodeURIComponent(p.slice(i + 1));
    out[k] = v;
  });
  return out;
}

function pickNode(prefer) {
  const p = String(prefer || '').trim();
  // UI 下拉默认值为 AUTO：表示不指定脚本请求策略
  if (p && !/^auto$/i.test(p)) return p;
  try {
    if (typeof $config !== 'undefined' && $config.getConfig) {
      const cfg = $config.getConfig();
      const cand = cfg.global_proxy || cfg.final;
      if (cand) return cand;
    }
  } catch (_) {}
  return '';
}

/** ---------- 代码识别 ---------- */
function parseCode(raw) {
  let s = String(raw || '').trim();

  // 允许用户输入 s_ 前缀，统一去掉
  s = s.replace(/^s_/i, '');

  // 显式基金：fund:012414
  if (/^fund:\d{6}$/i.test(s)) return { kind: 'fund', fundCode: s.split(':')[1], display: s };

  // 已带交易所前缀
  if (/^(sh|sz|bj)\d{6}$/i.test(s)) return { kind: 'tencent', tencentCodes: [s.toLowerCase()], display: s };
  if (/^hk\d{5}$/i.test(s)) return { kind: 'tencent', tencentCodes: [s.toLowerCase()], display: s };
  if (/^us[\w.]+$/i.test(s)) return { kind: 'tencent', tencentCodes: buildUsCodes(s.replace(/^us/i, '')), display: s };

  // 纯数字：6 位优先判定 A 股/指数/基金
  if (/^\d{6}$/.test(s)) {
    // 常见指数映射
    const idx = normalizeIndex(s);
    if (idx) return { kind: 'tencent', tencentCodes: [idx], display: idx };

    // 场外基金启发式：01/02/03 开头
    if (/^(01|02|03)\d{4}$/.test(s)) return { kind: 'fund', fundCode: s, display: 'fund:' + s };

    // A股/ETF 推断
    const a = normalizeAStock(s);
    if (a) return { kind: 'tencent', tencentCodes: [a], display: a };
  }

  // 港股：5 位数字（保留前导 0）
  if (/^\d{5}$/.test(s)) return { kind: 'tencent', tencentCodes: ['hk' + s], display: 'hk' + s };

  // 美股：纯字母/数字 ticker
  if (/^[A-Za-z][A-Za-z0-9.\-]{0,10}$/.test(s)) {
    return { kind: 'tencent', tencentCodes: buildUsCodes(s), display: s };
  }

  return null;
}

function buildUsCodes(ticker) {
  const t = String(ticker || '').trim();
  const base = t.replace(/\s+/g, '').toUpperCase();
  const plain = base.replace(/\..*$/, ''); // TSLA.OQ -> TSLA
  const out = [];
  out.push('us' + plain);
  // 一些时候 usTSLA.OQ 也能返回，保留尝试
  if (base.includes('.')) out.push('us' + base);
  // 回退简版（仅较昨收）
  out.push('s_us' + plain);
  return unique(out);
}

function normalizeIndex(code6) {
  const map = {
    '000001': 'sh000001', // 上证指数（常用）
    '000300': 'sh000300', // 沪深300
    '399001': 'sz399001', // 深证成指
    '399006': 'sz399006', // 创业板指
    '399905': 'sz399905', // 中证500
    '399303': 'sz399303', // 国证2000
  };
  return map[code6] || null;
}

function normalizeAStock(code6) {
  if (/^(00|30|02|15|16)\d{4}$/.test(code6)) return 'sz' + code6;
  if (/^(60|68|51|52|53|56|58)\d{4}$/.test(code6)) return 'sh' + code6;
  if (/^(83|87|43)\d{4}$/.test(code6)) return 'bj' + code6;
  return null;
}

/** ---------- 腾讯行情 ---------- */
function queryTencent(codes, node, callback) {
  const url = TENCENT_API + codes.join(',');
  const effNode = effectiveNodeForUrl(url, node);
  console.log(`🔄 腾讯请求码: ${codes.join(',')}`);
  console.log(`🌐 腾讯策略(node): ${effNode || '(默认)'}`);

  $httpClient.get(
    {
      url,
      timeout: TIMEOUT_MS,
      node: effNode,
      headers: {
        'User-Agent': 'LoonScript/Stock/1.0',
        'Accept': '*/*',
      }
    },
    (err, resp, data) => {
      const status = resp && resp.status;
      if (err || !(status >= 200 && status < 300)) return callback(err || ('HTTP ' + status));
      const list = parseTencentResponse(String(data || ''));
      console.log(`✅ 腾讯解析条目: ${(list && list.length) || 0}`);
      callback(null, list);
    }
  );
}

function parseTencentResponse(data) {
  const lines = data.split('\n').map(l => l.trim()).filter(Boolean);

  // key: 规范化后的主键（用于过滤 us 与 s_us 重复）
  const map = {};

  lines.forEach(line => {
    const m = line.match(/v_([^=]+)=["']([^"']*)["']/i);
    if (!m) return;

    const fullCode = (m[1] || '').trim();     // 例如 sh600519 / usAAPL / s_usTSLA
    const payload = (m[2] || '').trim();
    const info = payload.split('~');
    if (!info || info.length < 6) return;

    // 先识别简版美股（s_us）
    if (/^s_us/i.test(fullCode)) {
      const item = parseTencentSimpleUS(fullCode, info);
      if (item) {
        const key = ('us' + item.symbol).toLowerCase();
        if (!map[key]) map[key] = item;
      }
      return;
    }

    const item = parseTencentFull(fullCode, info);
    if (item) {
      const key = (item.primaryKey || fullCode).toLowerCase();
      map[key] = item;
    }
  });

  const arr = Object.keys(map).map(k => map[k]).filter(Boolean);
  arr.sort((a, b) => marketOrder(a.market) - marketOrder(b.market));
  return arr;
}

function parseTencentFull(fullCode, info) {
  // 常见字段：name=1 code=2 price=3 yclose=4 open=5
  const name = safeName(fullCode, info[1], info[2]);
  const symbol = (info[2] || '').trim() || fullCode.replace(/^(sh|sz|bj|hk|us)/i, '');
  const price = toNum(info[3]);
  const yclose = toNum(info[4]);
  const open = toNum(info[5]);

  if (!price) return null;

  const market = detectMarket(fullCode, symbol);
  const isIndex = isIndexFullCode(fullCode);
  const currency = isIndex ? 'POINT' : marketCurrency(market);

  const changeFromClose = yclose ? (price - yclose) : 0;
  const changePctClose = yclose ? (changeFromClose / yclose) * 100 : 0;

  const changeFromOpen = open ? (price - open) : 0;
  const changePctOpen = open ? (changeFromOpen / open) * 100 : 0;

  return {
    type: 'quote',
    dataQuality: 'full',
    market,
    currency,
    name,
    symbol: normalizeUsSymbol(symbol),
    primaryKey: normalizePrimaryKey(fullCode, symbol),
    price,
    open,
    yclose,
    changeFromOpen,
    changePctOpen,
    changeFromClose,
    changePctClose,
  };
}

function parseTencentSimpleUS(fullCode, info) {
  // 简版美股：v_s_usTSLA="200~特斯拉~TSLA.OQ~489.88~14.57~3.07~..."
  const rawSymbol = (info[2] || '').trim();
  const symbol = rawSymbol ? rawSymbol.replace(/\..*$/, '').toUpperCase() : fullCode.replace(/^s_us/i, '').toUpperCase();
  const name = safeName('us' + symbol, info[1], symbol);
  const price = toNum(info[3]);
  const change = toNum(info[4]);         // 较昨收涨跌
  const pct = toNum(info[5]);            // 较昨收涨跌幅%

  if (!price) return null;
  const yclose = (typeof change === 'number') ? (price - change) : 0;

  return {
    type: 'quote',
    dataQuality: 'simple',
    market: 'US',
    currency: 'USD',
    name,
    symbol,
    primaryKey: ('us' + symbol).toLowerCase(),
    price,
    open: 0,
    yclose: yclose || 0,
    changeFromOpen: 0,
    changePctOpen: 0,
    changeFromClose: (typeof change === 'number') ? change : 0,
    changePctClose: (typeof pct === 'number') ? pct : 0,
    note: '未获取到开盘价，以下为较昨收涨跌',
  };
}

function normalizeUsSymbol(symbol) {
  const s = String(symbol || '').trim();
  return s.replace(/\..*$/, '').toUpperCase();
}

/** ---------- 基金估值 ---------- */
function queryFunds(funds, node, callback) {
  console.log(`🧾 场外基金: ${funds.map(x => x.fundCode).join(',') || '(无)'}`);

  const effNode = effectiveNodeForUrl(FUNDGZ_API + '000000.js', node);
  console.log(`🌐 基金策略(node): ${effNode || '(默认)'}`);

  const out = [];
  let done = 0;

  funds.forEach((f, idx) => {
    setTimeout(() => {
      const url = FUNDGZ_API + f.fundCode + '.js?rt=' + Date.now();

      $httpClient.get(
        {
          url,
          timeout: TIMEOUT_MS,
          node: effNode,
          headers: { 'User-Agent': 'LoonScript/Fund/1.0', 'Accept': '*/*' }
        },
        (err, resp, data) => {
          done += 1;
          const status = resp && resp.status;

          if (!err && status >= 200 && status < 300 && data) {
            const item = parseFundGz(f.fundCode, String(data));
            if (item) out.push(item);
          } else {
            console.log(`❌ 基金 ${f.fundCode} 获取失败: ${String(err || ('HTTP ' + status))}`);
          }

          if (done === funds.length) callback(null, out);
        }
      );
    }, idx * 250);
  });
}

function parseFundGz(fundCode, body) {
  const m = body.match(/jsonpgz\((\{[\s\S]*\})\)/i);
  if (!m) return null;

  try {
    const obj = JSON.parse(m[1]);
    const name = obj.name || ('基金' + fundCode);
    const gsz = toNum(obj.gsz);
    const pct = toNum(obj.gszzl);
    const gztime = obj.gztime || '';

    if (!gsz) return null;

    return {
      type: 'fund',
      market: 'FUND',
      currency: 'CNY',
      name,
      symbol: fundCode,
      fundCode,
      gsz,
      pct,
      gztime,
      jzrq: obj.jzrq || '',
      dwjz: toNum(obj.dwjz),
    };
  } catch (_) {
    return null;
  }
}

/** ---------- 输出 ---------- */
function finish(items) {
  if (!items || !items.length) {
    $notification.post(TITLE, '无数据', '本次未获取到行情数据，请检查网络/节点或代码是否有效。');
    return $done();
  }

  const groups = groupByMarket(items);
  const summary = `A股/指数 ${groups.CN.length} | 港股 ${groups.HK.length} | 美股 ${groups.US.length} | 场外基金 ${groups.FUND.length}`;
  console.log('📣 ' + summary);

  // 先发一个汇总，避免漏看
  $notification.post(TITLE, '汇总', summary);

  // 分组分条推送，避免单条通知被截断
  postGroupNotify('A股/指数', groups.CN || [], formatQuoteShort);
  postGroupNotify('港股', groups.HK || [], formatQuoteShort);
  postGroupNotify('美股', groups.US || [], formatQuoteShort);
  postGroupNotify('场外基金', groups.FUND || [], formatFundShort);

  return $done();
}

function postGroupNotify(groupTitle, list, formatter) {
  if (!list || !list.length) return;
  const MAX = 12;
  const show = list.slice(0, MAX);
  const body = show.map(formatter).join('\n') + (list.length > MAX ? `\n…共${list.length}个，已显示前${MAX}个` : '');
  console.log(`📣【${groupTitle}】\n${body}`);
  $notification.post(TITLE, groupTitle, body);
}

function formatQuoteShort(it) {
  const price0 = formatPrice(it.price, it.currency);
  const price = (it.currency === 'POINT') ? (price0 + ' 点') : price0;
  // 需求：涨跌幅从“昨收”开始计算。
  // 若昨收缺失（极少数返回场景），才回退用“今开”。
  let part = '';
  if (it.yclose && it.yclose > 0) {
    part = `${trendIcon(it.changePctClose)} ${formatSigned(it.changeFromClose, it.currency)} (${formatPct(it.changePctClose)})`;
  } else if (it.open && it.open > 0) {
    part = `${trendIcon(it.changePctOpen)} ${formatSigned(it.changeFromOpen, it.currency)} (${formatPct(it.changePctOpen)}) · 昨收缺失`;
  } else {
    part = `${trendIcon(it.changePctClose)} ${formatSigned(it.changeFromClose, it.currency)} (${formatPct(it.changePctClose)})${it.note ? ' · ' + it.note : ''}`;
  }
  const code = (it.symbol || it.code || '').toUpperCase();
  return `${it.name}${code ? '(' + code + ')' : ''} ${price} · ${part}`;
}

function formatFundShort(it) {
  const pct = (typeof it.pct === 'number') ? formatPct(it.pct) : '--';
  const gsz = (typeof it.gsz === 'number') ? it.gsz.toFixed(4) : String(it.gsz || '');
  return `${it.name || '基金'}(${it.fundCode}) 估值 ${gsz} · ${trendIcon(it.pct)} ${pct}`;
}

function groupByMarket(items) {
  const g = { CN: [], HK: [], US: [], FUND: [] };
  items.forEach(it => {
    if (it.type === 'fund') g.FUND.push(it);
    else if (it.market === 'HK') g.HK.push(it);
    else if (it.market === 'US') g.US.push(it);
    else g.CN.push(it);
  });
  return g;
}

function appendGroup(lines, title, list) {
  if (!list || !list.length) return;
  lines.push(`【${title}】`);
  list.forEach(it => lines.push(formatQuote(it)));
  lines.push('');
}

function appendFundGroup(lines, title, list) {
  if (!list || !list.length) return;
  lines.push(`【${title}】`);
  list.forEach(it => lines.push(formatFund(it)));
  lines.push('');
}

function formatQuote(it) {
  const iconClose = trendIcon(it.changePctClose);

  const price = formatMoney(it.price, it.currency);
  const code = it.symbol;

  const closePart = `较昨收 ${iconClose} ${formatSigned(it.changeFromClose, it.currency)} (${formatPct(it.changePctClose)})`;
  const openInfo = (it.open && it.open > 0) ? `今开 ${formatMoney(it.open, it.currency)}` : (it.note ? it.note : '');
  return `${it.name}(${code}) ${price} · ${closePart}${openInfo ? ' · ' + openInfo : ''}`;
}

function formatFund(it) {
  const pct = it.pct;
  const gsz = it.gsz;
  const s1 = (typeof gsz === 'number') ? gsz.toFixed(4) : String(gsz || '');
  const s2 = (typeof pct === 'number') ? formatPct(pct) : '--';
  const icon = trendIcon(pct);

  const meta = [];
  if (it.gztime) meta.push(it.gztime);
  if (it.jzrq && typeof it.dwjz === 'number') meta.push(`昨日净值(${it.jzrq}) ${it.dwjz.toFixed(4)}`);

  return `${it.name}(${it.fundCode}) 估值 ${s1} · 今日估值 ${icon} ${s2}${meta.length ? ' · ' + meta.join(' · ') : ''}`;
}

/** ---------- 工具函数 ---------- */
const NAME_MAP = {
  'sh000001': '上证指数',
  'sz399001': '深证成指',
  'sz399006': '创业板指',
  'sh000300': '沪深300',
  'sz399905': '中证500',
};

function looksMojibake(s) {
  // 常见 GBK/Latin1 乱码特征：含扩展拉丁字符且不含中日韩字符
  if (!s) return false;
  const hasCJK = /[\u4e00-\u9fff]/.test(s);
  const hasLatin1 = /[\u0080-\u00ff]/.test(s);
  const hasReplacement = /�/.test(s);
  return !hasCJK && (hasLatin1 || hasReplacement);
}

function fixLatin1Gbk(s) {
  // 典型场景：GBK 字节被当作 Latin-1 显示，例如“苹果”->“Æ»¹û”
  if (!s) return '';
  if (/[\u4e00-\u9fff]/.test(s)) return s;
  if (!/[\u0080-\u00ff]/.test(s)) return '';
  try {
    if (typeof TextDecoder === 'undefined') return '';
    const bytes = new Uint8Array(Array.from(s, ch => ch.charCodeAt(0) & 0xff));
    let dec;
    try { dec = new TextDecoder('gb18030'); } catch (_) { dec = new TextDecoder('gbk'); }
    const out = String(dec.decode(bytes) || '').trim();
    if (/[\u4e00-\u9fff]/.test(out)) return out;
  } catch (e) {}
  return '';
}

function safeName(fullCode, nameFromApi, codeFromApi) {
  const key = (fullCode || '').toLowerCase();
  if (NAME_MAP[key]) return NAME_MAP[key];

  const raw = String(nameFromApi || '').trim();
  const symbol = String(codeFromApi || '').trim() || fullCode.replace(/^(sh|sz|bj|hk|us)/i, '');

  // 先尝试纠正乱码
  const fixed = fixLatin1Gbk(raw);
  if (fixed) return fixed;

  // 仍像乱码则退化为 symbol，避免通知出现不可读字符
  if (looksMojibake(raw) && symbol) return symbol;

  return raw || symbol || fullCode;
}


function isIndexFullCode(fullCode) {
  const c = String(fullCode || '').toLowerCase();
  // 常见指数：上证(000001)、深成(399001)、创业板(399006)、沪深300(000300)等
  if (/^(sh000\d{3}|sz399\d{3})$/.test(c)) return true;
  return false;
}

function detectMarket(fullCode, symbol) {
  const c = String(fullCode || '').toLowerCase();
  if (c.startsWith('hk')) return 'HK';
  if (c.startsWith('us')) return 'US';
  return 'CN';
}

function marketCurrency(market) {
  if (market === 'HK') return 'HKD';
  if (market === 'US') return 'USD';
  return 'CNY';
}

function normalizePrimaryKey(fullCode, symbol) {
  const c = String(fullCode || '').toLowerCase();
  if (c.startsWith('us')) return ('us' + normalizeUsSymbol(symbol)).toLowerCase();
  return c;
}

function marketOrder(m) {
  if (m === 'CN') return 1;
  if (m === 'HK') return 2;
  if (m === 'US') return 3;
  if (m === 'FUND') return 4;
  return 9;
}

function toNum(x) {
  const v = parseFloat(String(x || '').trim());
  return isNaN(v) ? 0 : v;
}

function unique(arr) {
  const out = [];
  const seen = {};
  (arr || []).forEach(x => {
    const k = String(x).toLowerCase();
    if (!k || seen[k]) return;
    seen[k] = 1;
    out.push(x);
  });
  return out;
}

function trendIcon(pct) {
  if (typeof pct !== 'number' || isNaN(pct)) return 'ℹ️';
  if (pct > 0) return '📈';
  if (pct < 0) return '📉';
  return '➖';
}

function formatPct(p) {
  if (typeof p !== 'number' || isNaN(p)) return '--';
  const sign = p > 0 ? '+' : '';
  return sign + p.toFixed(2) + '%';
}

function formatPrice(v, currency) {
  if (typeof v !== 'number' || isNaN(v)) return '--';
  if (currency === 'POINT') return v.toFixed(2);
  const abs = Math.abs(v);
  // Most quotes use 2 decimals; for values < 1 (common in funds/FX) show 4 decimals.
  let d = abs < 1 ? 4 : 2;
  if (currency === 'JPY') d = 0;
  return v.toFixed(d);
}


function formatMoney(v, currency) {
  if (typeof v !== 'number' || isNaN(v)) return '--';
  if (currency === 'USD') return '$' + v.toFixed(2);
  if (currency === 'HKD') return 'HK$' + v.toFixed(2);
  return '¥' + v.toFixed(2);
}

function formatSigned(v, currency) {
  if (typeof v !== 'number' || isNaN(v)) return '--';
  const sign = v > 0 ? '+' : (v < 0 ? '-' : '');
  if (currency === 'POINT') return sign + Math.abs(v).toFixed(2);
  if (currency === 'USD') return sign + '$' + Math.abs(v).toFixed(2);
  if (currency === 'HKD') return sign + 'HK$' + Math.abs(v).toFixed(2);
  return sign + '¥' + Math.abs(v).toFixed(2);
}

function formatDateCN(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// 入口
main();
