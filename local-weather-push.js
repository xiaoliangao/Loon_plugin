/**
 * Loon脚本 - 本地天气推送
 * Cron: 0 8 * * *
 */

// ============ 配置区域 ============
const CONFIG = {
  weatherApiKey: 'HE2208311053331687',
  amapApiKey: '2332287723c1a6b0d33d38c30976ab86',

  notificationTitle: '🌤️ 今日天气',

  // 是否使用Loon的GPS定位（更精准但需要权限）
  useGPS: true,

  // 可选：位置覆盖（不做设置项，你手动改这里）
  // 支持两种格式：
  // 1) "116.41,39.92"（经度,纬度）
  // 2) "上海市 浦东新区"（文本，走高德地理编码）
  locationOverride: ""
};

// ============ 和风 API Host（专属域名） ============
const QWEATHER_HOST = 'qn2pfyvquw.re.qweatherapi.com';

// ============ HTTP 封装（兼容 Loon：使用 $httpClient） ============
function httpGet(options) {
  return new Promise((resolve, reject) => {
    if (typeof $httpClient === 'undefined') {
      reject(new Error("Can't find variable: $httpClient (请确认在 Loon 环境运行)"));
      return;
    }
    const opts = typeof options === 'string' ? { url: options } : options;
    $httpClient.get(opts, (err, resp, body) => {
      if (err) return reject(err);
      const status = resp && (resp.status || resp.statusCode) ? (resp.status || resp.statusCode) : 0;
      resolve({
        status,
        headers: (resp && resp.headers) || {},
        body: body || ''
      });
    });
  });
}

function safeJsonParse(text, fallback = null) {
  try { return JSON.parse(text); } catch (_) { return fallback; }
}

function bodyPreview(body, n = 180) {
  if (!body) return '';
  const s = String(body).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '...' : s;
}

function isLonLat(str) {
  if (!str || typeof str !== 'string') return false;
  const parts = str.split(',').map(s => s.trim());
  if (parts.length !== 2) return false;
  const lon = Number(parts[0]), lat = Number(parts[1]);
  return Number.isFinite(lon) && Number.isFinite(lat) && Math.abs(lon) <= 180 && Math.abs(lat) <= 90;
}

// 解析高德 rectangle（"lon1,lat1;lon2,lat2"）并取中心点
function getRectangleCenter(rectangle) {
  try {
    const [p1, p2] = rectangle.split(';');
    const [lon1, lat1] = p1.split(',').map(Number);
    const [lon2, lat2] = p2.split(',').map(Number);
    if ([lon1, lat1, lon2, lat2].some((v) => Number.isNaN(v))) return null;
    return { longitude: String((lon1 + lon2) / 2), latitude: String((lat1 + lat2) / 2) };
  } catch (e) {
    return null;
  }
}

async function main() {
  try {
    const location = await getUserLocation();

    const subtitle = `${location.city || ''}${location.district ? ' ' + location.district : ''}（${location.source}）`;
    const weather = await getWeather(location);

    const message = formatWeatherMessage(weather);

    $notification.post(CONFIG.notificationTitle, subtitle, message);

  } catch (error) {
    console.log('天气推送失败:', error && error.stack ? error.stack : String(error));
    $notification.post('❌ 天气获取失败', '', error.message || String(error));
  } finally {
    $done();
  }
}

/**
 * 获取用户位置（尽量拿到经纬度）
 */
async function getUserLocation() {
  // 0) 手动覆盖优先
  if (CONFIG.locationOverride && String(CONFIG.locationOverride).trim()) {
    return await getLocationByOverride(String(CONFIG.locationOverride).trim());
  }

  // 1) GPS 优先（但失败会回退）
  if (CONFIG.useGPS && typeof $location !== "undefined" && $location) {
    try {
      const gps = await getLocationByGPS();
      gps.source = 'GPS';
      return gps;
    } catch (e) {
      console.log(`GPS不可用，回退IP定位：${e.message || e}`);
    }
  }

  // 2) IP 定位
  const ip = await getLocationByIP();
  ip.source = 'IP';
  return ip;
}

async function getLocationByOverride(override) {
  if (isLonLat(override)) {
    const [lon, lat] = override.split(',').map(s => s.trim());
    const info = await getDetailedLocation(lon, lat);
    return {
      province: info.province || '',
      city: info.city || '',
      district: info.district || '',
      adcode: info.adcode || '',
      longitude: lon,
      latitude: lat,
      source: '覆盖'
    };
  }

  // 文本 -> 高德地理编码 -> 坐标 -> 逆地理补全区县
  const geo = await geocodeByAddress(override);
  if (!geo) throw new Error('位置覆盖解析失败：请填写 "经度,纬度" 或可识别的城市/区县文本');

  const info = await getDetailedLocation(geo.longitude, geo.latitude);
  return {
    province: info.province || '',
    city: info.city || '',
    district: info.district || '',
    adcode: info.adcode || '',
    longitude: geo.longitude,
    latitude: geo.latitude,
    source: '覆盖'
  };
}

