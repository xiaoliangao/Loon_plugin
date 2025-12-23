/**
 * Loon脚本 - 本地天气推送
 * Cron: 0 8 * * *
 * 每天早上8点执行
 */

// ============ 配置区域 ============
const CONFIG = {
  // 和风天气API密钥（需要注册：https://dev.qweather.com/）
  weatherApiKey: 'HE2208311053331687',

  // 高德地图API密钥（用于IP定位/逆地理/地理编码，需要注册：https://lbs.amap.com/）
  amapApiKey: '2332287723c1a6b0d33d38c30976ab86',

  // 通知配置
  notificationTitle: '🌤️ 今日天气',

  // 是否使用Loon的GPS定位（更精准但需要权限）
  // 修复：即使打开，若定位不可用会自动回退到IP定位
  useGPS: true
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
      resolve({ status, headers: (resp && resp.headers) || {}, body: body || '' });
    });
  });
}

function safeJsonParse(text, fallback = null) {
  try {
    return JSON.parse(text);
  } catch (e) {
    return fallback;
  }
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

    const cityText = normalizeCityName(location.city) || normalizeCityName(location.province) || '未知城市';
    const districtText = location.district && location.district !== '未知' ? location.district : '';

    console.log(`定位成功: ${districtText || '-'}, ${cityText || '-'}`);
    if (location.longitude && location.latitude) {
      console.log(`坐标: ${location.longitude},${location.latitude}`);
    } else {
      console.log('坐标: (空)');
    }

    const weather = await getWeather(location);

    const message = formatWeatherMessage(weather, location);
    $notification.post(
      CONFIG.notificationTitle,
      `${cityText}${districtText ? ' ' + districtText : ''}`,
      message
    );

  } catch (error) {
    console.error('天气推送失败:', error && error.stack ? error.stack : String(error));
    $notification.post('❌ 天气获取失败', '', error.message || String(error));
  } finally {
    $done();
  }
}

/**
 * 获取用户位置（精确到区县；并尽量拿到经纬度）
 */
async function getUserLocation() {
  // 修复：GPS失败自动回退到IP定位（避免“定位权限没开就直接炸”）
  if (CONFIG.useGPS && typeof $location !== "undefined" && $location) {
    try {
      return await getLocationByGPS();
    } catch (e) {
      console.log(`GPS定位不可用，回退到IP定位：${e.message || e}`);
      return await getLocationByIP();
    }
  }
  return await getLocationByIP();
}

/**
 * 通过IP获取位置
 */
async function getLocationByIP() {
  const url = `https://restapi.amap.com/v3/ip?key=${CONFIG.amapApiKey}`;
  const response = await httpGet({ url });

  if (response.status !== 200) {
    throw new Error(`位置获取失败：HTTP ${response.status}`);
  }

  const data = safeJsonParse(response.body, {});
  if (data.status !== '1') {
    throw new Error(`高德IP定位错误: ${data.info || 'unknown'}`);
  }

  // 高德IP接口 city 可能是 "[]" 或 ""（例如直辖市/省级）
  const province = data.province || '';
  const cityRaw = data.city || '';
  const city = (cityRaw === '[]' || cityRaw === '[""]') ? '' : cityRaw;

  let longitude = '';
  let latitude = '';

  // 1) 优先用 rectangle 取中心点
  if (data.rectangle) {
    const center = getRectangleCenter(data.rectangle);
    if (center) {
      longitude = center.longitude;
      latitude = center.latitude;
    }
  }

  // 2) 若 rectangle 没拿到坐标，用地理编码把 省/市 转成经纬度（兜底）
  if (!longitude || !latitude) {
    const addr = city ? `${province}${city}` : `${province}`;
    const geo = await geocodeByAddress(addr, city || province);
    if (geo && geo.longitude && geo.latitude) {
      longitude = geo.longitude;
      latitude = geo.latitude;
    }
  }

  const location = {
    province,
    city: city || province, // 直辖市/省级：用 province 兜底
    district: province,     // 先兜底，后面会逆地理覆盖
    adcode: data.adcode || '',
    longitude,
    latitude
  };

  // 3) 有坐标就做逆地理，拿到区县
  if (location.longitude && location.latitude) {
    const detailedLocation = await getDetailedLocation(location.longitude, location.latitude);
    if (detailedLocation && detailedLocation.district) {
      location.district = detailedLocation.district;
    }
    // 同时修正 city（某些情况下逆地理更准）
    if (detailedLocation && detailedLocation.city) {
      location.city = detailedLocation.city;
    }
  } else {
    // 没坐标时，把 district 设成 city/省，避免显示“未知”
    location.district = city || province || '未知';
  }

  return location;
}

