/**
 * Loon脚本 - 本地天气推送（完全修复版）
 * Cron: 0 8 * * *
 * 每天早上8点执行
 */

// ============ 配置区域 ============
const CONFIG = {
  // 和风天气 API KEY
  weatherApiKey: 'b7583671face461ab6423cdc8b665473',

  // 高德 Web服务 Key
  amapApiKey: '2332287723c1a6b0d33d38c30976ab86',

  // 通知标题
  notificationTitle: '🌤️ 今日天气',
};

// ============ 和风 API Host ============
const QWEATHER_HOST = "qn2pfyvquw.re.qweatherapi.com";

const QW_HEADERS = {
  Accept: "application/json",
  "User-Agent": "Loon",
  "X-QW-Api-Key": CONFIG.weatherApiKey,
};

// ============ HTTP 封装 ============
function httpGet(options) {
  return new Promise((resolve, reject) => {
    if (typeof $httpClient === "undefined") {
      reject(new Error("Can't find variable: $httpClient (请确认在 Loon 环境运行)"));
      return;
    }
    const opts = typeof options === "string" ? { url: options } : options;
    $httpClient.get(opts, (err, resp, body) => {
      if (err) return reject(err);
      const status = resp && (resp.status || resp.statusCode) ? (resp.status || resp.statusCode) : 0;
      resolve({ status, headers: (resp && resp.headers) || {}, body: body || "" });
    });
  });
}

function safeJsonParse(text, fallback = null) {
  try {
    return JSON.parse(text);
  } catch (_) {
    return fallback;
  }
}

function bodyPreview(body, n = 220) {
  if (!body) return "";
  const s = String(body).replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n) + "..." : s;
}

function isLonLat(str) {
  if (!str || typeof str !== "string") return false;
  const parts = str.split(",").map((s) => s.trim());
  if (parts.length !== 2) return false;
  const lon = Number(parts[0]);
  const lat = Number(parts[1]);
  return Number.isFinite(lon) && Number.isFinite(lat) && Math.abs(lon) <= 180 && Math.abs(lat) <= 90;
}

function getRectangleCenter(rectangle) {
  try {
    const [p1, p2] = rectangle.split(";");
    const [lon1, lat1] = p1.split(",").map(Number);
    const [lon2, lat2] = p2.split(",").map(Number);
    if ([lon1, lat1, lon2, lat2].some((v) => Number.isNaN(v))) return null;
    return { longitude: String((lon1 + lon2) / 2), latitude: String((lat1 + lat2) / 2) };
  } catch (e) {
    return null;
  }
}

function normalizeCityName(cityField) {
  if (!cityField) return "";
  if (typeof cityField === "string") return cityField;
  if (Array.isArray(cityField)) return cityField.filter(Boolean).join("");
  return "";
}

// ============ 解析插件传参 - 关键修复 ============
/**
 * Loon 插件参数传递说明：
 * 
 * 如果在 .plugin 文件中这样配置：
 *   argument=weatherLocation={weatherLocation}
 * 
 * 那么 $argument 的值可能是：
 * 1. 如果用户填了 "上海 浦东新区"，则 $argument = "weatherLocation=上海 浦东新区"
 * 2. 如果用户没填，则 $argument = "weatherLocation={weatherLocation}" （未替换）
 * 3. 也可能直接是用户填的值（取决于 Loon 版本）
 */
function parseArgumentLocation() {
  if (typeof $argument === "undefined" || $argument === null) {
    console.log("[parseArgumentLocation] $argument 未定义，使用 IP 定位");
    return "";
  }

  console.log(`[parseArgumentLocation] $argument 类型: ${typeof $argument}`);
  console.log(`[parseArgumentLocation] $argument 原始值: ${JSON.stringify($argument)}`);

  // 处理 object 形式
  if (typeof $argument === "object") {
    const loc = String($argument.weatherLocation || $argument.location || $argument.loc || "").trim();
    console.log(`[parseArgumentLocation] object 形式，提取: ${loc}`);
    return isPlaceholder(loc) ? "" : loc;
  }

  const raw = String($argument).trim();
  if (!raw) {
    console.log("[parseArgumentLocation] 参数为空，使用 IP 定位");
    return "";
  }

  // JSON 格式
  if ((raw.startsWith("{") && raw.endsWith("}")) || (raw.startsWith("[") && raw.endsWith("]"))) {
    const obj = safeJsonParse(raw, null);
    if (obj && typeof obj === "object") {
      const loc = String(obj.weatherLocation || obj.location || obj.loc || "").trim();
      console.log(`[parseArgumentLocation] JSON 形式，提取: ${loc}`);
      return isPlaceholder(loc) ? "" : loc;
    }
  }

  // k=v 格式：weatherLocation=xxx
  if (raw.includes("=")) {
    const parts = raw.split(/[&;]/).map((s) => s.trim()).filter(Boolean);
    for (const p of parts) {
      const idx = p.indexOf("=");
      if (idx <= 0) continue;
      const k = p.slice(0, idx).trim();
      const v = p.slice(idx + 1).trim();
      
      console.log(`[parseArgumentLocation] 解析 k=v: ${k} = ${v}`);
      
      // 匹配 weatherLocation / location / loc
      if (k === "weatherLocation" || k === "location" || k === "loc") {
        // 检查是否是占位符（未替换）
        if (isPlaceholder(v)) {
          console.log(`[parseArgumentLocation] 检测到未替换的占位符: ${v}，使用 IP 定位`);
          return "";
        }
        console.log(`[parseArgumentLocation] 提取位置: ${v}`);
        return v;
      }
    }
  }

  // 纯字符串：直接当位置（但需要检查是否是占位符）
  if (isPlaceholder(raw)) {
    console.log(`[parseArgumentLocation] 检测到未替换的占位符: ${raw}，使用 IP 定位`);
    return "";
  }
  
  console.log(`[parseArgumentLocation] 直接使用位置: ${raw}`);
  return raw;
}

