// 租房监视：SUUMO / HOME'S 上出现符合条件的新房源或降价时，用 WxPusher（免费）推送到微信。
// 用法：node watch.mjs            正常运行（GitHub Actions 每 30 分钟跑一次）
//       node watch.mjs --dry-run  只打印，不推送、不写 state.json
//       node watch.mjs --probe    把各网站的原始 HTML 存到 probe/，用于排查解析问题
import * as cheerio from 'cheerio';
import fs from 'node:fs';

const cfg = JSON.parse(fs.readFileSync(new URL('./config.json', import.meta.url)));
const STATE = new URL('./state.json', import.meta.url);
const dry = process.argv.includes('--dry-run');
const probe = process.argv.includes('--probe');
const wxToken = process.env.WXPUSHER_TOKEN;
const wxUids = (process.env.WXPUSHER_UID || '').split(',').map((s) => s.trim()).filter(Boolean); // 多人用逗号分隔
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = new Date();

async function get(url) {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'ja,en;q=0.8' } });
      const text = await res.text();
      if (res.ok && text) { await sleep(1500); return text; }
      if (res.status === 202 && !text) return { blocked: 'challenge', text }; // 反爬验证页：不重试、不绕过
      console.warn(`HTTP ${res.status} ${url}`);
      if (res.status === 403 || res.status === 404) return { blocked: res.status, text };
    } catch (e) { console.warn(`fetch error ${url}: ${e.message}`); }
    await sleep(3000 * (i + 1));
  }
  return { blocked: 'error', text: '' };
}
const saveProbe = (name, html) => {
  if (!probe) return;
  fs.mkdirSync(new URL('./probe/', import.meta.url), { recursive: true });
  fs.writeFileSync(new URL(`./probe/${name}.html`, import.meta.url), typeof html === 'string' ? html : html.text);
};