/**
 * 地理编码：把地址转换成坐标（兜底用）
 */
async function geocodeByAddress(address, city) {
  if (!address) return null;
  const url = `https://restapi.amap.com/v3/geocode/geo?key=${CONFIG.amapApiKey}&address=${encodeURIComponent(address)}&city=${encodeURIComponent(city || '')}`;
  const response = await httpGet({ url });

  if (response.status !== 200) return null;
  const data = safeJsonParse(response.body, {});
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
  const response = await httpGet({ url });

  const data = safeJsonParse(response.body, {});
  if (data.status === '1' && data.regeocode && data.regeocode.addressComponent) {
    const ac = data.regeocode.addressComponent;

    // city 在直辖市可能是 []，这里统一成 string
    const city = normalizeCityName(ac.city) || normalizeCityName(ac.province) || '';
    const district = ac.district || city || '未知';

    return { city, district };
  }
  return { city: '', district: '未知' };
}

function normalizeCityName(cityField) {
  if (!cityField) return '';
  if (typeof cityField === 'string') return cityField;
  if (Array.isArray(cityField)) return cityField.filter(Boolean).join('');
  return '';
}

/**
 * 通过GPS获取位置（需要Loon定位权限）
 */
async function getLocationByGPS() {
  if (typeof $location === "undefined" || !$location || !$location.latitude || !$location.longitude) {
    throw new Error("未获取到GPS定位：请在 Loon 开启定位权限，或关闭 useGPS");
  }
  const latitude = String($location.latitude);
  const longitude = String($location.longitude);

  const url = `https://restapi.amap.com/v3/geocode/regeo?key=${CONFIG.amapApiKey}&location=${longitude},${latitude}&extensions=base`;
  const response = await httpGet({ url });

  if (response.status !== 200) {
    throw new Error(`GPS逆地理失败：HTTP ${response.status}`);
  }

  const data = safeJsonParse(response.body, {});
  if (data.status !== '1' || !data.regeocode || !data.regeocode.addressComponent) {
    throw new Error(`GPS定位转换失败：${data.info || 'unknown'}`);
  }

  const addr = data.regeocode.addressComponent;

  const province = addr.province || '';
  const city = normalizeCityName(addr.city) || province || '';
  const district = addr.district || city || '未知';

  return {
    province,
    city,
    district,
    adcode: addr.adcode || '',
    longitude,
    latitude
  };
}

/**
 * 获取天气信息（和风天气API）
 * 修复：优先用经纬度直接请求 v7（不再强依赖城市ID）
 */