/**
 * 判断是否是未替换的占位符
 */
function isPlaceholder(str) {
  if (!str || typeof str !== "string") return false;
  const s = str.trim();
  // 检查常见的占位符格式
  return s.startsWith("{") && s.endsWith("}") || 
         s === "weatherLocation" ||
         s === "{weatherLocation}" ||
         s === "${weatherLocation}" ||
         s === "{{weatherLocation}}";
}

// ============ 主流程 ============
async function main() {
  try {
    console.log("=== 开始获取天气 ===");
    const location = await getUserLocation();
    console.log(`位置信息: ${JSON.stringify(location)}`);
    
    const subtitle = `${location.city || ""}${location.district ? " " + location.district : ""}（${location.source}）`;

    const weather = await getWeather(location);
    const message = formatWeatherMessage(weather);

    $notification.post(CONFIG.notificationTitle, subtitle, message);
    console.log("=== 天气推送成功 ===");
  } catch (error) {
    console.log(`错误详情: ${error.message}`);
    if (error.stack) console.log(`错误堆栈: ${error.stack}`);
    $notification.post("❌ 天气获取失败", "", error && error.message ? error.message : String(error));
  } finally {
    $done();
  }
}

async function getUserLocation() {
  const override = parseArgumentLocation();
  console.log(`[getUserLocation] 解析后的位置: "${override}"`);
  
  if (override) {
    console.log("[getUserLocation] 使用设置的位置");
    const loc = await getLocationByOverride(override);
    loc.source = "设置";
    return loc;
  }

  console.log("[getUserLocation] 使用 IP 定位");
  const ip = await getLocationByIP();
  ip.source = "IP";
  return ip;
}

async function getLocationByOverride(override) {
  const text = String(override).trim();
  console.log(`[getLocationByOverride] 处理位置: "${text}"`);

  // 检查是否是经纬度格式
  if (isLonLat(text)) {
    console.log("[getLocationByOverride] 识别为经纬度格式");
    const [lon, lat] = text.split(",").map((s) => s.trim());
    const info = await getDetailedLocation(lon, lat);
    return {
      province: info.province || "",
      city: info.city || "",
      district: info.district || "",
      adcode: info.adcode || "",
      longitude: lon,
      latitude: lat,
    };
  }

  // 文本格式：支持多种地名格式
  console.log("[getLocationByOverride] 识别为地名格式");
  
  // 移除常见后缀
  const cleanText = text.replace(/[省市区县]/g, "");
  const tokens = cleanText.split(/\s+/).filter(Boolean);
  
  console.log(`[getLocationByOverride] 清理后的tokens: ${JSON.stringify(tokens)}`);
  
  // 构建多种搜索组合
  const searches = [];
  
  if (tokens.length >= 2) {
    searches.push(tokens.join(""));  // 连接所有：上海浦东
    searches.push(tokens[tokens.length - 1]);  // 最后一个：浦东
    searches.push(tokens[0] + tokens[tokens.length - 1]);  // 首 + 尾：上海浦东
  } else if (tokens.length === 1) {
    searches.push(tokens[0]);
  } else {
    searches.push(text);
  }

  console.log(`[getLocationByOverride] 尝试搜索: ${JSON.stringify(searches)}`);

  // 依次尝试
  let lastError = null;
  for (let i = 0; i < searches.length; i++) {
    const address = searches[i];
    const cityHint = tokens.length >= 1 ? tokens[0] : "";
    
    console.log(`[getLocationByOverride] 第 ${i + 1} 次尝试: address="${address}", city="${cityHint}"`);
    
    try {
      const geo = await geocodeByAddress(address, cityHint);
      if (geo) {
        console.log(`[getLocationByOverride] 地理编码成功: ${JSON.stringify(geo)}`);
        const info = await getDetailedLocation(geo.longitude, geo.latitude);
        return {
          province: info.province || "",
          city: info.city || "",
          district: info.district || "",
          adcode: info.adcode || "",
          longitude: geo.longitude,
          latitude: geo.latitude,
        };
      }
    } catch (e) {
      console.log(`[getLocationByOverride] 第 ${i + 1} 次尝试失败: ${e.message}`);
      lastError = e;
    }
  }

  throw new Error(`位置解析失败：无法识别 "${text}"

请填写格式如：
  ✅ 经纬度：121.5,31.2
  ✅ 市+区：上海 浦东新区
  ✅ 仅区县：浦东新区
  ✅ 留空：使用 IP 定位

当前尝试了: ${searches.join(", ")}
${lastError ? "\n最后错误: " + lastError.message : ""}`);
}