// ---------- 共通 ----------
const z2h = (s) => String(s ?? '').replace(/[０-９Ａ-Ｚａ-ｚ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/\s+/g, ' ').trim();
const yen = (s) => {
  s = z2h(s).replace(/,/g, '');
  let m = s.match(/([\d.]+)\s*万/); if (m) return Math.round(parseFloat(m[1]) * 10000);
  m = s.match(/([\d.]+)\s*円/); if (m) return Math.round(parseFloat(m[1]));
  return 0; // 「-」= 0
};
const ageOf = (s) => { s = z2h(s); if (/新築/.test(s)) return 0; const m = s.match(/築\s*(\d+)\s*年/); return m ? +m[1] : null; };
const areaOf = (s) => { const m = z2h(s).match(/([\d.]+)\s*(m|㎡)/); return m ? parseFloat(m[1]) : null; };
function townOk(addr) {
  const a = z2h(addr).replace(/^神奈川県/, '');
  for (const [city, towns] of Object.entries(cfg.towns)) {
    if (!a.startsWith(city)) continue;
    const rest = a.slice(city.length);
    if (towns.some((t) => rest.startsWith(t))) return true;
  }
  return false;
}
function parkingInfo(text) {
  const t = z2h(text);
  if (!t || t === '-') return { fee: null, ok: true, text: t || '未写' };
  if (/空無/.test(t) && !/空有/.test(t)) return { fee: null, ok: false, text: t };
  if (/無料|込/.test(t)) return { fee: 0, ok: true, text: t };
  const fees = [...t.replace(/,/g, '').matchAll(/(\d+(?:\.\d+)?)\s*(万)?円/g)].map((m) => Math.round(parseFloat(m[1]) * (m[2] ? 10000 : 1)));
  if (!fees.length) return { fee: null, ok: true, text: t };
  const fee = Math.min(...fees);
  return { fee, ok: fee <= cfg.maxParkingYen, text: t };
}
// 同一房间在多个网站/多家中介重复挂牌 → 町名+间取+面积+楼层 作为键
// （SUUMO 地址只到丁目、HOME'S 写到番地，数字部分对不上，所以只取町名）
const townOf = (a) => z2h(a).replace(/^神奈川県/, '').replace(/[\d-].*$/, '').replace(/丁目$/, '');
const roomKey = (r) => [townOf(r.address), z2h(r.layout).toUpperCase(), r.area?.toFixed(1), (z2h(r.floor).match(/\d+/) || ['?'])[0]].join('|');
const baseOk = (r) => r.total <= cfg.maxTotalYen && r.area >= cfg.minAreaM2 && r.age != null && r.age <= cfg.maxAgeYears
  && cfg.layouts.includes(z2h(r.layout).toUpperCase()) && townOk(r.address);

// ---------- SUUMO ----------
const suumoList = (sc, page) => `https://suumo.jp/jj/chintai/ichiran/FR301FC001/?ar=030&bs=040&ta=14&sc=${sc}&cb=0.0&ct=${(cfg.maxTotalYen / 10000).toFixed(1)}&co=1&et=9999999&md=07&md=10&mb=${cfg.minAreaM2}&mt=9999999&cn=${cfg.maxAgeYears}&tc=0400901&shkr1=03&shkr2=03&shkr3=03&shkr4=03&pc=50&page=${page}`;

async function scanSuumo() {
  const out = [];
  for (const [city, sc] of Object.entries(cfg.suumo.sc)) {
    for (let page = 1; page <= 20; page++) {
      const html = await get(suumoList(sc, page));
      if (typeof html !== 'string') throw new Error(`SUUMO ${city} p${page} 取得失败 (${html.blocked})`);
      if (page === 1) saveProbe(`suumo-${sc}`, html);
      const $ = cheerio.load(html);
      const items = $('.cassetteitem');
      if (!items.length) {
        if (page === 1 && !/条件にあう物件がありません/.test(html)) throw new Error(`SUUMO ${city} 列表解析不到房源（页面结构可能变了）`);
        break;
      }
      items.each((_, el) => {
        const b = $(el);
        const name = z2h(b.find('.cassetteitem_content-title').first().text());
        const address = z2h(b.find('.cassetteitem_detail-col1').first().text());
        const col3 = b.find('.cassetteitem_detail-col3 div').map((_, d) => z2h($(d).text())).get();
        const access = b.find('.cassetteitem_detail-col2 .cassetteitem_detail-text').map((_, d) => z2h($(d).text())).get().filter(Boolean);
        b.find('.cassetteitem_other tbody tr').each((_, tr) => {
          const row = $(tr);
          const href = row.find('a[href*="/chintai/jnc_"]').attr('href') || '';
          const id = (href.match(/jnc_\d+/) || [])[0];
          if (!id) return;
          const tds = row.find('td').map((_, td) => z2h($(td).text())).get();
          const rent = yen(row.find('.cassetteitem_price--rent').text());
          const mgmt = yen(row.find('.cassetteitem_price--administration').text());
          out.push({
            site: 'SUUMO', id, url: `https://suumo.jp/chintai/${id}/`, name, address, access: access[0] || '',
            built: col3[0] || '', age: ageOf(col3[0]), floor: tds.find((t) => /階/.test(t) && t.length < 12) || '',
            layout: z2h(row.find('.cassetteitem_madori').text()), area: areaOf(row.find('.cassetteitem_menseki').text()),
            rent, mgmt, total: rent + mgmt,
          });
        });
      });
      if (!$('.pagination-parts a:contains("次へ")').length) break;
    }
  }
  return out;
}
async function suumoParking(r) {
  const html = await get(r.url);
  if (typeof html !== 'string') return null;
  saveProbe('suumo-detail', html);
  const $ = cheerio.load(html);
  let text = '';
  $('th').each((_, th) => { if (!text && /駐車場/.test($(th).text())) text = $(th).next('td').text(); });
  return parkingInfo(text);
}

// ---------- HOME'S ----------
// cond: 賃料上限(管理費込) / 2LDK=25 3LDK=35 / 55㎡以上 / 築15年以内 / 駐車場あり=320801
const homesList = (city, page) => `https://www.homes.co.jp/chintai/kanagawa/${city}/list/?` + new URLSearchParams({
  'cond[monthmoneyroomh]': String(cfg.maxTotalYen / 10000), 'cond[kanrihi]': '1', 'cond[madori][25]': '25', 'cond[madori][35]': '35',
  'cond[housearea]': String(cfg.minAreaM2), 'cond[houseageh]': String(cfg.maxAgeYears), 'cond[mcf][320801]': '320801', page: String(page),
});

async function scanHomes() {
  const out = [];
  for (const [cityName, city] of Object.entries(cfg.homes.cities)) {
    for (let page = 1; page <= 20; page++) {
      const html = await get(homesList(city, page));
      if (typeof html !== 'string') throw new Error(`HOME'S ${cityName} p${page} 取得失败 (${html.blocked})`);
      if (page === 1) saveProbe(`homes-${city}`, html);
      const $ = cheerio.load(html);
      const blds = $('.prg-building').filter((_, el) => $(el).find('tr.prg-roomInfo').length > 0);
      if (!blds.length) {
        if (page === 1 && !/条件に一致する物件|該当する物件がありません|0件/.test(html)) throw new Error(`HOME'S ${cityName} 列表解析不到房源（页面结构可能变了）`);
        break;
      }
      blds.each((_, el) => {
        const b = $(el);
        const spec = {};
        b.find('.bukkenSpec tr').each((_, tr) => { spec[z2h($(tr).find('th').text())] = z2h($(tr).find('td').text()); });
        const name = z2h(b.find('.bukkenName').first().text());
        const built = (spec['築年数/階数'] || '').split('/')[0].trim();
        b.find('tr.prg-roomInfo').each((_, tr) => {
          const row = $(tr);
          const url = row.attr('data-href') || row.find('a[href*="/chintai/room/"]').attr('href') || '';
          const id = (url.match(/room\/([0-9a-f]+)/) || [])[1];
          if (!id) return;
          const priceTxt = z2h(row.find('td.price > span').first().text()); // 「19.5万円/10,000円」
          const [rentTxt, mgmtTxt] = priceTxt.split('/');
          const lay = row.find('td.layout').html() || '';
          const [layout, areaTxt] = lay.split(/<br\s*\/?>/i).map((s) => z2h(cheerio.load(s).text()));
          const rent = yen(rentTxt), mgmt = yen(mgmtTxt);
          out.push({
            site: "HOME'S", id, url: `https://www.homes.co.jp/chintai/room/${id}/`, name, address: spec['所在地'] || '',
            access: spec['交通'] || '', built, age: ageOf(built), floor: z2h(row.find('.roomKaisuu').text()),
            layout, area: areaOf(areaTxt), rent, mgmt, total: rent + mgmt,
          });
        });
      });
      if (!$('a[rel="next"], .nextPage a, li.next a').length) break;
    }
  }
  return out;
}

// ---------- 推送（WxPusher，HTML 卡片） ----------
const man = (n) => (n / 10000).toFixed(2).replace(/\.?0+$/, '');
const h = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const TAG_COLOR = { 新房源: '#2f7a68', 在招: '#5f6d68', 重新招租: '#1f5f7a' }; // 其他（降价）= 橙色
// 「JR東海道本線 辻堂駅 2階建 築14年」这类是中介没写楼名时 SUUMO 自动生成的标题
const displayName = (r) => (/駅 \d+階建|^\S+線 \S+駅/.test(r.name) ? '（楼名未公开）' : r.name);
const shortAccess = (a) => z2h(a).replace(/^[^/]*\//, '').replace(/\(バス停\)/, '').replace(/\s*（.*$/, '');
const areaName = (r) => townOf(r.address).replace(/^.+?[市町]/, '');
function card(r, tag) {
  const pf = r.parking.fee;
  const park = pf == null ? '<span style="color:#a8741a">停车费待确认</span>'
    : pf === 0 ? '<b style="color:#2f7a68">停车免费</b>' : `停车 ${pf.toLocaleString()}円`;
  const sites = [...new Set(r.urls.map((u) => u.site))].map((site) => {
    const n = r.urls.filter((u) => u.site === site).length;
    const url = r.urls.find((u) => u.site === site).url;
    return `<a href="${h(url)}" style="display:inline-block;margin:6px 8px 0 0;padding:4px 12px;border:1px solid #1f5f7a;border-radius:14px;color:#1f5f7a;text-decoration:none;font-size:13px">${h(site)}${n > 1 ? ` ×${n}` : ''} ›</a>`;
  }).join('');
  return `<div style="border:1px solid #dde3dd;border-radius:10px;padding:10px 12px;margin:10px 0;background:#fff">`
    + `<div style="font-size:12px;font-weight:bold;color:${TAG_COLOR[tag] || '#c0562a'}">${h(tag)}</div>`
    + `<div style="font-size:16px;font-weight:bold;margin:2px 0">${h(displayName(r))}</div>`
    + `<div style="font-size:12px;color:#5f6d68">${h(z2h(r.address).replace(/^神奈川県/, ''))}　${h(shortAccess(r.access))}</div>`
    + `<div style="margin:6px 0 2px"><span style="font-size:22px;font-weight:bold;color:#c0562a">${man(r.total)}</span><span style="font-size:13px;color:#c0562a">万</span>`
    + `<span style="font-size:12px;color:#5f6d68">　含停车 ${man(r.total + (pf || 0))}万</span></div>`
    + `<div style="font-size:14px"><b>${h(r.layout)}</b> · ${r.area}㎡ · ${h(r.built)} · ${h(r.floor)} · ${park}</div>`
    + sites + '</div>';
}
const introBox = (lines) => `<div style="font-size:13px;color:#5f6d68;line-height:1.6;margin-bottom:4px">${lines.join('<br>')}</div>`;
async function push(title, intro, cards = []) {
  const plain = (s) => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  console.log(`\n=== ${title} ===\n${plain(intro)}\n${cards.map(plain).join('\n')}\n`);
  if (probe) {
    fs.mkdirSync(new URL('./probe/', import.meta.url), { recursive: true });
    fs.writeFileSync(new URL('./probe/message.html', import.meta.url), `<meta charset="utf-8"><meta name="viewport" content="width=device-width"><body style="background:#f4f6f4;font-family:sans-serif;max-width:480px;margin:auto;padding:12px"><h3>${h(title)}</h3>${intro}${cards.join('')}`);
  }
  if (dry) return;
  if (!wxToken || !wxUids.length) {
    console.error(`推送跳过：WXPUSHER_TOKEN ${wxToken ? '有' : '未设置'}，WXPUSHER_UID ${wxUids.length ? `${wxUids.length} 个` : '未设置'}`);
    return;
  }
  // WxPusher：content 上限 40000 字 / 65535 字节，超过就分条
  const parts = [[]];
  for (const c of cards) {
    if (parts.at(-1).length && Buffer.byteLength(parts.at(-1).join('') + c) > 45000) parts.push([]);
    parts.at(-1).push(c);
  }
  for (const [i, part] of parts.entries()) {
    const t = parts.length > 1 ? `${title}（${i + 1}/${parts.length}）` : title;
    const html = `<div style="font-family:-apple-system,sans-serif;color:#1a2422">${i === 0 ? intro : ''}${part.join('')}</div>`;
    const res = await fetch('https://wxpusher.zjiecode.com/api/send/message', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appToken: wxToken, uids: wxUids, contentType: 2, summary: t.slice(0, 100), content: html }),
    });
    const j = await res.json().catch(() => ({}));
    const mask = (u) => String(u).slice(0, 8) + '…';
    const per = (Array.isArray(j.data) ? j.data : []).map((d) => `${mask(d.uid)} ${d.status ?? ''}${d.code != null ? ` (code ${d.code})` : ''}`).join('；');
    console.log(`WxPusher 回应：HTTP ${res.status} code=${j.code} msg=${j.msg ?? ''} ${per}`);
    if (j.code !== 1000) console.error('WxPusher 推送失败');
  }
}
if (process.argv.includes('--test-push')) {
  await push('租房监视 测试消息', introBox(['这是一条测试消息，收到说明推送正常。', new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })]));
  process.exit(0);
}

