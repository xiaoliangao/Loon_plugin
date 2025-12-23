/**
 * Loon脚本 - 本地天气推送（参数解析加强版）
 * 
 * 特别说明：
 * 如果插件参数传递有问题，可以直接在下面 CONFIG.myLocation 中填写位置
 */

// ============ 配置区域 ============
const CONFIG = {
  weatherApiKey: 'b7583671face461ab6423cdc8b665473',
  amapApiKey: '2332287723c1a6b0d33d38c30976ab86',
  notificationTitle: '🌤️ 今日天气',
  
  // ⭐⭐⭐ 如果插件参数不生效，直接在这里填写你的位置 ⭐⭐⭐
  // 优先级最高，会覆盖所有其他设置
  myLocation: '',  // 留空则使用插件参数；填写则强制使用此位置
  // 示例：
  // myLocation: '120.354591,30.313967',  // 经纬度
  // myLocation: '杭州 余杭区',           // 地名
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

// ============ 参数解析（加强版） ============
function parseLocationFromArgument() {
  console.log("\n=== 开始解析位置参数 ===");
  
  // 优先级1：脚本内硬编码
  if (CONFIG.myLocation && String(CONFIG.myLocation).trim()) {
    const loc = String(CONFIG.myLocation).trim();
    console.log(`✓ 使用脚本配置: "${loc}"`);
    return loc;
  }
  console.log("- 脚本配置为空，继续检查插件参数");
  
  // 优先级2：插件参数
  if (typeof $argument === "undefined" || $argument === null) {
    console.log("- 插件参数未定义");
    return "";
  }
  
  console.log(`- 插件参数类型: ${typeof $argument}`);
  console.log(`- 插件参数原始值: ${JSON.stringify($argument)}`);
  
  // 处理 object 类型
  if (typeof $argument === "object") {
    const loc = String($argument.weatherLocation || $argument.location || $argument.loc || "").trim();
    if (loc && !isPlaceholder(loc)) {
      console.log(`✓ 从 object 提取: "${loc}"`);
      return loc;
    }
  }
  
  // 处理 string 类型
  const raw = String($argument).trim();
  if (!raw) {
    console.log("- 参数为空字符串");
    return "";
  }
  
  console.log(`- 参数字符串: "${raw}"`);
  
  // 处理 k=v 格式：weatherLocation=120.354591,30.313967
  if (raw.includes("=")) {
    console.log("- 检测到等号，尝试 k=v 解析");
    
    // 尝试多种分隔符
    const separators = ["&", ";", ","];
    let found = false;
    
    for (const sep of separators) {
      if (raw.includes(sep) && raw.indexOf(sep) > raw.indexOf("=")) {
        // 有其他参数，需要分割
        const parts = raw.split(sep).map(s => s.trim()).filter(Boolean);
        for (const part of parts) {
          const eqIdx = part.indexOf("=");
          if (eqIdx > 0) {
            const k = part.slice(0, eqIdx).trim();
            const v = part.slice(eqIdx + 1).trim();
            console.log(`  - 解析: ${k} = ${v}`);
            if ((k === "weatherLocation" || k === "location" || k === "loc") && v && !isPlaceholder(v)) {
              console.log(`✓ 找到位置: "${v}"`);
              return v;
            }
          }
        }
        found = true;
        break;
      }
    }
    
    if (!found) {
      // 只有一个 k=v
      const eqIdx = raw.indexOf("=");
      if (eqIdx > 0) {
        const k = raw.slice(0, eqIdx).trim();
        const v = raw.slice(eqIdx + 1).trim();
        console.log(`  - 单个 k=v: ${k} = ${v}`);
        if ((k === "weatherLocation" || k === "location" || k === "loc") && v && !isPlaceholder(v)) {
          console.log(`✓ 找到位置: "${v}"`);
          return v;
        }
        if (isPlaceholder(v)) {
          console.log(`  - 检测到占位符: ${v}`);
        }
      }
    }
  }
  
  // 直接是位置值（无 k=v 格式）
  if (!isPlaceholder(raw)) {
    console.log(`✓ 直接使用: "${raw}"`);
    return raw;
  }
  
  console.log(`- 检测到占位符或无效值: "${raw}"`);
  return "";
}

function isPlaceholder(str) {
  if (!str || typeof str !== "string") return false;
  const s = str.trim();
  return (s.startsWith("{") && s.endsWith("}")) ||
         s === "weatherLocation" ||
         s === "{weatherLocation}" ||
         s === "${weatherLocation}";
}

// ============ 主流程 ============
async function main() {
  try {
    console.log("\n🌤️ 天气推送开始");
    
    const location = await getUserLocation();
    console.log(`\n📍 最终位置: ${location.city} ${location.district}`);
    console.log(`   经纬度: ${location.longitude}, ${location.latitude}`);
    console.log(`   来源: ${location.source}`);
    
    const subtitle = `${location.city || ""}${location.district ? " " + location.district : ""}（${location.source}）`;
    
    const weather = await getWeather(location);
    const message = formatWeatherMessage(weather);
    
    $notification.post(CONFIG.notificationTitle, subtitle, message);
    console.log("\n✓ 天气推送成功");
    
  } catch (error) {
    console.log(`\n❌ 错误: ${error.message}`);
    if (error.stack) console.log(error.stack);
    $notification.post("❌ 天气获取失败", "", error.message || String(error));
  } finally {
    $done();
  }
}

async function getUserLocation() {
  const override = parseLocationFromArgument();
  
  if (override) {
    console.log(`\n→ 使用指定位置: "${override}"`);
    const loc = await getLocationByOverride(override);
    loc.source = "设置";
    return loc;
  }
  
  console.log("\n→ 使用 IP 定位（未指定位置）");
  const ip = await getLocationByIP();
  ip.source = "IP";
  return ip;
}

async function getLocationByOverride(override) {
  const text = String(override).trim();
  
  // 经纬度
  if (isLonLat(text)) {
    console.log(`- 识别为经纬度: ${text}`);
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
  
  // 地名
  console.log(`- 识别为地名: ${text}`);
  const cleanText = text.replace(/[省市区县]/g, "");
  const tokens = cleanText.split(/\s+/).filter(Boolean);
  
  const searches = [];
  if (tokens.length >= 2) {
    searches.push(tokens.join(""));
    searches.push(tokens[tokens.length - 1]);
  } else {
    searches.push(tokens[0] || text);
  }
  
  console.log(`- 尝试搜索: ${searches.join(", ")}`);
  
  for (let i = 0; i < searches.length; i++) {
    const address = searches[i];
    const cityHint = tokens[0] || "";
    try {
      const geo = await geocodeByAddress(address, cityHint);
      if (geo) {
        console.log(`  ✓ 第 ${i + 1} 次成功`);
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
      console.log(`  ✗ 第 ${i + 1} 次失败: ${e.message}`);
    }
  }
  
  throw new Error(`无法解析位置 "${text}"\n请使用格式：\n- 经纬度: 121.5,31.2\n- 地名: 上海 浦东新区`);
}

async function getLocationByIP() {
  const url = `https://restapi.amap.com/v3/ip?key=${CONFIG.amapApiKey}`;
  const response = await httpGet({ url });
  
  if (response.status !== 200) {
    throw new Error(`IP定位失败: HTTP ${response.status}`);
  }
  
  const data = safeJsonParse(response.body, {});
  if (data.status !== "1") {
    throw new Error(`IP定位失败: ${data.info || "unknown"}`);
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
  
  const nowUrl = `https://${QWEATHER_HOST}/v7/weather/now?location=${encodeURIComponent(locationParam)}`;
  const forecastUrl = `https://${QWEATHER_HOST}/v7/weather/3d?location=${encodeURIComponent(locationParam)}`;
  const airUrl = `https://${QWEATHER_HOST}/v7/air/now?location=${encodeURIComponent(locationParam)}`;
  
  const nowResp = await httpGet({ url: nowUrl, headers: QW_HEADERS });
  if (nowResp.status !== 200) throw new Error(`天气接口失败: ${nowResp.status}`);
  const nowData = safeJsonParse(nowResp.body, null);
  if (!nowData || nowData.code !== "200") throw new Error(`天气API错误: ${nowData?.code}`);
  
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
  
  if (resp.status !== 200) throw new Error(`城市ID获取失败: HTTP ${resp.status}`);
  
  const data = safeJsonParse(resp.body, null);
  if (data?.code === "200" && data.location?.[0]?.id) {
    return data.location[0].id;
  }
  throw new Error(`城市ID获取失败: code=${data?.code}`);
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