async function getLocationByIP() {
  console.log("[getLocationByIP] 开始 IP 定位");
  const url = `https://restapi.amap.com/v3/ip?key=${CONFIG.amapApiKey}`;
  const response = await httpGet({ url });

  if (response.status !== 200) {
    throw new Error(`IP定位失败：HTTP ${response.status}`);
  }

  const data = safeJsonParse(response.body, {});
  console.log(`[getLocationByIP] 返回数据: ${JSON.stringify(data)}`);
  
  if (data.status !== "1") {
    throw new Error(`高德IP定位错误: ${data.info || "unknown"}`);
  }

  const province = data.province || "";
  const cityRaw = data.city || "";
  const city = (cityRaw === "[]" || cityRaw === '[""]') ? "" : cityRaw;

  let longitude = "";
  let latitude = "";

  if (data.rectangle) {
    const center = getRectangleCenter(data.rectangle);
    if (center) {
      longitude = center.longitude;
      latitude = center.latitude;
    }
  }

  if (!longitude || !latitude) {
    const addr = city ? `${province}${city}` : province;
    console.log(`[getLocationByIP] 使用地理编码获取坐标: ${addr}`);
    const geo = await geocodeByAddress(addr, city || province);
    if (geo) {
      longitude = geo.longitude;
      latitude = geo.latitude;
    }
  }

  let district = city || province || "未知";
  let finalCity = city || province || "未知";

  if (longitude && latitude) {
    const info = await getDetailedLocation(longitude, latitude);
    district = info.district || district;
    finalCity = info.city || finalCity;
  }

  return {
    province,
    city: finalCity,
    district,
    adcode: data.adcode || "",
    longitude,
    latitude,
  };
}

async function geocodeByAddress(addressText, cityHint) {
  if (!addressText) return null;
  
  const cityParam = cityHint ? `&city=${encodeURIComponent(cityHint)}` : "";
  const url = `https://restapi.amap.com/v3/geocode/geo?key=${CONFIG.amapApiKey}&address=${encodeURIComponent(addressText)}${cityParam}`;
  
  console.log(`[geocodeByAddress] 请求URL: ${url}`);
  
  const resp = await httpGet({ url });

  if (resp.status !== 200) {
    console.log(`[geocodeByAddress] HTTP错误: ${resp.status}`);
    return null;
  }

  const data = safeJsonParse(resp.body, {});
  console.log(`[geocodeByAddress] 返回: ${JSON.stringify(data)}`);
  
  if (data.status !== "1" || !data.geocodes || !data.geocodes.length) {
    console.log(`[geocodeByAddress] 未找到结果`);
    return null;
  }

  const loc = data.geocodes[0].location;
  if (!loc || typeof loc !== "string" || !loc.includes(",")) {
    console.log(`[geocodeByAddress] 坐标格式错误: ${loc}`);
    return null;
  }

  const [lon, lat] = loc.split(",");
  console.log(`[geocodeByAddress] 成功获取坐标: ${lon}, ${lat}`);
  return { longitude: lon, latitude: lat };
}

async function getDetailedLocation(lon, lat) {
  const url = `https://restapi.amap.com/v3/geocode/regeo?key=${CONFIG.amapApiKey}&location=${lon},${lat}&extensions=base`;
  console.log(`[getDetailedLocation] 逆地理编码: ${lon}, ${lat}`);
  
  const resp = await httpGet({ url });

  if (resp.status !== 200) {
    console.log(`[getDetailedLocation] HTTP错误: ${resp.status}`);
    return { province: "", city: "", district: "未知", adcode: "" };
  }

  const data = safeJsonParse(resp.body, {});
  console.log(`[getDetailedLocation] 返回: ${JSON.stringify(data)}`);
  
  if (data.status === "1" && data.regeocode && data.regeocode.addressComponent) {
    const ac = data.regeocode.addressComponent;
    const city = normalizeCityName(ac.city) || ac.province || "";
    const district = ac.district || city || "未知";
    return { province: ac.province || "", city, district, adcode: ac.adcode || "" };
  }

  return { province: "", city: "", district: "未知", adcode: "" };
}