// ---------- 主流程 ----------
const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE)) : {};
state.rooms ??= {}; state.fail ??= {};
const firstRun = !state.initializedAt || process.argv.includes('--list'); // --list：再发一次现有房源一览
const events = [], errors = [];

const scanned = [];
for (const [site, fn] of [['SUUMO', scanSuumo], ["HOME'S", scanHomes]]) {
  try {
    const rows = await fn();
    console.log(`${site}: ${rows.length} 行`);
    scanned.push(...rows);
    state.fail[site] = 0;
  } catch (e) {
    console.error(`${site}: ${e.message}`);
    state.fail[site] = (state.fail[site] || 0) + 1;
    const limit = site === 'SUUMO' ? 3 : 24;
    if (state.fail[site] === limit) errors.push(`${site} 已连续 ${limit} 次失败：${e.message}`);
  }
}

// 按房间合并
const byKey = new Map();
for (const r of scanned.filter(baseOk)) {
  const k = roomKey(r);
  const cur = byKey.get(k);
  if (!cur) byKey.set(k, { ...r, urls: [{ site: r.site, url: r.url }] });
  else {
    if (!cur.urls.some((u) => u.url === r.url)) cur.urls.push({ site: r.site, url: r.url });
    if (r.total < cur.total) Object.assign(cur, { ...r, urls: cur.urls });
  }
}
console.log(`范围内符合条件：${byKey.size} 间`);

