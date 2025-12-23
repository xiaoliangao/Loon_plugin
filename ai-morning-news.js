/**
 * AI 技术早报（AICPB 版）
 *
 * 目标：
 * - 直接抓取 https://www.aicpb.com/news 的“每日AI早报”条目，以“早报列表”形式推送
 * - 重点筛选：DeepSeek / Gemini / GPT / Grok / Claude 等大模型动态，以及 Agent / RAG / MCP / 工具调用等前沿技术
 *
 * 参数（cron argument，建议用双引号包裹）：
 *   node=节点选择              // 可选：强制该脚本请求走指定策略组/节点（解决国内直连超时）
 *   max=8                      // 可选：最多推送条数（默认 8）
 *   kw=deepseek,gpt,gemini,... // 可选：自定义关键词（英文逗号分隔）
 *
 * 示例：
 *   argument="node=节点选择&max=10"
 *
 * 说明：
 * - 如果抓取失败，会尝试读取缓存并推送“缓存版早报”
 */
function formatDateCN(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

const TITLE = formatDateCN(new Date()) + ' 的奏折';
const SOURCE_URLS = [
  'https://r.jina.ai/https://www.aicpb.com/news',
  'https://r.jina.ai/https://www.aicpb.cn/news',

  'https://www.aicpb.com/news',
  'https://www.aicpb.cn/news',
];

const DEFAULT_MAX = 8;
const DEFAULT_TIMEOUT_MS = 15000; // 注意：$httpClient timeout 单位通常为毫秒

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

function pickEffectiveAiArgs(args) {
  const nodeArg = (args && (args.node || args.netNode)) || '';
  const maxArg = (args && args.max) || '';
  const kwArg = (args && args.kw) || '';

  const node = (!nodeArg || isPlaceholder(nodeArg)) ? readUI('netNode', '') : String(nodeArg);
  const max = (!maxArg || isPlaceholder(maxArg)) ? readUI('aiMax', '') : String(maxArg);
  const kw = (!kwArg || isPlaceholder(kwArg)) ? readUI('aiKw', '') : String(kwArg);

  return { node: node.trim(), max: max.trim(), kw: kw.trim() };
}

const CACHE_KEY = 'aicpb_daily_news_cache_v1';

// 默认关键词（可用 kw=... 覆盖）
const DEFAULT_KW = [
  // 模型/厂商
  'deepseek', 'gemini', 'gpt', 'grok', 'claude', 'qwen', 'llama', 'mistral', 'kimi', 'minimax', 'glm', 'openai', 'anthropic',
  // 技术路线
  'agent', 'rag', 'retrieval', 'mcp', 'tool', 'function', 'workflow', 'orchestration', 'planner', 'memory', 'vector',
  // 推理/框架/生态
  'vllm', 'transformers', 'llama.cpp', 'langchain', 'langgraph', 'llamaindex', 'autogen', 'crew', 'sw e-bench', 'bench'
];

function nowISO() {
  try { return new Date().toISOString(); } catch (_) { return '' }
}

function parseQueryString(qs) {
  const out = {};
  if (!qs) return out;
  const s = String(qs).replace(/^\?/, '');
  for (const part of s.split('&')) {
    if (!part) continue;
    const idx = part.indexOf('=');
    if (idx === -1) {
      out[decodeURIComponent(part)] = '';
      continue;
    }
    const k = decodeURIComponent(part.slice(0, idx));
    const v = decodeURIComponent(part.slice(idx + 1));
    out[k] = v;
  }
  return out;
}

function parseArgs() {
  // Loon cron argument 一般为 string，但这里也兼容 object（不同实现/插件可能有差异）
  if (typeof $argument === 'object' && $argument) {
    return {
      node: $argument.node || $argument.netNode || '',
      max: $argument.max || $argument.aiMax || '',
      kw: $argument.kw || $argument.aiKw || ''
    };
  }
  const a = (typeof $argument === 'string' ? $argument.trim() : '');
  // 1) query-string
  if (a.includes('=') && a.includes('&')) return parseQueryString(a);
  // 2) 单个键值对
  if (a.includes('=') && !a.includes('&')) return parseQueryString(a);
  // 3) 直接传 node 名称
  return { node: a };
}

function toInt(x, defVal) {
  const n = parseInt(String(x), 10);
  return Number.isFinite(n) ? n : defVal;
}

function normalizeKwList(kw) {
  const list = (kw && String(kw).trim())
    ? String(kw).split(',').map(s => s.trim()).filter(Boolean)
    : DEFAULT_KW;
  return list.map(s => s.toLowerCase());
}

function httpGet(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const req = {
      url,
      timeout: opts.timeout || DEFAULT_TIMEOUT_MS,
      headers: Object.assign({
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Connection': 'close',
        'Accept-Encoding': 'gzip, deflate',
      }, opts.headers || {}),
    };
    if (opts.node) req.node = opts.node;

    $httpClient.get(req, (err, resp, body) => {
      if (err) return reject(err);
      const status = resp && resp.status ? resp.status : 0;
      if (status >= 400 || !body) return reject(new Error(`HTTP ${status || 'ERR'}`));
      resolve(String(body));
    });
  });
}