async function getWeather(location) {
  const hasCoord = location.longitude && location.latitude;
  const locationParam = hasCoord ? `${location.longitude},${location.latitude}` : await getQWeatherLocationId(location);

  console.log(`[getWeather] 使用位置参数: ${locationParam}`);

  const nowUrl = `https://${QWEATHER_HOST}/v7/weather/now?location=${encodeURIComponent(locationParam)}`;
  const forecastUrl = `https://${QWEATHER_HOST}/v7/weather/3d?location=${encodeURIComponent(locationParam)}`;
  const airUrl = `https://${QWEATHER_HOST}/v7/air/now?location=${encodeURIComponent(locationParam)}`;

  const nowResp = await httpGet({ url: nowUrl, headers: QW_HEADERS });
  if (nowResp.status !== 200) throw new Error(`天气接口HTTP失败(now): ${nowResp.status}`);
  const nowData = safeJsonParse(nowResp.body, null);
  if (!nowData || typeof nowData.code === "undefined") throw new Error(`天气接口返回非JSON(now)`);
  if (nowData.code !== "200") throw new Error(`天气API错误(now): ${nowData.code}`);

  const forecastResp = await httpGet({ url: forecastUrl, headers: QW_HEADERS });
  const forecastData = safeJsonParse(forecastResp.body, {});
  if (forecastData.code && forecastData.code !== "200") throw new Error(`天气API错误(forecast): ${forecastData.code}`);

  const airResp = await httpGet({ url: airUrl, headers: QW_HEADERS });
  const airData = safeJsonParse(airResp.body, {});

  return {
    now: nowData.now,
    today: (forecastData.daily && forecastData.daily.length) ? forecastData.daily[0] : {},
    air: airData.now || {},
  };
}

async function getQWeatherLocationId(location) {
  const text = [location.district, location.city, location.province].filter(Boolean).join("");
  if (!text) throw new Error("城市ID获取失败：无坐标且无可用城市文本");

  const url = `https://${QWEATHER_HOST}/geo/v2/city/lookup?location=${encodeURIComponent(text)}`;
  const resp = await httpGet({ url, headers: QW_HEADERS });

  if (resp.status !== 200) throw new Error(`城市ID获取失败：HTTP ${resp.status}`);

  const data = safeJsonParse(resp.body, null);
  if (!data || typeof data.code === "undefined") throw new Error(`城市ID获取失败：非JSON`);

  if (data.code === "200" && Array.isArray(data.location) && data.location.length > 0 && data.location[0].id) {
    return data.location[0].id;
  }
  throw new Error(`城市ID获取失败：code=${data.code} query=${text}`);
}

function formatWeatherMessage(weather) {
  const { now, today, air } = weather;
  let message = "";

  message += `🌡️ 当前: ${now.text} ${now.temp}°C\n`;
  message += `💨 风力: ${now.windDir} ${now.windScale}级\n`;
  message += `💧 湿度: ${now.humidity}%\n`;

  if (today && (today.textDay || today.tempMin || today.tempMax)) {
    message += `\n📅 今日预报:\n`;
    message += `   ${today.textDay || ""}${today.textNight ? " 转 " + today.textNight : ""}\n`;
    if (today.tempMin && today.tempMax) {
      message += `   🌡️ ${today.tempMin}°C ~ ${today.tempMax}°C\n`;
    }
  }

  if (air && air.category) {
    message += `\n${getAirQualityEmoji(air.category)} 空气质量: ${air.category} (AQI ${air.aqi})\n`;
  }

  message += `\n💡 建议:\n`;
  const uv = parseInt(today.uvIndex || "0", 10);
  const precip = parseFloat(today.precip || "0");
  const tempNow = parseInt(now.temp || "0", 10);
  if (uv > 7) message += `   ☀️ 紫外线强，注意防晒\n`;
  if (precip > 0) message += `   ☔ 可能有雨，记得带伞\n`;
  if (tempNow < 10) message += `   🧥 气温较低，注意保暖\n`;

  return message.trim();
}

function getAirQualityEmoji(category) {
  const emojiMap = {
    优: "💚",
    良: "💛",
    轻度污染: "🧡",
    中度污染: "❤️",
    重度污染: "💜",
    严重污染: "🖤",
  };
  return emojiMap[category] || "🌫️";
}

main();