const iso = now.toISOString();
for (const [k, r] of byKey) {
  const old = state.rooms[k];
  if (old?.parking && !(old.parking.retry && r.urls.some((u) => u.site === 'SUUMO'))) r.parking = old.parking;
  else {
    // HOME'S 详情页有反爬验证，读不到；同一间在 SUUMO 也有时用 SUUMO 的停车费
    const su = r.urls.find((u) => u.site === 'SUUMO');
    r.parking = su ? (await suumoParking({ url: su.url })) || { fee: null, ok: true, text: '未取得' }
      : { fee: null, ok: true, text: "只在 HOME'S 上有，停车费请点开确认" };
    if (!su) r.parking.retry = true;
  }
  if (!r.parking.ok) { state.rooms[k] = { ...(old || { firstSeen: iso }), parking: r.parking, total: r.total, lastSeen: iso, excluded: true }; continue; }
  if (!old || old.excluded) events.push({ r, tag: '新房源' });
  else if (r.total < old.total) events.push({ r, tag: `降价 ${man(old.total)}→${man(r.total)}万` });
  else if (Date.parse(old.lastSeen) < now - 3 * 864e5) events.push({ r, tag: '重新招租' });
  state.rooms[k] = { firstSeen: old?.firstSeen || iso, lastSeen: iso, total: Math.min(r.total, old?.total ?? Infinity), parking: r.parking, name: r.name, url: r.urls[0].url };
  if (old && r.total < old.total) state.rooms[k].total = r.total;
}
for (const [k, v] of Object.entries(state.rooms)) if (now - Date.parse(v.lastSeen) > cfg.forgetAfterDays * 864e5) delete state.rooms[k];

