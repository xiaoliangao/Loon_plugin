/**
 * Loon - GitHub 热点周报（Trending / weekly）
 * 目标：通知不截断 => 拆分多条通知推送
 *
 * 支持的参数（来自 plugin argument 数组）：
 *  [0]=netNode
 *  [1]=githubToken (不用也行；本脚本抓 Trending 网页，不依赖 token)
 *  [2]=githubMinStars
 *  [3]=githubMaxResults
 *  [4]=githubTopics   // 关键词过滤：ai,llm,agent...
 * 可选（如果你在 plugin 里加了更多参数，也支持）：
 *  [5]=githubSince    // daily|weekly|monthly
 *  [6]=githubChunkSize// 每条通知包含几个项目（建议 3-5）
 *  [7]=githubLang     // 语言路径，如 python/javascript；留空=全站
 */

var STORAGE_KEY = "github_hot_pushed_v1";

function parseArgs() {
  var a = $argument;
  if (typeof a === "object" && a) return a;

  // 兼容 query-string 形式
  var s = (typeof a === "string") ? a.trim() : "";
  if (!s) return {};
  var out = {};
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
function pickNode(v) {
  var s = String(v || "").trim();
  if (!s) return "";
  if (/^auto$/i.test(s)) return "";
  return s;
}

function parseTrending(html) {
  var raw = String(html || "");
  var articles = raw.match(/<article[\s\S]*?<\/article>/g) || [];
  var out = [];

  for (var i = 0; i < articles.length; i++) {
    var a = articles[i];

    // repo path: /owner/repo
    var mRepo = a.match(/<h2[^>]*>[\s\S]*?<a[^>]*href="\/([^"]+?)"[^>]*>/i);
    if (!mRepo) continue;
    var full = String(mRepo[1] || "").replace(/\s+/g, "");
    var url = "https://github.com/" + full;

    // desc
    var desc = "";
    var mDesc = a.match(/<p[^>]*>[\s\S]*?<\/p>/i);
    if (mDesc) desc = cleanText(mDesc[0]);

    // total stars（更鲁棒：先抓 stargazers 的 <a>，再清洗取数字）
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

    // stars today/this week/this month
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
    var k = out[j].key;
    if (seen[k]) continue;
    seen[k] = 1;
    uniq.push(out[j]);
  }
  return uniq;
}

function readPushed(cacheKey) {
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
function writePushed(cacheKey, list) {
  var limited = (list || []).filter(Boolean).slice(-300);
  var obj = {};
  try { obj = JSON.parse($persistentStore.read(STORAGE_KEY) || "{}") || {}; } catch (e) {}
  obj[cacheKey] = limited;
  $persistentStore.write(JSON.stringify(obj), STORAGE_KEY);
}

function buildChunkBody(list, startIndex) {
  var lines = [];
  for (var i = 0; i < list.length; i++) {
    var r = list[i];
    var idx = startIndex + i + 1;
    lines.push(idx + ". " + r.full + (r.bump ? ("（" + r.bump + "）") : ""));
    if (r.desc) lines.push("   " + r.desc);
    lines.push("   " + r.url);
    lines.push("");
  }
  return lines.join("\n").trim();
}

function main() {
  var args = parseArgs();

  // 兼容 plugin 传入的数组 argument=[...]
  // Loon 可能把它转成对象 {0:"",1:""...}
  function pick(k, idx, defVal) {
    var v = (args && args[k] !== undefined) ? args[k] : (args && args[String(idx)] !== undefined ? args[String(idx)] : defVal);
    return v === undefined || v === null ? defVal : v;
  }

  var netNode = pick("netNode", 0, "");
  var minStars = toInt(pick("githubMinStars", 2, "0"), 0);
  var maxResults = toInt(pick("githubMaxResults", 3, "15"), 15);
  if (maxResults <= 0) maxResults = 15;

  var kwRaw = pick("githubTopics", 4, "");
  var keywords = splitCsv(kwRaw);

  var since = String(pick("githubSince", 5, "weekly")).trim().toLowerCase();
  if (since !== "daily" && since !== "weekly" && since !== "monthly") since = "weekly";

  var chunkSize = clamp(toInt(pick("githubChunkSize", 6, "4"), 4), 1, 8);

  var langPath = String(pick("githubLang", 7, "")).trim(); // e.g. python
  var url = "https://github.com/trending" + (langPath ? ("/" + encodeURIComponent(langPath)) : "") + "?since=" + encodeURIComponent(since);

  var req = {
    url: url,
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
      $notification.post("❌ GitHub 热点周报失败", "HTTP " + status, url);
      return $done();
    }

    var all = parseTrending(body);

    // 过滤：minStars + keywords
    var filtered = [];
    for (var i = 0; i < all.length; i++) {
      var it = all[i];
      if (it.stars < minStars) continue;
      var hay = (it.full + " " + (it.desc || "")).toLowerCase();
      if (!keywordHit(keywords, hay)) continue;
      filtered.push(it);
    }

    // 限制条数
    var picked = filtered.slice(0, maxResults);

    var cacheKey = "since=" + since + "|lang=" + (langPath || "all") + "|kw=" + keywords.join(",");
    var pushed = readPushed(cacheKey);
    var fresh = [];
    for (var j = 0; j < picked.length; j++) {
      if (pushed.indexOf(picked[j].key) < 0) fresh.push(picked[j]);
    }

    if (!fresh.length) {
      $notification.post("GitHub 热点周报（" + since + "）", "暂无新项目（或均已推送过）", url);
      return $done();
    }

    // 汇总通知（带链接）
    var title = "🔥 GitHub 热点周报（" + since + "）";
    var sub = "抓取 " + all.length + " | 过滤后 " + filtered.length + " | 新推送 " + fresh.length
      + (langPath ? (" | lang " + langPath) : "")
      + (minStars ? (" | minStars " + minStars) : "")
      + (keywords.length ? (" | kw " + keywords.length) : "");
    $notification.post(title, sub, "榜单页：\n" + url);

    // 分块推送，避免截断
    var total = fresh.length;
    var part = 0;
    var newKeys = pushed.slice(0);

    for (var start = 0; start < total; start += chunkSize) {
      part++;
      var chunk = fresh.slice(start, start + chunkSize);
      var partTitle = title + " (" + part + "/" + Math.ceil(total / chunkSize) + ")";
      var bodyText = buildChunkBody(chunk, start);

      $notification.post(partTitle, "Top " + (start + 1) + "-" + (start + chunk.length), bodyText);

      for (var k = 0; k < chunk.length; k++) newKeys.push(chunk[k].key);
    }

    writePushed(cacheKey, newKeys);
    $done();
  });
}

main();
