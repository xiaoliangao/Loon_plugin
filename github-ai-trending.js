/**
 * Loon 脚本 - GitHub AI 项目周报
 *
 * 建议 cron：每周一 09:00（设备本地时间）
 *
 * 插件参数（Argument -> 通过 argument=[{...}] 传入）：
 * - githubMinStars      最低 stars（默认 100）
 * - githubMaxResults    推送数量（默认 5，建议 3-5）
 * - githubTopics        topics（英文逗号分隔；默认 ai/ml/llm）
 * - githubToken         可选：GitHub PAT（提升 rate limit；支持填 "Bearer xxx"）
 * - netNode             可选：指定请求走某个策略组/节点（AUTO 表示不指定）
 */

const STORAGE_KEY = 'github_ai_pushed_repos_v2';

async function main() {
  const args = parseArgs();
  const cfg = {
    minStars: toInt(args.githubMinStars, 100),
    maxResults: clamp(toInt(args.githubMaxResults, 5), 1, 10),
    topics: splitCsv(args.githubTopics || 'artificial-intelligence,machine-learning,deep-learning,llm,gpt'),
    token: String(args.githubToken || '').trim(),
    title: '📊 本周 AI 项目精选',
    node: pickNode(args.netNode),
  };

  try {
    const since = formatDateYYYYMMDD(daysAgo(7));
    const pushed = getPushedRepoIds();

    const repos = await searchRepos({
      since,
      topics: cfg.topics,
      minStars: cfg.minStars,
      token: cfg.token,
      node: cfg.node,
    });

    console.log(`DEBUG repos.length=${repos.length}`);
    console.log(`DEBUG pushed.length=${pushed.length}`);


    const fresh = repos.filter(r => !pushed.includes(r.id));
    if (fresh.length === 0) {
      console.log('GitHub 周报：暂无新项目（或均已推送过）');
      return;
    }

    const picked = fresh.slice(0, cfg.maxResults);
    const body = formatMessage(picked);

    $notification.post(cfg.title, `发现 ${fresh.length} 个候选，推送 ${picked.length} 个`, body);

    updatePushedRepoIds(pushed, picked.map(r => r.id));
  } catch (e) {
    console.log('GitHub 周报失败：', e && (e.stack || e.message || e));
    $notification.post('❌ GitHub 周报失败', '', (e && e.message) ? e.message : String(e));
  } finally {
    $done();
  }
}

async function searchRepos({ since, topics, minStars, token, node }) {
  // 说明：
  // 1) GitHub 搜索语法建议用 created:>=YYYY-MM-DD（你原脚本用 created:YYYY-MM-DD 容易变成“仅当天”）
  // 2) topic 组合建议加括号，避免和 stars/created 的优先级产生歧义
  const topicQuery = topics
    .map(t => `topic:${t.trim()}`)
    .filter(Boolean)
    .join(' OR ');
  const q = `(${topicQuery}) stars:>=${minStars} created:>=${since}`;
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=30`;

  const headers = {
    'User-Agent': 'LoonScript/GitHubWeekly/1.0',
    'Accept': 'application/vnd.github+json',
  };
  if (token) headers['Authorization'] = token.includes(' ') ? token : `Bearer ${token}`;

  const resp = await httpGet(url, headers, node);
  if (resp.status !== 200) {
    throw new Error(`GitHub API 请求失败: HTTP ${resp.status}`);
  }

  const data = safeJson(resp.body, {});
  const items = Array.isArray(data.items) ? data.items : [];
  return items.map(item => ({
    id: item.id,
    name: item.full_name,
    description: item.description || '暂无描述',
    stars: item.stargazers_count,
    url: item.html_url,
    language: item.language || '未知',
  }));
}

function formatMessage(repos) {
  // 通知正文太长容易被系统截断；这里控制每个项目 2-3 行
  let out = '';
  repos.forEach((r, i) => {
    out += `${i + 1}. ${r.name}  ⭐${r.stars}  | ${r.language}\n`;
    out += `   ${trimTo(r.description, 70)}\n`;
    out += `   ${r.url}\n\n`;
  });
  return out.trim();
}

function getPushedRepoIds() {
  const s = $persistentStore.read(STORAGE_KEY);
  if (!s) return [];
  try {
    const arr = JSON.parse(s);
    return Array.isArray(arr) ? arr : [];
  } catch (_) {
    return [];
  }
}

function updatePushedRepoIds(oldList, newIds) {
  const combined = [...oldList, ...newIds].filter(Boolean);
  const limited = combined.slice(-200); // 保留最近 200 个，避免长期重复
  $persistentStore.write(JSON.stringify(limited), STORAGE_KEY);
}

/* ------------------------- Loon 兼容工具 ------------------------- */

function httpGet(url, headers, node) {
  const effNode = pickNode(node);
  return new Promise((resolve, reject) => {
    $httpClient.get(
      {
        url,
        timeout: 15000,
        node: effNode,
        headers: headers || {},
      },
      (err, resp, body) => {
        if (err) return reject(err);
        const status = resp && (resp.status || resp.statusCode) ? (resp.status || resp.statusCode) : 0;
        resolve({ status, headers: resp ? resp.headers : {}, body: body || '' });
      }
    );
  });
}

function parseArgs() {
  // 插件 argument=[{a},{b}] 时，$argument 是对象：可用 $argument.a 访问
  if (typeof $argument === 'object' && $argument !== null) return $argument;

  const a = (typeof $argument === 'string') ? $argument.trim() : '';
  if (!a) return {};

  // JSON
  if (a.startsWith('{') && a.endsWith('}')) {
    try { return JSON.parse(a); } catch (_) {}
  }
  // query-string
  if (a.includes('=') && a.includes('&')) return parseQuery(a);
  // 兜底：允许用户只填 topics
  return { githubTopics: a };
}

function parseQuery(qs) {
  const out = {};
  qs.split('&').forEach(kv => {
    const [k, v] = kv.split('=');
    if (!k) return;
    out[decodeURIComponent(k)] = decodeURIComponent(v || '');
  });
  return out;
}

function pickNode(prefer) {
  const p = String(prefer || '').trim();
  if (p && !/^auto$/i.test(p)) return p;
  try {
    if (typeof $config !== 'undefined' && $config.getConfig) {
      const cfg = $config.getConfig();
      const cand = cfg.global_proxy || cfg.final;
      if (cand) return cand;
    }
  } catch (_) {}
  return undefined;
}

function splitCsv(s) {
  return String(s || '')
    .split(',')
    .map(x => x.trim())
    .filter(Boolean);
}

function toInt(v, def) {
  const n = parseInt(String(v || '').trim(), 10);
  return Number.isFinite(n) ? n : def;
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function safeJson(s, def) {
  try { return JSON.parse(s); } catch (_) { return def; }
}

function trimTo(s, maxLen) {
  const str = String(s || '');
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + '…';
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

function formatDateYYYYMMDD(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

main();