async function getWeather(location) {
  const hasCoord = location.longitude && location.latitude;
  const locationParam = hasCoord
    ? `${location.longitude},${location.latitude}`
    : await getQWeatherLocationId(location); // 仅在没坐标时才查城市ID

  const nowUrl = `https://${QWEATHER_HOST}/v7/weather/now?location=${encodeURIComponent(locationParam)}&key=${CONFIG.weatherApiKey}`;
  const forecastUrl = `https://${QWEATHER_HOST}/v7/weather/3d?location=${encodeURIComponent(locationParam)}&key=${CONFIG.weatherApiKey}`;
  const airUrl = `https://${QWEATHER_HOST}/v7/air/now?location=${encodeURIComponent(locationParam)}&key=${CONFIG.weatherApiKey}`;

  const [nowResponse, forecastResponse, airResponse] = await Promise.all([
    httpGet({ url: nowUrl }),
    httpGet({ url: forecastUrl }),
    httpGet({ url: airUrl })
  ]);

  const nowData = safeJsonParse(nowResponse.body, {});
  const forecastData = safeJsonParse(forecastResponse.body, {});
  const airData = safeJsonParse(airResponse.body, {});

  if (nowData.code !== '200') {
    throw new Error(`天气API错误(now): ${nowData.code || 'unknown'}`);
  }
  if (forecastData.code && forecastData.code !== '200') {
    throw new Error(`天气API错误(forecast): ${forecastData.code}`);
  }
  if (airData.code && airData.code !== '200') {
    // 空气质量失败不阻断主流程（降级）
    console.log(`空气质量接口异常: code=${airData.code}`);
  }

  const today = forecastData.daily && forecastData.daily.length ? forecastData.daily[0] : {};
  const airNow = airData.now || {};

  return {
    now: nowData.now,
    today,
    air: airNow
  };
}

/**
 * 获取和风天气的LocationID（仅在无坐标时使用）
 */
async function getQWeatherLocationId(location) {
  // 尽量用更具体的文本，减少“同名城市”导致的空结果
  const text = [
    location.district,
    location.city,
    location.province
  ].filter(Boolean).join('');

  if (!text) {
    throw new Error('城市ID获取失败：无可用城市文本且无经纬度');
  }

  const url = `https://${QWEATHER_HOST}/geo/v2/city/lookup?location=${encodeURIComponent(text)}&key=${CONFIG.weatherApiKey}`;
  const response = await httpGet({ url });

  if (response.status !== 200) {
    throw new Error(`城市ID获取失败：GeoAPI HTTP ${response.status}`);
  }

  const data = safeJsonParse(response.body, {});
  const locArr = data.location || [];

  if (data.code === '200' && Array.isArray(locArr) && locArr.length > 0 && locArr[0].id) {
    return locArr[0].id;
  }

  // 给出更可诊断的错误信息
  throw new Error(`城市ID获取失败：code=${data.code || 'unknown'} query=${text}`);
}

/**
 * 格式化天气消息
 */
function formatWeatherMessage(weather, location) {
  const { now, today, air } = weather;

  let message = '';

  // 当前天气
  message += `🌡️ 当前: ${now.text} ${now.temp}°C\n`;
  message += `💨 风力: ${now.windDir} ${now.windScale}级\n`;
  message += `💧 湿度: ${now.humidity}%\n`;

  // 今日预报
  if (today && (today.textDay || today.tempMin || today.tempMax)) {
    message += `\n📅 今日预报:\n`;
    message += `   ${today.textDay || ''}${today.textNight ? ' 转 ' + today.textNight : ''}\n`;
    if (today.tempMin && today.tempMax) {
      message += `   🌡️ ${today.tempMin}°C ~ ${today.tempMax}°C\n`;
    }
  }

  // 空气质量
  if (air && air.category) {
    const airEmoji = getAirQualityEmoji(air.category);
    message += `\n${airEmoji} 空气质量: ${air.category} (AQI ${air.aqi})\n`;
  }

  // 生活建议（容错：字段可能缺失）
  message += `\n💡 建议:\n`;
  const uv = parseInt(today.uvIndex || '0', 10);
  const precip = parseFloat(today.precip || '0');
  const tempNow = parseInt(now.temp || '0', 10);

  if (uv > 7) message += `   ☀️ 紫外线强，注意防晒\n`;
  if (precip > 0) message += `   ☔ 可能有雨，记得带伞\n`;
  if (tempNow < 10) message += `   🧥 气温较低，注意保暖\n`;

  return message.trim();
}

/**
 * 根据空气质量返回对应emoji
 */
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

// 执行主函数
main();
