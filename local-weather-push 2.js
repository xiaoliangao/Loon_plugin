/**
 * Loon脚本 - 本地天气推送
 * Cron: 0 8 * * *
 * 每天早上8点执行
 */

// ============ 配置区域 ============
const CONFIG = {
  // 和风天气API密钥（需要注册：https://dev.qweather.com/）
  weatherApiKey: 'YOUR_QWEATHER_API_KEY',
  
  // 高德地图API密钥（用于IP定位，需要注册：https://lbs.amap.com/）
  amapApiKey: 'YOUR_AMAP_API_KEY',
  
  // 通知配置
  notificationTitle: '🌤️ 今日天气',
  
  // 是否使用Loon的GPS定位（更精准但需要权限）
  useGPS: false
};

// ============ 和风 API Host（专属域名） ============
// 根据和风公告：公共域名将停服，需使用控制台分配的 API Host
const QWEATHER_HOST = 'qn2pfyvquw.re.qweatherapi.com';

// ============ HTTP 封装（兼容 Loon：使用 $httpClient） ============
function httpGet(options) {
  return new Promise((resolve, reject) => {
    if (typeof $httpClient === 'undefined') {
      reject(new Error("Can't find variable: $httpClient (请确认在 Loon/Surge 环境运行)"));
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
    // 1. 获取用户位置
    const location = await getUserLocation();
    console.log(`定位成功: ${location.district}, ${location.city}`);
    
    // 2. 获取天气信息
    const weather = await getWeather(location);
    
    // 3. 格式化并发送通知
    const message = formatWeatherMessage(weather, location);
    $notification.post(
      CONFIG.notificationTitle,
      `${location.city} ${location.district}`,
      message
    );
    
  } catch (error) {
    console.error('天气推送失败:', error);
    $notification.post('❌ 天气获取失败', '', error.message);
  }
  
  $done();
}

/**
 * 获取用户位置（精确到区县）
 */
async function getUserLocation() {
  if (CONFIG.useGPS && typeof $location !== "undefined" && $location) {
    // 使用Loon的GPS定位
    return await getLocationByGPS();
  } else {
    // 使用IP定位
    return await getLocationByIP();
  }
}

/**
 * 通过IP获取位置
 */
async function getLocationByIP() {
  const url = `https://restapi.amap.com/v3/ip?key=${CONFIG.amapApiKey}`;
  
  const response = await httpGet({ url });
  
  if (response.status !== 200) {
    throw new Error('位置获取失败');
  }
  
  const data = JSON.parse(response.body);
  
  if (data.status !== '1') {
    throw new Error(`高德API错误: ${data.info}`);
  }
  
  // 获取更精确的行政区信息
  const location = {
    province: data.province,
    city: data.city,
    district: data.province, // IP定位精度有限
    adcode: data.adcode,
    longitude: (() => { const c = data.rectangle ? getRectangleCenter(data.rectangle) : null; return c ? c.longitude : ""; })(),
    latitude: (() => { const c = data.rectangle ? getRectangleCenter(data.rectangle) : null; return c ? c.latitude : ""; })(),
  };
  
  // 如果需要更精确的区县信息，可以再次调用逆地理编码API
  if (location.longitude && location.latitude) {
    const detailedLocation = await getDetailedLocation(location.longitude, location.latitude);
    location.district = detailedLocation.district;
  }
  
  return location;
}

/**
 * 获取详细地理信息（精确到区县）
 */
async function getDetailedLocation(lon, lat) {
  const url = `https://restapi.amap.com/v3/geocode/regeo?key=${CONFIG.amapApiKey}&location=${lon},${lat}`;
  
  const response = await httpGet({ url });
  const data = JSON.parse(response.body);
  
  if (data.status === '1' && data.regeocode) {
    return {
      district: data.regeocode.addressComponent.district || data.regeocode.addressComponent.city
    };
  }
  
  return { district: '未知' };
}

/**
 * 通过GPS获取位置（需要Loon定位权限）
 */
async function getLocationByGPS() {
  // Loon的$location对象包含经纬度
  if (typeof $location === "undefined" || !$location || !$location.latitude || !$location.longitude) {
    throw new Error("未获取到GPS定位：请在 Loon 开启定位权限，或关闭 useGPS");
  }
  const { latitude, longitude } = $location;
  
  const url = `https://restapi.amap.com/v3/geocode/regeo?key=${CONFIG.amapApiKey}&location=${longitude},${latitude}`;
  
  const response = await httpGet({ url });
  const data = JSON.parse(response.body);
  
  if (data.status !== '1') {
    throw new Error('GPS定位转换失败');
  }
  
  const addr = data.regeocode.addressComponent;
  
  return {
    province: addr.province,
    city: addr.city,
    district: addr.district,
    adcode: addr.adcode,
    longitude: longitude,
    latitude: latitude
  };
}

/**
 * 获取天气信息（和风天气API）
 */
async function getWeather(location) {
  // 和风天气需要location ID，先通过adcode或城市名获取
  const locationId = await getQWeatherLocationId(location);
  
  // 获取实时天气
  const nowUrl = `https://${QWEATHER_HOST}/v7/weather/now?location=${locationId}&key=${CONFIG.weatherApiKey}`;
  const nowResponse = await httpGet({ url: nowUrl });
  const nowData = JSON.parse(nowResponse.body);
  
  // 获取今日预报
  const forecastUrl = `https://${QWEATHER_HOST}/v7/weather/3d?location=${locationId}&key=${CONFIG.weatherApiKey}`;
  const forecastResponse = await httpGet({ url: forecastUrl });
  const forecastData = JSON.parse(forecastResponse.body);
  
  // 获取空气质量
  const airUrl = `https://${QWEATHER_HOST}/v7/air/now?location=${locationId}&key=${CONFIG.weatherApiKey}`;
  const airResponse = await httpGet({ url: airUrl });
  const airData = JSON.parse(airResponse.body);
  
  if (nowData.code !== '200') {
    throw new Error(`天气API错误: ${nowData.code}`);
  }
  
  return {
    now: nowData.now,
    today: forecastData.daily[0],
    air: airData.now || {}
  };
}

/**
 * 获取和风天气的LocationID
 */
async function getQWeatherLocationId(location) {
  const cityName = location.district || location.city;
  const qLocation = (location.longitude && location.latitude)
    ? `${location.longitude},${location.latitude}`
    : (cityName || "");
  const url = `https://${QWEATHER_HOST}/geo/v2/city/lookup?location=${encodeURIComponent(qLocation)}&key=${CONFIG.weatherApiKey}`;
  
  const response = await httpGet({ url });
  const data = JSON.parse(response.body);
  
  if (data.code === '200' && data.location.length > 0) {
    return data.location[0].id;
  }
  
  throw new Error('城市ID获取失败');
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
  message += `\n📅 今日预报:\n`;
  message += `   ${today.textDay} 转 ${today.textNight}\n`;
  message += `   🌡️ ${today.tempMin}°C ~ ${today.tempMax}°C\n`;
  
  // 空气质量
  if (air.category) {
    const airEmoji = getAirQualityEmoji(air.category);
    message += `\n${airEmoji} 空气质量: ${air.category} (AQI ${air.aqi})\n`;
  }
  
  // 生活建议
  message += `\n💡 建议:\n`;
  if (parseInt(today.uvIndex) > 7) {
    message += `   ☀️ 紫外线强，注意防晒\n`;
  }
  if (parseFloat(today.precip) > 0) {
    message += `   ☔ 可能有雨，记得带伞\n`;
  }
  if (parseInt(now.temp) < 10) {
    message += `   🧥 气温较低，注意保暖\n`;
  }
  
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