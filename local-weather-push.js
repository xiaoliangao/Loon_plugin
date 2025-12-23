/**
 * Loon 脚本 - 本地天气推送（区县级）
 *
 * 建议 cron：每天 08:00（设备本地时间）
 *
 * 插件参数（Argument -> 通过 argument=[{...}] 传入）：
 * - qweatherApiKey      必填：和风天气 Key
 * - amapApiKey          必填：高德 Key（IP 定位 + 逆地理）
 * - weatherUseGPS       可选：true/false（更精准，但需 Loon 定位权限）
 * - weatherLocOverride  可选：位置覆盖：
 *                       1) "经度,纬度"（例如 116.4074,39.9042）
 *                       2) 城市/区县名（例如 "深圳 南山"）
 * - netNode             可选：指定请求走某个策略组/节点（AUTO 表示不指定）
 */

async function main() {
  const args = parseArgs();
  const cfg = {
    qKey: String(args.qweatherApiKey || '').trim(),
    // 和风 API Host（2025-04 起推荐使用；用于替代 devapi/api/geoapi 公共域名）
    // 形如：qn2pfyvquw.re.qweatherapi.com
    qHost: normalizeHost(args.qweatherHost),
    amapKey: String(args.amapApiKey || '').trim(),
    useGPS: toBool(args.weatherUseGPS, false),
    override: String(args.weatherLocOverride || '').trim(),
    node: pickNode(args.netNode),
    title: '🌤️ 今日天气',
  };

  try {
    if (!cfg.qKey) throw new Error('缺少和风天气 Key：请在插件设置中填写 qweatherApiKey');
    if (!cfg.amapKey) throw new Error('缺少高德 Key：请在插件设置中填写 amapApiKey');

    const loc = await getUserLocation(cfg);
    const weather = await getWeather(cfg, loc);
    const body = formatWeatherMessage(weather);

    $notification.post(cfg.title, `${loc.city || ''} ${loc.district || ''}`.trim(), body);
  } catch (e) {
    console.log('天气推送失败：', e && (e.stack || e.message || e));
    $notification.post('❌ 天气获取失败', '', (e && e.message) ? e.message : String(e));
  } finally {
    $done();
  }
}

/* ------------------------- 位置 ------------------------- */

async function getUserLocation(cfg) {
  // 1) 覆盖位置优先
  if (cfg.override) {
    const o = parseLonLat(cfg.override);
    if (o) {
      const addr = await reverseGeocode(cfg, o.lon, o.lat);
      return { ...addr, longitude: o.lon, latitude: o.lat };
    }
    // 文本：先尝试用高德地理编码拿到坐标，再逆地理得到区县
    const geo = await geocodeText(cfg, cfg.override);
    if (geo) {
      const addr = await reverseGeocode(cfg, geo.lon, geo.lat);
      return { ...addr, longitude: geo.lon, latitude: geo.lat };
    }
    // 最差情况：直接用文本当城市名
    return { city: cfg.override, district: '', province: '', adcode: '', longitude: '', latitude: '' };
  }

  // 2) GPS（需要权限）
  if (cfg.useGPS && typeof $location !== 'undefined' && $location && $location.latitude && $location.longitude) {
    const { latitude, longitude } = $location;
    const addr = await reverseGeocode(cfg, longitude, latitude);
    return { ...addr, longitude, latitude };
  }

  // 3) IP 定位（默认）
  return await locateByIP(cfg);
}

async function locateByIP(cfg) {
  const url = `https://restapi.amap.com/v3/ip?key=${encodeURIComponent(cfg.amapKey)}`;
  const resp = await httpGet(url, {}, cfg.node);
  if (resp.status !== 200) throw new Error(`高德 IP 定位失败: HTTP ${resp.status}`);

  const data = safeJson(resp.body, {});
  if (String(data.status) !== '1') throw new Error(`高德 API 错误: ${data.info || 'unknown'}`);

  // 高德 IP API 的 rectangle 是一个 bounding box：lon1,lat1;lon2,lat2
  const center = rectangleCenter(data.rectangle);
  if (center) {
    const addr = await reverseGeocode(cfg, center.lon, center.lat);
    return {
      province: data.province || addr.province,
      city: data.city || addr.city,
      district: addr.district || '',
      adcode: addr.adcode || data.adcode || '',
      longitude: center.lon,
      latitude: center.lat,
    };
  }

  // rectangle 不可用时，至少返回 city/province
  return {
    province: data.province || '',
    city: data.city || '',
    district: '',
    adcode: data.adcode || '',
    longitude: '',
    latitude: '',
  };
}