const live = [...byKey.values()].filter((r) => r.parking.ok);
if (firstRun) {
  live.sort((a, b) => a.total - b.total);
  await push(`现有房源 ${live.length} 间${live.length ? `｜最低 ${man(live[0].total)}万 ${areaName(live[0])}` : ''}`,
    introBox([`现住处约 10 分钟内（${Object.values(cfg.towns).flat().length} 个町），按 月租＋管理费 从低到高。`,
      `停车免费 ${live.filter((r) => r.parking.fee === 0).length} 间 · 3LDK ${live.filter((r) => r.layout.startsWith('3')).length} 间。之后有新房源或降价会再推送。`]),
    live.map((r) => card(r, '在招')));
  state.initializedAt = iso;
} else if (events.length) {
  const news = events.filter((e) => e.tag === '新房源').length;
  const title = news ? `新房源 ${news} 间${events.length > news ? `＋降价等 ${events.length - news}` : ''}` : `降价/重新招租 ${events.length} 间`;
  const top = events[0].r;
  await push(`${title}｜${areaName(top)} ${top.layout} ${man(top.total)}万`, '', events.map((e) => card(e.r, e.tag)));
}
if (errors.length) await push('租房监视出错', introBox([...errors.map(h), '网站可能改版或拦截了访问，需要修一下程序。']));
state.lastRun = iso;
if (!dry) fs.writeFileSync(STATE, JSON.stringify(state, null, 1));
console.log(`完成：事件 ${events.length}，错误 ${errors.length}`);