/**
 * 通过IP获取位置
 */
async function getLocationByIP() {
  const url = `https://restapi.amap.com/v3/ip?key=${CONFIG.amapApiKey}`;
  const response = await httpGet({ url });

  if (response.status !== 200) {
    throw new Error(`位置获取失败：高德IP HTTP ${response.status} body=${bodyPreview(response.body)}`);
  }

  const data = safeJsonParse(response.body, {});
  if (data.status !== '1') {
    throw new Error(`高德IP定位错误: ${data.info || 'unknown'} body=${bodyPreview(response.body)}`);
  }

  const province = data.province || '';
  const cityRaw = data.city || '';
  const city = (cityRaw === '[]' || cityRaw === '[""]') ? '' : cityRaw;

  let longitude = '';
  let latitude = '';

  if (data.rectangle) {
    const center = getRectangleCenter(data.rectangle);
    if (center) {
      longitude = center.longitude;
      latitude = center.latitude;
    }
  }

  // 没 rectangle 时，用地理编码兜底（精度仍然只是“城市中心点”）
  if (!longitude || !latitude) {
    const addr = city ? `${province}${city}` : province;
    const geo = await geocodeByAddress(addr);
    if (geo) {
      longitude = geo.longitude;
      latitude = geo.latitude;
    }
  }

  // 逆地理补全区县
  let district = city || province || '未知';
  let finalCity = city || province || '未知';

  if (longitude && latitude) {
    const info = await getDetailedLocation(longitude, latitude);
    district = info.district || district;
    finalCity = info.city || finalCity;
  }

  return {
    province,
    city: finalCity,
    district,
    adcode: data.adcode || '',
    longitude,
    latitude
  };
}

async function geocodeByAddress(addressText) {
  if (!addressText) return null;
  const url = `https://restapi.amap.com/v3/geocode/geo?key=${CONFIG.amapApiKey}&address=${encodeURIComponent(addressText)}`;
  const resp = await httpGet({ url });

  if (resp.status !== 200) return null;
  const data = safeJsonParse(resp.body, {});
  if (data.status !== '1' || !data.geocodes || !data.geocodes.length) return null;

  const loc = data.geocodes[0].location; // "lon,lat"
  if (!loc || typeof loc !== 'string' || !loc.includes(',')) return null;
  const [lon, lat] = loc.split(',');
  return { longitude: lon, latitude: lat };
}

/**
 * 获取详细地理信息（精确到区县）
 */
async function getDetailedLocation(lon, lat) {
  const url = `https://restapi.amap.com/v3/geocode/regeo?key=${CONFIG.amapApiKey}&location=${lon},${lat}&extensions=base`;
  const resp = await httpGet({ url });

  if (resp.status !== 200) return { city: '', district: '未知' };

  const data = safeJsonParse(resp.body, {});
  if (data.status === '1' && data.regeocode && data.regeocode.addressComponent) {
    const ac = data.regeocode.addressComponent;

    const city =
      (Array.isArray(ac.city) ? ac.city.filter(Boolean).join('') : ac.city) ||
      ac.province ||
      '';

    const district = ac.district || city || '未知';

    return {
      province: ac.province || '',
      city,
      district,
      adcode: ac.adcode || ''
    };
  }

  return { city: '', district: '未知' };
}

/**
 * 通过GPS获取位置
 */
async function getLocationByGPS() {
  if (typeof $location === "undefined" || !$location || !$location.latitude || !$location.longitude) {
    throw new Error("未获取到GPS定位：请在 Loon 开启定位权限");
  }
  const latitude = String($location.latitude);
  const longitude = String($location.longitude);

  const info = await getDetailedLocation(longitude, latitude);

  return {
    province: info.province || '',
    city: info.city || '',
    district: info.district || '',
    adcode: info.adcode || '',
    longitude,
    latitude
  };
}

/**
 * 获取天气信息
 * 修复：只要有经纬度就直接用 lon,lat 请求（避免城市ID lookup 失败）
 */
