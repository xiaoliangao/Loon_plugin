/**
 * Loon脚本 - 本地天气推送（完全修复版）
 * Cron: 0 8 * * *
 * 
 * 支持在插件设置中填写位置：
 * - 经纬度：120.354591,30.313967
 * - 地名：杭州 余杭区 或 余杭区
 * - 留空：使用 IP 定位
 */

// ============ 配置区域 ============
const CONFIG = {
  weatherApiKey: 'b7583671face461ab6423cdc8b665473',
  amapApiKey: '2332287723c1a6b0d33d38c30976ab86',
  notificationTitle: '🌤️ 今日天气',
};

const QWEATHER_HOST = "qn2pfyvquw.re.qweatherapi.com";
const QW_HEADERS = {
  Accept: "application/json",
  "User-Agent": "Loon",
  "X-QW-Api-Key": CONFIG.weatherApiKey,
};

// ============ 工具函数 ============
function httpGet(options) {
  return new Promise((resolve, reject) => {
    if (typeof $httpClient === "undefined") {
      reject(new Error("请在 Loon 环境运行"));
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
  try { return JSON.parse(text); } catch (_) { return fallback; }
}

function isLonLat(str) {
  if (!str || typeof str !== "string") return false;
  const parts = str.split(",").map(s => s.trim());
  if (parts.length !== 2) return false;
  const lon = Number(parts[0]);
  const lat = Number(parts[1]);
  return Number.isFinite(lon) && Number.isFinite(lat) && 
         Math.abs(lon) <= 180 && Math.abs(lat) <= 90;
}

function getRectangleCenter(rectangle) {
  try {
    const [p1, p2] = rectangle.split(";");
    const [lon1, lat1] = p1.split(",").map(Number);
    const [lon2, lat2] = p2.split(",").map(Number);
    if ([lon1, lat1, lon2, lat2].some(v => Number.isNaN(v))) return null;
    return { 
      longitude: String((lon1 + lon2) / 2), 
      latitude: String((lat1 + lat2) / 2) 
    };
  } catch (e) { return null; }
}

function normalizeCityName(cityField) {
  if (!cityField) return "";
  if (typeof cityField === "string") return cityField;
  if (Array.isArray(cityField)) return cityField.filter(Boolean).join("");
  return "";
}

// ============ 判断是否是占位符（核心修复） ============
function isPlaceholder(str) {
  if (!str || typeof str !== "string") return false;
  const s = str.trim();
  
  // 检查所有可能的占位符格式
  const placeholders = [
    "{weatherLocation}",
    "${weatherLocation}",
    "{{weatherLocation}}",
    "{location}",
    "${location}",
    "{{location}}",
  ];
  
  return placeholders.includes(s);
}

// ============ 参数解析（完全重写，彻底修复） ============
function parseLocationFromArgument() {
  console.log("\n=== 解析位置参数 ===");
  
  // 检查 $argument 是否存在
  if (typeof $argument === "undefined" || $argument === null) {
    console.log("✗ 参数未定义，使用 IP 定位");
    return "";
  }
  
  console.log(`- 参数类型: ${typeof $argument}`);
  console.log(`- 参数原始值: ${JSON.stringify($argument)}`);
  
  // 处理 object 类型（某些 Loon 版本可能返回 object）
  if (typeof $argument === "object") {
    const keys = ["weatherLocation", "location", "loc"];
    for (const key of keys) {
      if ($argument[key]) {
        const val = String($argument[key]).trim();
        if (val && !isPlaceholder(val)) {
          console.log(`✓ 从 object.${key} 提取: "${val}"`);
          return val;
        }
      }
    }
    console.log("✗ object 中未找到有效位置");
    return "";
  }
  
  // 处理 string 类型
  const raw = String($argument).trim();
  
  if (!raw) {
    console.log("✗ 参数为空字符串，使用 IP 定位");
    return "";
  }
  
  console.log(`- 参数字符串: "${raw}"`);
  
  // 情况1：直接是占位符（整个参数就是 {weatherLocation}）
  if (isPlaceholder(raw)) {
    console.log("✗ 参数是占位符，使用 IP 定位");
    return "";
  }
  
  // 情况2：k=v 格式（如 weatherLocation=xxx）
  if (raw.includes("=")) {
    console.log("- 检测到等号，解析 k=v 格式");
    
    // 先尝试按 & 或 ; 分割（多参数情况）
    let pairs = [raw];
    if (raw.includes("&")) {
      pairs = raw.split("&").map(s => s.trim()).filter(Boolean);
    } else if (raw.includes(";")) {
      pairs = raw.split(";").map(s => s.trim()).filter(Boolean);
    }
    
    // 遍历每个 k=v 对
    for (const pair of pairs) {
      const eqIdx = pair.indexOf("=");
      if (eqIdx <= 0) continue;
      
      const key = pair.slice(0, eqIdx).trim();
      const value = pair.slice(eqIdx + 1).trim();
      
      console.log(`  检查: ${key} = ${value}`);
      
      // 匹配目标 key
      if (key === "weatherLocation" || key === "location" || key === "loc") {
        // 关键：先检查是否是占位符
        if (isPlaceholder(value)) {
          console.log(`  → 值是占位符，跳过`);
          continue;
        }
        
        // 检查是否为空
        if (!value) {
          console.log(`  → 值为空，跳过`);
          continue;
        }
        
        // 有效值！
        console.log(`✓ 找到有效位置: "${value}"`);
        return value;
      }
    }
    
    console.log("✗ k=v 格式中未找到有效位置");
    return "";
  }
  
  // 情况3：直接是位置值（无 k=v 格式）
  // 例如：argument="120.354591,30.313967" 或 argument="杭州 余杭区"
  // 这是推荐的新格式！
  if (!isPlaceholder(raw)) {
    console.log(`✓ 参数直接作为位置: "${raw}"`);
    return raw;
  }
  
  // 如果是占位符，返回空字符串
  console.log(`✗ 参数是占位符: "${raw}"`);
  return "";
}

// ============ 主流程 ============
async function main() {
  try {
    console.log("\n🌤️ 天气推送开始");
    
    const location = await getUserLocation();
    console.log(`\n📍 位置: ${location.city} ${location.district}`);
    console.log(`   坐标: ${location.longitude}, ${location.latitude}`);
    console.log(`   来源: ${location.source}`);
    
    const subtitle = `${location.city || ""}${location.district ? " " + location.district : ""}（${location.source}）`;
    
    const weather = await getWeather(location);
    const message = formatWeatherMessage(weather);
    
    $notification.post(CONFIG.notificationTitle, subtitle, message);
    console.log("\n✓ 推送成功");
    
  } catch (error) {
    console.log(`\n❌ 错误: ${error.message}`);
    if (error.stack) console.log(error.stack);
    $notification.post("❌ 天气获取失败", "", error.message || String(error));
  } finally {
    $done();
  }
}

async function getUserLocation() {
  const userInput = parseLocationFromArgument();
  
  if (userInput) {
    console.log(`\n→ 使用指定位置: "${userInput}"`);
    const loc = await getLocationByInput(userInput);
    loc.source = "设置";
    return loc;
  }
  
  console.log("\n→ 使用 IP 定位");
  const ip = await getLocationByIP();
  ip.source = "IP";
  return ip;
}

async function getLocationByInput(input) {
  const text = String(input).trim();
  console.log(`- 解析输入: "${text}"`);
  
  // 经纬度格式
  if (isLonLat(text)) {
    console.log("  → 识别为经纬度");
    const [lon, lat] = text.split(",").map(s => s.trim());
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
  
  // 地名格式
  console.log("  → 识别为地名");
  
  // 清理文本
  const cleanText = text.replace(/[省市区县]/g, "");
  const tokens = cleanText.split(/\s+/).filter(Boolean);
  
  console.log(`  → 分词: ${JSON.stringify(tokens)}`);
  
  // 构建搜索列表
  const searches = [];
  if (tokens.length >= 2) {
    searches.push(tokens.join(""));  // 连接所有
    searches.push(tokens[tokens.length - 1]);  // 最后一个（区县）
    searches.push(tokens[0]);  // 第一个（市）
  } else if (tokens.length === 1) {
    searches.push(tokens[0]);
  } else {
    searches.push(text);
  }
  
  // 去重
  const uniqueSearches = [...new Set(searches)];
  console.log(`  → 尝试搜索: ${uniqueSearches.join(", ")}`);
  
  // 依次尝试
  for (let i = 0; i < uniqueSearches.length; i++) {
    const address = uniqueSearches[i];
    const cityHint = tokens.length >= 1 ? tokens[0] : "";
    
    console.log(`  → 第 ${i + 1} 次: "${address}"${cityHint ? `, 市: "${cityHint}"` : ""}`);
    
    try {
      const geo = await geocodeByAddress(address, cityHint);
      if (geo) {
        console.log(`    ✓ 成功`);
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
      console.log(`    ✗ 无结果`);
    } catch (e) {
      console.log(`    ✗ 失败: ${e.message}`);
    }
  }
  
  throw new Error(`无法解析位置 "${text}"\n\n支持格式：\n- 经纬度: 120.354591,30.313967\n- 地名: 杭州 余杭区\n- 区县: 余杭区`);
}

async function getLocationByIP() {
  console.log("- 调用高德 IP 定位");
  const url = `https://restapi.amap.com/v3/ip?key=${CONFIG.amapApiKey}`;
  const response = await httpGet({ url });
  
  if (response.status !== 200) {
    throw new Error(`IP 定位失败: HTTP ${response.status}`);
  }
  
  const data = safeJsonParse(response.body, {});
  if (data.status !== "1") {
    throw new Error(`IP 定位失败: ${data.info || "unknown"}`);
  }
  
  const province = data.province || "";
  const cityRaw = data.city || "";
  const city = (cityRaw === "[]" || cityRaw === '[""]') ? "" : cityRaw;
  
  console.log(`  → IP 定位: ${province} ${city}`);
  
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
  
  const resp = await httpGet({ url });
  if (resp.status !== 200) return null;
  
  const data = safeJsonParse(resp.body, {});
  if (data.status !== "1" || !data.geocodes || !data.geocodes.length) return null;
  
  const loc = data.geocodes[0].location;
  if (!loc || !loc.includes(",")) return null;
  
  const [lon, lat] = loc.split(",");
  return { longitude: lon, latitude: lat };
}

async function getDetailedLocation(lon, lat) {
  const url = `https://restapi.amap.com/v3/geocode/regeo?key=${CONFIG.amapApiKey}&location=${lon},${lat}&extensions=base`;
  const resp = await httpGet({ url });
  
  if (resp.status !== 200) {
    return { province: "", city: "", district: "未知", adcode: "" };
  }
  
  const data = safeJsonParse(resp.body, {});
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
  const locationParam = hasCoord ? 
    `${location.longitude},${location.latitude}` : 
    await getQWeatherLocationId(location);
  
  console.log(`\n- 查询天气: ${locationParam}`);
  
  const nowUrl = `https://${QWEATHER_HOST}/v7/weather/now?location=${encodeURIComponent(locationParam)}`;
  const forecastUrl = `https://${QWEATHER_HOST}/v7/weather/3d?location=${encodeURIComponent(locationParam)}`;
  const airUrl = `https://${QWEATHER_HOST}/v7/air/now?location=${encodeURIComponent(locationParam)}`;
  
  const nowResp = await httpGet({ url: nowUrl, headers: QW_HEADERS });
  if (nowResp.status !== 200) throw new Error(`天气接口失败: ${nowResp.status}`);
  const nowData = safeJsonParse(nowResp.body, null);
  if (!nowData || nowData.code !== "200") throw new Error(`天气 API 错误: ${nowData?.code}`);
  
  const forecastResp = await httpGet({ url: forecastUrl, headers: QW_HEADERS });
  const forecastData = safeJsonParse(forecastResp.body, {});
  
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
  if (!text) throw new Error("无坐标且无城市信息");
  
  const url = `https://${QWEATHER_HOST}/geo/v2/city/lookup?location=${encodeURIComponent(text)}`;
  const resp = await httpGet({ url, headers: QW_HEADERS });
  
  if (resp.status !== 200) throw new Error(`城市 ID 获取失败: HTTP ${resp.status}`);
  
  const data = safeJsonParse(resp.body, null);
  if (data?.code === "200" && data.location?.[0]?.id) {
    return data.location[0].id;
  }
  throw new Error(`城市 ID 获取失败: code=${data?.code}`);
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
  const map = {
    优: "💚", 良: "💛", 轻度污染: "🧡",
    中度污染: "❤️", 重度污染: "💜", 严重污染: "🖤",
  };
  return map[category] || "🌫️";
}

main();
