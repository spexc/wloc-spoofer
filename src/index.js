import { Hono } from "hono/tiny";
import { getPageHtml } from "./page.js";
import { parseCoords, gcj02ToWgs84, toWgs84, round6, inRange } from "./parse.js";

const app = new Hono();

app.get("/", (c) => {
  return c.html(getPageHtml());
});

// 模块脚本代理: 设备常连不上 raw.githubusercontent.com, 导致 Surge 拉不到 wloc 脚本 →
// MITM 不触发 → 网页「储存失败」。这里由 Worker 服务端去 raw 拉脚本、再从 workers.dev
// 发给设备, 设备只需能访问 workers.dev(已证明可达), 从而彻底绕开 raw.github 可达性。
// 单一数据源仍是 GitHub 仓库的 dist/, 不在 Worker 里硬编码脚本, 仓库一更新这里就跟着更新。
const RAW = "https://raw.githubusercontent.com/spexc/wloc-spoofer/refs/heads/main/dist/";
app.get("/wloc.js", (c) => proxyScript(c, "wloc.js", "application/javascript; charset=utf-8"));
app.get("/wloc-settings.js", (c) => proxyScript(c, "wloc-settings.js", "application/javascript; charset=utf-8"));
app.get("/wloc.module", (c) => proxyScript(c, "wloc.module", "text/plain; charset=utf-8"));

async function proxyScript(c, name, contentType) {
  try {
    const r = await fetch(RAW + name);
    if (!r.ok) return c.text(`upstream ${name} fetch failed: HTTP ${r.status}`, 502);
    return c.body(await r.text(), 200, {
      "content-type": contentType,
      "access-control-allow-origin": "*",
      // 短缓存: 仓库更新后不至于长时间吃旧脚本, 又不至于每次都回源。
      "cache-control": "public, max-age=300",
    });
  } catch (e) {
    return c.text(`proxy ${name} error: ${e && e.message ? e.message : e}`, 502);
  }
}

// 地图链接解析: 供快捷指令调用。
// GET /api/parse?u=<链接>&format=json&cs=<gcj|none>
//   返回 {lat, lon, name}; 高德/苹果地图(中国大陆均为 GCJ-02)自动转 WGS84; 境外坐标自动跳过(out_of_china)。cs=none 可强制不转换。
//   不带 format=json 时返回纯文本 "lat=..&lon=.." 片段。
app.get("/api/parse", async (c) => {
  const raw = c.req.query("u") || "";
  const cs = (c.req.query("cs") || "").toLowerCase();
  const fmt = (c.req.query("format") || "").toLowerCase();
  try {
    let { lat, lon, name, src } = await parseCoords(raw);
    // 默认按来源自动换算; cs=none 强制不转换, cs=gcj/bd 强制按指定坐标系转换。
    if (cs === "gcj") ({ lat, lon } = gcj02ToWgs84(lat, lon));
    else if (cs === "bd") ({ lat, lon } = toWgs84(lat, lon, "baidu"));
    else if (cs !== "none") ({ lat, lon } = toWgs84(lat, lon, src));
    // 出口再校验一次: cs= 是调用方指定的, 强行按错误坐标系换算也可能把值推出值域。
    // 宁可报错也不要返回一个能被当成坐标写进设备的数字。
    if (!inRange(lat, lon)) throw new Error("解析出的坐标超出合法范围");
    lat = round6(lat);
    lon = round6(lon);
    name = name || "";
    c.header("Access-Control-Allow-Origin", "*");
    if (fmt === "json") return c.json({ lat, lon, name });
    return c.text(`lat=${lat}&lon=${lon}`);
  } catch (e) {
    c.header("Access-Control-Allow-Origin", "*");
    return c.json({ error: String(e && e.message ? e.message : e) }, 422);
  }
});

// 兜底 500 也要带 CORS —— 否则快捷指令那边看到的是跨域错误, 而不是真正的原因。
app.onError((e, c) => {
  c.header("Access-Control-Allow-Origin", "*");
  return c.text(`${e && e.message ? e.message : e}`, 500);
});

export default app;