async function getWeather(location) {
  const hasCoord = location.longitude && location.latitude;
  const locationParam = hasCoord
    ? `${location.longitude},${location.latitude}`
    : await getQWeatherLocationId(location);

  const commonHeaders = {
    'Accept': 'application/json',
    'User-Agent': 'Loon'
  };

  const nowUrl = `https://${QWEATHER_HOST}/v7/weather/now?location=${encodeURIComponent(locationParam)}&key=${CONFIG.weatherApiKey}`;
  const forecastUrl = `https://${QWEATHER_HOST}/v7/weather/3d?location=${encodeURIComponent(locationParam)}&key=${CONFIG.weatherApiKey}`;
  const airUrl = `https://${QWEATHER_HOST}/v7/air/now?location=${encodeURIComponent(locationParam)}&key=${CONFIG.weatherApiKey}`;

  const nowResp = await httpGet({ url: nowUrl, headers: commonHeaders });
  if (nowResp.status !== 200) {
    throw new Error(`天气接口HTTP失败(now): ${nowResp.status} body=${bodyPreview(nowResp.body)}`);
  }
  const nowData = safeJsonParse(nowResp.body, null);
  if (!nowData || typeof nowData.code === 'undefined') {
    throw new Error(`天气接口返回非JSON(now): HTTP ${nowResp.status} body=${bodyPreview(nowResp.body)}`);
  }
  if (nowData.code !== '200') {
    throw new Error(`天气API错误(now): ${nowData.code}`);
  }

  const forecastResp = await httpGet({ url: forecastUrl, headers: commonHeaders });
  const forecastData = safeJsonParse(forecastResp.body, {});
  const today = forecastData.daily && forecastData.daily.length ? forecastData.daily[0] : {};

  const airResp = await httpGet({ url: airUrl, headers: commonHeaders });
  const airData = safeJsonParse(airResp.body, {});
  const airNow = airData.now || {};

  return {
    now: nowData.now,
    today,
    air: airNow
  };
}

/**
 * 无坐标时才用：GeoAPI lookup
 */
async function getQWeatherLocationId(location) {
  const text = [location.district, location.city, location.province].filter(Boolean).join('');
  if (!text) throw new Error('城市ID获取失败：无坐标且无可用城市文本');

  const url = `https://${QWEATHER_HOST}/geo/v2/city/lookup?location=${encodeURIComponent(text)}&key=${CONFIG.weatherApiKey}`;
  const resp = await httpGet({ url, headers: { 'Accept': 'application/json', 'User-Agent': 'Loon' } });

  if (resp.status !== 200) {
    throw new Error(`城市ID获取失败：GeoAPI HTTP ${resp.status} body=${bodyPreview(resp.body)}`);
  }

  const data = safeJsonParse(resp.body, null);
  if (!data || typeof data.code === 'undefined') {
    throw new Error(`城市ID获取失败：GeoAPI 非JSON body=${bodyPreview(resp.body)}`);
  }

  if (data.code === '200' && Array.isArray(data.location) && data.location.length > 0 && data.location[0].id) {
    return data.location[0].id;
  }

  throw new Error(`城市ID获取失败：code=${data.code} query=${text}`);
}

function formatWeatherMessage(weather) {
  const { now, today, air } = weather;
  let message = '';

  message += `🌡️ 当前: ${now.text} ${now.temp}°C\n`;
  message += `💨 风力: ${now.windDir} ${now.windScale}级\n`;
  message += `💧 湿度: ${now.humidity}%\n`;

  if (today && (today.textDay || today.tempMin || today.tempMax)) {
    message += `\n📅 今日预报:\n`;
    message += `   ${today.textDay || ''}${today.textNight ? ' 转 ' + today.textNight : ''}\n`;
    if (today.tempMin && today.tempMax) {
      message += `   🌡️ ${today.tempMin}°C ~ ${today.tempMax}°C\n`;
    }
  }

  if (air && air.category) {
    message += `\n${getAirQualityEmoji(air.category)} 空气质量: ${air.category} (AQI ${air.aqi})\n`;
  }

  message += `\n💡 建议:\n`;
  const uv = parseInt(today.uvIndex || '0', 10);
  const precip = parseFloat(today.precip || '0');
  const tempNow = parseInt(now.temp || '0', 10);

  if (uv > 7) message += `   ☀️ 紫外线强，注意防晒\n`;
  if (precip > 0) message += `   ☔ 可能有雨，记得带伞\n`;
  if (tempNow < 10) message += `   🧥 气温较低，注意保暖\n`;

  return message.trim();
}

function getAirQualityEmoji(category) {
  const emojiMap = {
    '优': '💚',
    '良': '💛',
    '轻度污染': '🧡',
    '中度污染': '❤️',
    '重度污染': '💜',
    '严重污染': '🖤'
  };
  return emojiMap[category] || '🌫️';
}

main();