async function reverseGeocode(cfg, lon, lat) {
  const url = `https://restapi.amap.com/v3/geocode/regeo?key=${encodeURIComponent(cfg.amapKey)}&location=${lon},${lat}`;
  const resp = await httpGet(url, {}, cfg.node);
  const data = safeJson(resp.body, {});
  if (String(data.status) !== '1' || !data.regeocode) {
    return { province: '', city: '', district: '', adcode: '' };
  }

  const ac = data.regeocode.addressComponent || {};
  const city = (Array.isArray(ac.city) ? ac.city[0] : ac.city) || ac.province || '';
  return {
    province: ac.province || '',
    city: city,
    district: ac.district || city || '',
    adcode: ac.adcode || '',
  };
}

async function geocodeText(cfg, text) {
  const url = `https://restapi.amap.com/v3/geocode/geo?key=${encodeURIComponent(cfg.amapKey)}&address=${encodeURIComponent(text)}`;
  const resp = await httpGet(url, {}, cfg.node);
  const data = safeJson(resp.body, {});
  if (String(data.status) !== '1' || !data.geocodes || !data.geocodes.length) return null;
  const loc = String(data.geocodes[0].location || '');
  const p = parseLonLat(loc);
  return p ? { lon: p.lon, lat: p.lat } : null;
}

/* ------------------------- 天气 ------------------------- */

async function getWeather(cfg, loc) {
  const locationId = await getQWeatherLocationId(cfg, loc);

  const base = cfg.qHost ? `https://${cfg.qHost}` : 'https://devapi.qweather.com';

  const nowUrl = `${base}/v7/weather/now?location=${encodeURIComponent(locationId)}&key=${encodeURIComponent(cfg.qKey)}`;
  const forecastUrl = `${base}/v7/weather/3d?location=${encodeURIComponent(locationId)}&key=${encodeURIComponent(cfg.qKey)}`;
  const airUrl = `${base}/v7/air/now?location=${encodeURIComponent(locationId)}&key=${encodeURIComponent(cfg.qKey)}`;

  const [nowResp, fcResp, airResp] = await Promise.all([
    httpGet(nowUrl, {}, cfg.node),
    httpGet(forecastUrl, {}, cfg.node),
    httpGet(airUrl, {}, cfg.node),
  ]);

  const nowData = safeJson(nowResp.body, {});
  const fcData = safeJson(fcResp.body, {});
  const airData = safeJson(airResp.body, {});

  if (String(nowData.code) !== '200') throw new Error(`和风天气(实时)错误: ${nowData.code || 'unknown'}`);
  if (String(fcData.code) !== '200') throw new Error(`和风天气(预报)错误: ${fcData.code || 'unknown'}`);
  // 空气质量可能会因为位置不支持返回非 200，这里不强制失败
  const airOk = String(airData.code) === '200';

  return {
    now: nowData.now || {},
    today: (fcData.daily && fcData.daily[0]) ? fcData.daily[0] : {},
    air: (airOk && airData.now) ? airData.now : {},
  };
}

async function getQWeatherLocationId(cfg, loc) {
  // 优先：如果有经纬度，用经纬度 lookup 最准确
  const hasLonLat = loc && loc.longitude && loc.latitude;
  const keyword = hasLonLat ? `${loc.longitude},${loc.latitude}` : (loc.district || loc.city || '');

  // 若配置了 API Host，则按官方迁移要求：/geo/v2/city/lookup
  // 否则兼容旧 GeoAPI 域名：/v2/city/lookup
  const url = cfg.qHost
    ? `https://${cfg.qHost}/geo/v2/city/lookup?location=${encodeURIComponent(keyword)}&key=${encodeURIComponent(cfg.qKey)}`
    : `https://geoapi.qweather.com/v2/city/lookup?location=${encodeURIComponent(keyword)}&key=${encodeURIComponent(cfg.qKey)}`;

  const resp = await httpGet(url, {}, cfg.node);
  const data = safeJson(resp.body, {});
  if (String(data.code) === '200' && data.location && data.location.length > 0) {
    return data.location[0].id;
  }
  throw new Error('和风城市 ID 获取失败：请检查定位/覆盖位置是否正确');
}