function extractDateAndReportUrl(text, fallbackUrl) {
  const raw = String(text || '');
  const isCn = /aicpb\.cn/.test(String(fallbackUrl)) || /aicpb\.cn/.test(raw);
  const base = isCn ? "https://www.aicpb.cn" : "https://www.aicpb.com";

  // 兼容 HTML：href="/news/YYYY-MM-DD"
  // 兼容 Markdown（r.jina.ai）：(https://www.aicpb.com/news/YYYY-MM-DD)
  const m = raw.match(/\/news\/(\d{4}-\d{2}-\d{2})/);
  if (m) {
    const dateDash = m[1];
    return { dateDash, dateLabel: dateDash.replace(/-/g, '.'), reportUrl: `${base}/news/${dateDash}`, base };
  }

  // 兜底：如果页面本身就是日期页
  const m2 = String(fallbackUrl || '').match(/\/news\/(\d{4}-\d{2}-\d{2})/);
  if (m2) {
    const dateDash = m2[1];
    return { dateDash, dateLabel: dateDash.replace(/-/g, '.'), reportUrl: `${base}/news/${dateDash}`, base };
  }

  return { dateDash: '', dateLabel: '', reportUrl: fallbackUrl, base };
}

function absolutizeUrl(href, base) {
  const h = String(href || '').trim();
  if (!h) return '';
  if (/^https?:\/\//i.test(h)) return h;
  if (h.startsWith('/')) return (base || '') + h;
  return h;
}

function extractItems(text, base) {
  const raw = String(text || '');
  const items = [];

  // 1) 解析 Markdown（r.jina.ai 常见格式）：[1 . 标题](链接)
  const mdRe = /\[(\d+)\s*\.\s*([\s\S]*?)\]\((https?:\/\/[^\)]+)\)/g;
  let m;
  while ((m = mdRe.exec(raw)) !== null) {
    const idx = m[1];
    const t = String(m[2] || '').replace(/\s+/g, ' ').trim();
    const u = absolutizeUrl(m[3], base);
    if (!t || t.length < 6) continue;
    items.push({ n: idx, text: t, url: u });
  }

  // 2) 解析 HTML：>1 . xxx。</a>
  if (!items.length) {
    // 尽量抓到 href：<a href="...">1 . xxx</a>
    const reA = /<a[^>]*href=["']([^"']+)["'][^>]*>\s*(\d+)\s*\.\s*([^<]+?)\s*<\/a>/gi;
    while ((m = reA.exec(raw)) !== null) {
      const href = m[1];
      const idx = m[2];
      const t = String(m[3] || '').replace(/\s+/g, ' ').trim();
      const u = absolutizeUrl(href, base);
      if (!t || t.length < 6) continue;
      items.push({ n: idx, text: t, url: u });
    }
  }

  // 去重（同文本）
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const key = it.text;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

function splitByKeywords(items, kwList) {
  const focus = [];
  const rest = [];
  for (const it of items) {
    const t = String(it.text || '').toLowerCase();
    if (kwList.some(k => t.includes(k))) focus.push(it);
    else rest.push(it);
  }
  return { focus, rest };
}

function buildSummaryBody(focusCount, total, focusPushed, otherShown, reportUrl) {
  const lines = [];
  lines.push(`重点命中：${focusCount} / ${total}`);
  if (focusPushed > 0) lines.push(`重点已分条推送：${focusPushed} 条`);
  if (otherShown && otherShown.length) {
    lines.push('');
    lines.push('其他：');
    for (let i = 0; i < otherShown.length; i++) {
      lines.push(`${i + 1}. ${otherShown[i].text}`);
    }
  }
  return lines.join('\n');
}

function notify(title, subtitle, body, openUrl) {
  // attach 支持 openurl（Loon 文档常见写法为 open-url/openUrl，做双写兜底）
  const attach = openUrl ? { 'open-url': openUrl, openUrl } : undefined;
  $notification.post(title, subtitle, body, attach);
}

function readCache() {
  try {
    const v = $persistentStore.read(CACHE_KEY);
    if (!v) return null;
    return JSON.parse(v);
  } catch (_) {
    return null;
  }
}

function writeCache(obj) {
  try {
    $persistentStore.write(JSON.stringify(obj), CACHE_KEY);
  } catch (_) {}
}

async function main() {
  const args = parseArgs();
  const eff = pickEffectiveAiArgs(args);
  const nodeRaw = (eff.node || "").trim();
  // UI 下拉默认值为 AUTO：表示不指定脚本请求策略，交由 Loon 默认策略处理
  const node = /^auto$/i.test(nodeRaw) ? "" : nodeRaw;
  const max = toInt(eff.max, DEFAULT_MAX);
  const kwList = normalizeKwList(eff.kw);

  console.log(`🚀 开始获取 AI 技术早报（AICPB）`);
  console.log(`📋 插件设置: node=${readUI("netNode","") || "(空)"} max=${readUI("aiMax","") || "(默认)"} kw=${readUI("aiKw","") ? "custom" : "default"}`);
  console.log(`📌 生效参数: node=${node || "(auto)"} max=${max} kw=${eff.kw ? "custom" : "default"}`);

  let lastErr = null;
  for (const url of SOURCE_URLS) {
    try {
      const html = await httpGet(url, { node });
      const { dateDash, dateLabel, reportUrl, base } = extractDateAndReportUrl(html, url);
      const items = extractItems(html, base);

      if (!items.length) throw new Error('No items parsed');

      const { focus, rest } = splitByKeywords(items, kwList);
      const focusToPush = focus.slice(0, max);
      const otherToShow = rest.slice(0, Math.max(0, max - focusToPush.length));

      const title = (dateDash || formatDateCN(new Date())) + ' 的奏折';
      const subtitle = `AI 技术早报 · 重点 ${focus.length} / ${items.length}`;
      const body = buildSummaryBody(focus.length, items.length, focusToPush.length, otherToShow, reportUrl);

      writeCache({ ts: nowISO(), title, subtitle, body, reportUrl });

      // 1) 先发汇总
      notify(title, subtitle, body, reportUrl);

      // 2) 重点命中分条推送（像股票分组一样，避免单条过长）
      if (focusToPush.length) {
        focusToPush.forEach((it, idx) => {
          const sub = `AI 早报重点 ${idx + 1} / ${focusToPush.length}`;
          // 分条通知正文不再附带链接（点击通知会通过 openUrl 跳转）
          const b = `${it.text}`;
          notify(title, sub, b, it.url || reportUrl);
        });
      }

      console.log(`✅ 成功：重点分条 ${focusToPush.length} 条（命中 ${focus.length} / ${items.length}）`);
      $done();
      return;
    } catch (e) {
      lastErr = e;
      console.log(`❌ ${url}: ${String(e)}`);
    }
  }

  console.log(`⚠️ 全部源失败，尝试读取缓存`);
  const cache = readCache();
  if (cache && cache.body) {
    notify(cache.title || TITLE, cache.subtitle || 'AI 技术早报 · 缓存', cache.body, cache.reportUrl);
    console.log(`✅ 已推送缓存`);
  } else {
    notify(TITLE, 'AI 技术早报 · 获取失败', `请求超时或网络不可达。\n建议在插件参数 netNode 填写可用的出海策略组，例如“节点选择”。\n\n最后错误：${String(lastErr || '')}`, 'https://www.aicpb.com/news');
  }
  $done();
}

main().catch(err => {
  console.log(`❌ 未捕获异常: ${String(err)}`);
  $done();
});
