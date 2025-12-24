/**
 * Loon - GitHub 热点周报（Trending, weekly）
 * - 数据源：GitHub Trending 网页（不依赖 Token）
 * - 解决通知截断：每个项目单独推送
 *
 * 插件 argument（数组）约定：
 *  [0] netNode         可选：策略组/节点（AUTO 表示不指定）
 *  [1] githubMaxResults 推送数量（建议 8-15）
 *  [2] githubKeywords   关键词过滤（可选）：ai,llm,agent,rag；留空=不过滤
 *  [3] githubSince     daily|weekly|monthly（决定推送频率，也决定Trending源 since）
 */

var STORAGE_KEY = "github_trending_pushed_v1";

function parseArgs() {
  if (typeof $argument === "object" && $argument) return $argument;
  var s = (typeof $argument === "string") ? $argument.trim() : "";
  if (!s) return {};
  var out = {};
  // 兼容 query-string（手动测试时可用）
  if (s.indexOf("=") >= 0) {
    var parts = s.split("&");
    for (var i = 0; i < parts.length; i++) {
      var kv = parts[i];
      if (!kv) continue;
      var idx = kv.indexOf("=");
      if (idx < 0) out[decodeURIComponent(kv)] = "";
      else out[decodeURIComponent(kv.slice(0, idx))] = decodeURIComponent(kv.slice(idx + 1));
    }
    return out;
  }
  return { githubKeywords: s };
}

function pickFromArgs(args, key, idx, defVal) {
  if (args && args[key] !== undefined) return args[key];
  if (args && args[String(idx)] !== undefined) return args[String(idx)];
  return defVal;
}

function pickNode(v) {
  var s = String(v || "").trim();
  if (!s) return "";
  if (/^auto$/i.test(s)) return "";
  return s;
}

function toInt(v, defVal) {
  var n = parseInt(String(v || "").replace(/,/g, "").trim(), 10);
  return isFinite(n) ? n : defVal;
}

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

function splitCsv(s) {
  var arr = String(s || "").split(",");
  var out = [];
  for (var i = 0; i < arr.length; i++) {
    var x = String(arr[i] || "").trim();
    if (x) out.push(x.toLowerCase());
  }
  return out;
}

function trimTo(s, maxLen) {
  var str = String(s || "").replace(/\s+/g, " ").trim();
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + "…";
}

function cleanText(html) {
  return String(html || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function keywordHit(keywords, hayLower) {
  if (!keywords || !keywords.length) return true;
  var h = String(hayLower || "").toLowerCase();
  for (var i = 0; i < keywords.length; i++) {
    var k = String(keywords[i] || "").trim().toLowerCase();
    if (!k) continue;
    if (h.indexOf(k) >= 0) return true;
  }
  return false;
}

function parseTrending(html) {
  var raw = String(html || "");
  var articles = raw.match(/<article[\s\S]*?<\/article>/g) || [];
  var out = [];

  for (var i = 0; i < articles.length; i++) {
    var a = articles[i];

    // repo: /owner/repo
    var mRepo = a.match(/<h2[^>]*>[\s\S]*?<a[^>]*href="\/([^"]+?)"[^>]*>/i);
    if (!mRepo) continue;
    var full = String(mRepo[1] || "").replace(/\s+/g, "");
    var url = "https://github.com/" + full;

    // desc
    var desc = "";
    var mDesc = a.match(/<p[^>]*>[\s\S]*?<\/p>/i);
    if (mDesc) desc = cleanText(mDesc[0]);

    // total stars（抓 stargazers 的 <a> 再抽数字）
    var stars = 0;
    var mStarA = a.match(/<a[^>]*href="\/[^"]+\/stargazers"[\s\S]*?<\/a>/i);
    if (mStarA) {
      var starText = cleanText(mStarA[0]);
      var mNum = starText.match(/([\d,]+)/);
      if (mNum) stars = toInt(mNum[1], 0);
    }

    // language
    var lang = "";
    var mLang = a.match(/itemprop="programmingLanguage"[^>]*>\s*([^<]+)\s*</i);
    if (mLang) lang = String(mLang[1] || "").trim();

    // bump: stars today / this week / this month
    var bump = "";
    var mBump = a.match(/([\d,]+)\s+stars\s+(today|this\s+week|this\s+month)/i);
    if (mBump) bump = String(mBump[1] || "") + " stars " + String(mBump[2] || "").replace(/\s+/g, " ");

    out.push({
      key: full.toLowerCase(),
      full: full,
      url: url,
      desc: desc,
      stars: stars,
      lang: lang,
      bump: bump
    });
  }

  // 去重
  var seen = {};
  var uniq = [];
  for (var j = 0; j < out.length; j++) {
    var k = uniqKey(out[j]);
    if (seen[k]) continue;
    seen[k] = 1;
    uniq.push(out[j]);
  }
  return uniq;
}

function uniqKey(item) {
  return String(item && item.key ? item.key : "").toLowerCase();
}

function readCache(cacheKey) {
  var raw = $persistentStore.read(STORAGE_KEY);
  if (!raw) return [];
  try {
    var obj = JSON.parse(raw);
    var arr = obj && obj[cacheKey];
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];
  }
}