function normalizeHost(v) {
  let h = String(v || '').trim();
  if (!h) return '';
  h = h.replace(/^https?:\/\//i, '').replace(/\/+$/g, '');
  return h;
}

/* ------------------------- 文本格式化 ------------------------- */

function formatWeatherMessage(weather) {
  const now = weather.now || {};
  const today = weather.today || {};
  const air = weather.air || {};

  let msg = '';
  msg += `🌡️ 当前: ${now.text || '-'} ${now.temp || '-'}°C\n`;
  msg += `💨 风力: ${now.windDir || '-'} ${now.windScale || '-'}级\n`;
  msg += `💧 湿度: ${now.humidity || '-'}%\n`;

  msg += `\n📅 今日预报:\n`;
  msg += `   ${(today.textDay || '-') } 转 ${(today.textNight || '-')}\n`;
  msg += `   🌡️ ${(today.tempMin || '-') }°C ~ ${(today.tempMax || '-') }°C\n`;

  if (air.category) {
    msg += `\n${getAirQualityEmoji(air.category)} 空气质量: ${air.category} (AQI ${air.aqi || '-'})\n`;
  }

  msg += `\n💡 建议:\n`;
  const uv = toInt(today.uvIndex, 0);
  const precip = parseFloat(String(today.precip || '0'));
  const tempNow = toInt(now.temp, 999);

  if (uv > 7) msg += `   ☀️ 紫外线强，注意防晒\n`;
  if (precip > 0) msg += `   ☔ 可能有雨，记得带伞\n`;
  if (tempNow < 10) msg += `   🧥 气温较低，注意保暖\n`;

  return msg.trim();
}

function getAirQualityEmoji(category) {
  const map = {
    '优': '💚',
    '良': '💛',
    '轻度污染': '🧡',
    '中度污染': '❤️',
    '重度污染': '💜',
    '严重污染': '🖤'
  };
  return map[category] || '🌫️';
}

/* ------------------------- Loon 兼容工具 ------------------------- */

function httpGet(url, headers, node) {
  const effNode = pickNode(node);
  return new Promise((resolve, reject) => {
    $httpClient.get(
      { url, timeout: 15000, node: effNode, headers: headers || {} },
      (err, resp, body) => {
        if (err) return reject(err);
        const status = resp && (resp.status || resp.statusCode) ? (resp.status || resp.statusCode) : 0;
        resolve({ status, headers: resp ? resp.headers : {}, body: body || '' });
      }
    );
  });
}

function parseArgs() {
  if (typeof $argument === 'object' && $argument !== null) return $argument;

  const a = (typeof $argument === 'string') ? $argument.trim() : '';
  if (!a) return {};
  if (a.startsWith('{') && a.endsWith('}')) {
    try { return JSON.parse(a); } catch (_) {}
  }
  if (a.includes('=') && a.includes('&')) return parseQuery(a);
  // 兜底：允许用户只传 override 文本
  return { weatherLocOverride: a };
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

function safeJson(s, def) {
  try { return JSON.parse(s); } catch (_) { return def; }
}

function toBool(v, def) {
  if (typeof v === 'boolean') return v;
  const s = String(v || '').trim().toLowerCase();
  if (!s) return def;
  if (['1', 'true', 'yes', 'y', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(s)) return false;
  return def;
}

function toInt(v, def) {
  const n = parseInt(String(v || '').trim(), 10);
  return Number.isFinite(n) ? n : def;
}

function parseLonLat(s) {
  const m = String(s || '').trim().match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (!m) return null;
  return { lon: m[1], lat: m[2] };
}

function rectangleCenter(rect) {
  // "lon1,lat1;lon2,lat2"
  if (!rect) return null;
  const parts = String(rect).split(';');
  if (parts.length !== 2) return null;
  const p1 = parseLonLat(parts[0]);
  const p2 = parseLonLat(parts[1]);
  if (!p1 || !p2) return null;
  const lon = (parseFloat(p1.lon) + parseFloat(p2.lon)) / 2;
  const lat = (parseFloat(p1.lat) + parseFloat(p2.lat)) / 2;
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  return { lon: String(lon), lat: String(lat) };
}

main();