function writeCache(cacheKey, list) {
  var limited = (list || []).filter(Boolean).slice(-300);
  var obj = {};
  try { obj = JSON.parse($persistentStore.read(STORAGE_KEY) || "{}") || {}; } catch (e) {}
  obj[cacheKey] = limited;
  $persistentStore.write(JSON.stringify(obj), STORAGE_KEY);
}

function main() {
  var args = parseArgs();

  var netNode = pickFromArgs(args, "netNode", 0, "");
  var maxResults = clamp(toInt(pickFromArgs(args, "githubMaxResults", 1, "10"), 10), 1, 30);
  var keywords = splitCsv(pickFromArgs(args, "githubKeywords", 2, ""));

  var since = String(pickFromArgs(args, "githubSince", 3, "weekly")).trim().toLowerCase();
  if (since !== "daily" && since !== "weekly" && since !== "monthly") since = "weekly";
  
  // 可选：手动测试用 force=1 绕过日期限制（不影响插件定时）
  var force = String(pickFromArgs(args, "force", 99, "")).trim();
  
  var now = new Date();
  if (force !== "1") {
    // weekly：每周一（getDay(): 0=周日, 1=周一, ...）
    if (since === "weekly" && now.getDay() !== 1) return $done();
    // monthly：每月1号
    if (since === "monthly" && now.getDate() !== 1) return $done();
  }
  var trendingUrl = "https://github.com/trending?since=" + encodeURIComponent(since);

  var req = {
    url: trendingUrl,
    timeout: 20000,
    headers: {
      "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8"
    }
  };

  var node = pickNode(netNode);
  if (node) req.node = node;

  $httpClient.get(req, function (err, resp, body) {
    if (err) {
      $notification.post("❌ GitHub 热点周报失败", "", String(err));
      return $done();
    }
    var status = (resp && (resp.status || resp.statusCode)) ? (resp.status || resp.statusCode) : 0;
    if (status !== 200) {
      $notification.post("❌ GitHub 热点周报失败", "HTTP " + status, trendingUrl);
      return $done();
    }

    var all = parseTrending(body);

    // 关键词过滤
    var filtered = [];
    for (var i = 0; i < all.length; i++) {
      var it = all[i];
      var hay = (it.full + " " + (it.desc || "")).toLowerCase();
      if (!keywordHit(keywords, hay)) continue;
      filtered.push(it);
    }

    var cacheKey = "since=" + since + "|kw=" + keywords.join(",");
    var pushed = readCache(cacheKey);

    var fresh = [];
    for (var j = 0; j < filtered.length; j++) {
      if (pushed.indexOf(filtered[j].key) < 0) fresh.push(filtered[j]);
    }
    fresh = fresh.slice(0, maxResults);

    if (!fresh.length) {
      $notification.post("GitHub 热点(" + since + ")", "暂无新项目（或均已推送过）", trendingUrl);
      return $done();
    }

    // 先发一条总览（带榜单链接）
    var overviewSub = "新推送 " + fresh.length + " | 展示 " + maxResults + (keywords.length ? (" | kw " + keywords.length) : "");
    $notification.post("🔥 GitHub 热点(" + since + ")", overviewSub, "榜单页：\n" + trendingUrl);

    // 每个项目单独通知：避免 iOS 截断
    var newKeys = pushed.slice(0);
    for (var k = 0; k < fresh.length; k++) {
      var r = fresh[k];
      var sub = (k + 1) + "/" + fresh.length + "  ⭐" + r.stars + (r.bump ? ("（" + r.bump + "）") : "") + " | " + (r.lang || "Unknown");
      var bodyText = trimTo(r.desc || "暂无描述", 160) + "\n" + r.url;

      $notification.post("🔥 GitHub 热点(" + since + ")", sub, bodyText, { "open-url": r.url, openUrl: r.url });

      newKeys.push(r.key);
    }

    writeCache(cacheKey, newKeys);
    $done();
  });
}

main();
