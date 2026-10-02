/// <reference path="./plugin.d.ts" />
/// <reference path="./app.d.ts" />
/// <reference path="./core.d.ts" />

// Anime Diary: a sidebar page with a calendar of what you watched and when,
// the shows you started and didn't finish, and a year in review.
//
// The history comes from your AniList activity feed (Seanime posts an
// activity for every episode you mark as watched), cached in plugin storage
// and topped up with new activities on every load.

interface DiaryActivity {
  id: number
  at: number       // unix seconds
  kind: string     // "watched", "rewatched", "completed", "planning", "dropped", "paused", "other"
  from: number     // first episode of the range, 0 if none
  to: number       // last episode of the range, 0 if none
  mediaId: number
}

interface DiaryMedia {
  id: number
  title: string
  cover: string
  color: string
  episodes: number
  duration: number
  format: string
  genres: string[]
  studios: string[]
}

interface DiaryCache {
  userId: number
  activities: DiaryActivity[]   // newest first
  media: { [id: string]: DiaryMedia }
}

function init() {
  // Seanime runs the UI handler in its own runtime, from its source text, so
  // it can't see anything declared at the top level of this file. Everything
  // it needs comes from the shared module, which is compiled from the source
  // of createAnimeDiary() in each runtime.
  $shared.define("anime-diary", createAnimeDiary)

  $ui.register((ctx) => {
    const D = $shared.use("anime-diary")

    const page = ctx.newWebview({
      slot: "screen",
      fullWidth: true,
      autoHeight: true,
      sidebar: { label: "Anime Diary", icon: D.ICON },
    })

    const payload = ctx.state<any>(null)
    page.channel.sync("data", payload)
    page.setContent(() => D.PAGE_HTML)

    function load(full: boolean) {
      payload.set(Object.assign({}, payload.get() || {}, { loading: true }))
      payload.set(D.loadPayload(full, payload.get()))
    }

    page.channel.on("refresh", (opts: any) => {
      load(!!(opts && opts.full))
    })
    page.channel.on("open", (p: any) => {
      const id = p && Number(p.id)
      if (id) ctx.screen.navigateTo("/entry", { id: String(id) })
    })

    // On start, and again every time the page is opened: only new
    // activities are fetched, so this is a single request most of the time.
    load(false)
    page.onMount(() => load(false))
  })
}

// Everything the plugin does. Self-contained: compiled from its own source
// by $shared, so it may only use globals ($anilist, $storage, ...).
function createAnimeDiary() {
  // v2: media gained banner and large cover, so older caches are fetched again.
  const CACHE_KEY = "diary-cache-v2"
  // AniList returns at most 50 activities per page; stop after this many pages
  // (5000 activities) on a first load.
  const MAX_PAGES = 100

  const ICON = `<span style="display:inline-flex;width:24px;height:24px;align-items:center;justify-content:center;color:currentColor"><svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/><path d="m9 16 2 2 4-4"/></svg></span>`

  const ACTIVITY_QUERY = `query ($u: Int, $p: Int) {
    Page(page: $p, perPage: 50) {
      pageInfo { hasNextPage }
      activities(userId: $u, type: ANIME_LIST, sort: ID_DESC) {
        ... on ListActivity {
          id createdAt status progress
          media {
            id episodes duration format genres
            title { userPreferred }
            coverImage { medium large color }
            bannerImage
            studios(isMain: true) { nodes { name } }
          }
        }
      }
    }
  }`

  // ---------------------------------------------------------------------------
  // AniList
  // ---------------------------------------------------------------------------

  function query(token: string, q: string, variables: any): any {
    const res: any = $anilist.customQuery({ query: q, variables }, token)
    // customQuery may or may not unwrap "data".
    return res && res.data ? res.data : res
  }

  function viewerId(token: string): number {
    const d = query(token, "query { Viewer { id } }", {})
    const id = d && d.Viewer && d.Viewer.id
    if (!id) throw new Error("не удалось узнать пользователя AniList")
    return id
  }

  // Fetches activities newer than the newest cached one and prepends them.
  // Returns true if it had to stop early (page limit or an error), so the
  // history may be incomplete.
  function fetchNewActivities(token: string, cache: DiaryCache): boolean {
    const known = cache.activities.length > 0 ? cache.activities[0].id : 0
    const fresh: DiaryActivity[] = []

    for (let p = 1; p <= MAX_PAGES; p++) {
      let d: any
      try {
        d = query(token, ACTIVITY_QUERY, { u: cache.userId, p })
      } catch (e) {
        // Usually the rate limit; keep what we have and continue next time.
        console.error("Anime Diary: page " + p + ": " + e)
        prepend(cache, fresh)
        return true
      }
      const pageData = d && d.Page
      const list: any[] = (pageData && pageData.activities) || []

      for (const a of list) {
        if (!a || !a.id || !a.media) continue
        if (a.id <= known) {
          prepend(cache, fresh)
          return false
        }
        rememberMedia(cache, a.media)
        fresh.push(toActivity(a))
      }
      if (!pageData || !pageData.pageInfo || !pageData.pageInfo.hasNextPage) {
        prepend(cache, fresh)
        return false
      }
    }
    prepend(cache, fresh)
    return true
  }

  function prepend(cache: DiaryCache, fresh: DiaryActivity[]) {
    if (fresh.length > 0) cache.activities = fresh.concat(cache.activities)
  }

  function toActivity(a: any): DiaryActivity {
    const status = String(a.status || "").toLowerCase()
    let kind = "other"
    if (status.indexOf("rewatched") === 0) kind = "rewatched"
    else if (status.indexOf("watched") === 0) kind = "watched"
    else if (status.indexOf("completed") === 0) kind = "completed"
    else if (status.indexOf("plans") === 0) kind = "planning"
    else if (status.indexOf("dropped") === 0) kind = "dropped"
    else if (status.indexOf("paused") === 0) kind = "paused"

    // progress: "5" or "3 - 5"
    let from = 0
    let to = 0
    const parts = String(a.progress || "").split("-")
    if (parts.length > 0 && parts[0].trim() !== "") {
      from = parseInt(parts[0], 10) || 0
      to = parts.length > 1 ? (parseInt(parts[1], 10) || from) : from
    }
    return { id: a.id, at: a.createdAt, kind, from, to, mediaId: a.media.id }
  }

  function rememberMedia(cache: DiaryCache, m: any) {
    cache.media[String(m.id)] = {
      id: m.id,
      title: (m.title && m.title.userPreferred) || "?",
      cover: (m.coverImage && m.coverImage.medium) || "",
      coverLarge: (m.coverImage && (m.coverImage.large || m.coverImage.medium)) || "",
      banner: m.bannerImage || "",
      color: (m.coverImage && m.coverImage.color) || "",
      episodes: m.episodes || 0,
      duration: m.duration || 0,
      format: m.format || "",
      genres: m.genres || [],
      studios: ((m.studios && m.studios.nodes) || []).map((s: any) => s.name),
    }
  }

  // The current list status and progress of every anime in the library, plus
  // the media of shows in progress that have no activity in the history yet.
  function readEntries(cache: DiaryCache): any[] {
    const out: any[] = []
    const collection: any = $anilist.getAnimeCollection(false)
    const lists: any[] = (collection && collection.MediaListCollection && collection.MediaListCollection.lists) || []
    for (const list of lists) {
      for (const e of (list.entries || [])) {
        const m = e && e.media
        if (!m || !m.id) continue
        const next = m.nextAiringEpisode && m.nextAiringEpisode.episode
        out.push({
          mediaId: m.id,
          status: e.status || list.status || "",
          progress: e.progress || 0,
          updatedAt: e.updatedAt || 0,
          episodes: m.episodes || 0,
          // Episodes out so far for an airing show.
          aired: next ? next - 1 : 0,
          // FINISHED, RELEASING, NOT_YET_RELEASED, HIATUS, CANCELLED
          airing: m.status || "",
          title: (m.title && (m.title.userPreferred || m.title.romaji || m.title.english)) || "?",
          cover: (m.coverImage && (m.coverImage.medium || m.coverImage.large)) || "",
        })
      }
    }
    return out
  }

  function readCache(): DiaryCache | null {
    try {
      const c = $storage.get<DiaryCache>(CACHE_KEY)
      if (c && c.userId && Array.isArray(c.activities) && c.media) return c
    } catch (e) {}
    return null
  }

  // ---------------------------------------------------------------------------
  // Page (runs inside the webview iframe)
  // ---------------------------------------------------------------------------

  const PAGE_HTML = `<!DOCTYPE html>
  <html lang="ru">
  <head>
  <meta charset="UTF-8">
  <style>
  :root {
    --bg: #0b0b0d; --paper: #131317; --paper2: #1a1a20; --line: #26262e;
    --text: #ececf1; --muted: #8a8a96; --brand: #7c6cf2; --on-brand: #fff;
    --yellow: #e6b422; --yellow-bg: rgba(230,180,34,.13);
    --green: #3fbf6a; --green-bg: rgba(63,191,106,.13);
    --gray: #6b6b76; --gray-bg: rgba(120,120,130,.13);
  }
  * { box-sizing: border-box; }
  html { background: var(--bg); color-scheme: dark; }
  /* Banner of the last watched anime, fading into the page */
  .hero { position: absolute; top: 0; left: 0; right: 0; height: 440px; pointer-events: none;
    background-size: cover; background-position: center 30%; opacity: .5;
    -webkit-mask-image: linear-gradient(to bottom, #000 0%, rgba(0,0,0,.55) 45%, transparent 100%);
    mask-image: linear-gradient(to bottom, #000 0%, rgba(0,0,0,.55) 45%, transparent 100%); }
  /* A portrait cover instead of a banner: blur it so it reads as colour */
  .hero.cover { filter: blur(28px) saturate(1.4); transform: scale(1.15); opacity: .6; }
  .wrap { position: relative; }
  body { position: relative; overflow-x: hidden; }
  html, body { margin: 0; color: var(--text);
    font: 14px/1.4 Inter, "Segoe UI", system-ui, sans-serif; }
  .wrap { padding: 8px 4px 32px; max-width: 1600px; margin: 0 auto; }
  h1 { font-size: 26px; margin: 0; font-weight: 700; letter-spacing: -.01em; }
  h2 { font-size: 17px; margin: 0 0 12px; font-weight: 650; }
  .muted { color: var(--muted); }
  .row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .spacer { flex: 1; }
  button { font: inherit; color: var(--text); background: var(--paper2); border: 1px solid var(--line);
    border-radius: 10px; padding: 7px 13px; cursor: pointer; }
  button:hover { border-color: #3a3a46; background: #202028; }
  button.primary { background: var(--brand); border-color: var(--brand); color: var(--on-brand); font-weight: 600; }
  button.primary:hover { filter: brightness(1.08); }
  section { background: rgba(19,19,23,.86); backdrop-filter: blur(6px); border: 1px solid var(--line); border-radius: 16px; padding: 16px; margin-top: 16px; }
  .head { min-height: 170px; align-items: flex-end; padding-bottom: 6px; }
  .head h1 { font-size: 34px; text-shadow: 0 2px 12px rgba(0,0,0,.6); }
  .head .last { font-size: 13px; color: #d4d4dc; text-shadow: 0 1px 6px rgba(0,0,0,.8); margin-top: 2px; }
  .status { font-size: 12px; }

  /* Unfinished */
  .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 10px; }
  .card { display: flex; gap: 10px; padding: 8px; background: var(--paper2); border: 1px solid var(--line);
    border-radius: 12px; cursor: pointer; align-items: center; }
  .card:hover { border-color: var(--yellow); }
  .card img { width: 46px; height: 64px; object-fit: cover; border-radius: 7px; flex: none; background: #222; }
  .card .t { font-weight: 600; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
  .card .s { font-size: 12px; color: var(--muted); margin-top: 2px; }
  .pill { display: inline-block; font-size: 11px; padding: 1px 7px; border-radius: 99px; margin-top: 4px; }
  .pill.y { background: var(--yellow-bg); color: var(--yellow); }
  .pill.b { background: rgba(124,108,242,.15); color: #a99ff7; }
  .pill.g { background: var(--green-bg); color: var(--green); }
  .pill + .pill { margin-left: 4px; }

  /* Calendar */
  .cal { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 6px; }
  .dow { font-size: 12px; color: var(--muted); padding: 0 6px 2px; }
  .day { min-height: 112px; background: var(--paper2); border: 1px solid var(--line); border-radius: 10px; padding: 6px; overflow: hidden; }
  .day.out { opacity: .35; }
  .day.today { border-color: var(--brand); box-shadow: inset 0 0 0 1px var(--brand); }
  .day .n { font-size: 12px; color: var(--muted); margin-bottom: 4px; display: flex; justify-content: space-between; }
  .day.today .n b { color: var(--brand); }
  .ev { display: flex; gap: 6px; align-items: center; padding: 3px 5px; border-radius: 7px; margin-bottom: 4px;
    cursor: pointer; border-left: 3px solid; font-size: 12px; }
  .ev img { width: 18px; height: 25px; object-fit: cover; border-radius: 3px; flex: none; }
  .ev .et { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; flex: 1; min-width: 0; }
  .ev .ep { color: var(--muted); flex: none; }
  .ev.y { background: var(--yellow-bg); border-color: var(--yellow); }
  .ev.g { background: var(--green-bg); border-color: var(--green); }
  .ev.x { background: var(--gray-bg); border-color: var(--gray); }
  .more { font-size: 11px; color: var(--muted); padding-left: 4px; cursor: pointer; }
  .legend { font-size: 12px; color: var(--muted); }
  .legend i { display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin: 0 5px 0 12px; vertical-align: -1px; }

  /* Year in review */
  .review { width: 100%; margin-top: 16px; background: radial-gradient(120% 60% at 0% 0%, rgba(124,108,242,.25), transparent 60%), var(--paper);
    border: 1px solid var(--line); border-radius: 20px; padding: 24px; }
  .big { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin: 18px 0; }
  .stat { background: var(--paper2); border: 1px solid var(--line); border-radius: 14px; padding: 14px; }
  .stat > b { display: block; font-size: 28px; line-height: 1.1; }
  .stat > span { font-size: 12px; color: var(--muted); }
  .moments p { margin: 0 0 10px; }
  .grid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 12px; }
  .bars { display: flex; align-items: flex-end; gap: 6px; height: 120px; padding-top: 8px; }
  .bar { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 4px; height: 100%; justify-content: flex-end; }
  .bar div { width: 100%; background: var(--brand); border-radius: 5px 5px 2px 2px; min-height: 2px; }
  .bar span { font-size: 10px; color: var(--muted); }
  .bar em { font-size: 10px; font-style: normal; }
  .top { display: flex; flex-direction: column; gap: 8px; }
  .topi { display: flex; gap: 10px; align-items: center; cursor: pointer; }
  .topi img { width: 34px; height: 48px; object-fit: cover; border-radius: 6px; }
  .topi .rank { width: 18px; color: var(--muted); font-weight: 700; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .chip { background: var(--paper2); border: 1px solid var(--line); border-radius: 99px; padding: 4px 10px; font-size: 13px; }
  .chip small { color: var(--muted); margin-left: 4px; }
  .empty { color: var(--muted); padding: 24px; text-align: center; }
  .error { color: #ff8a8a; }
  select { font: inherit; background: var(--paper2); color: var(--text); border: 1px solid var(--line); border-radius: 10px; padding: 6px 10px; }
  </style>
  </head>
  <body>
  <div class="hero" id="hero"></div>
  <div class="wrap" id="root"><div class="empty">Загружаю историю AniList…</div></div>
  <script>
  var DATA = null;
  var VIEW = new Date(); VIEW.setDate(1);
  var REVIEW_YEAR = null;
  var SHOW_ALL_UNFINISHED = false;
  var MONTHS = ["Январь","Февраль","Март","Апрель","Май","Июнь","Июль","Август","Сентябрь","Октябрь","Ноябрь","Декабрь"];
  var MONTHS_GEN = ["января","февраля","марта","апреля","мая","июня","июля","августа","сентября","октября","ноября","декабря"];
  var MONTHS_SHORT = ["янв","фев","мар","апр","май","июн","июл","авг","сен","окт","ноя","дек"];
  var DOW = ["Пн","Вт","Ср","Чт","Пт","Сб","Вс"];

  function esc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function plural(n, one, few, many) {
    var a = Math.abs(n) % 100, b = a % 10;
    if (a > 10 && a < 20) return many;
    if (b > 1 && b < 5) return few;
    if (b === 1) return one;
    return many;
  }
  function dayKey(d) { return d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate(); }
  function startOfDay(d) { var x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
  function ago(ts) {
    var days = Math.floor((startOfDay(new Date()) - startOfDay(new Date(ts))) / 86400000);
    if (days <= 0) return "сегодня";
    if (days === 1) return "вчера";
    if (days < 30) return days + " " + plural(days, "день", "дня", "дней") + " назад";
    var m = Math.floor(days / 30);
    if (m < 12) return m + " " + plural(m, "месяц", "месяца", "месяцев") + " назад";
    var y = Math.floor(days / 365);
    return y + " " + plural(y, "год", "года", "лет") + " назад";
  }
  function open(id) { if (id) window.webview.send("open", { id: id }); }

  // ---------- data helpers ----------
  function entryMap() {
    var m = {};
    (DATA.entries || []).forEach(function (e) { m[e.mediaId] = e; });
    return m;
  }
  function mediaOf(id) { return (DATA.media || {})[String(id)] || null; }
  function titleOf(id, entries) {
    var m = mediaOf(id); if (m) return m.title;
    var e = entries[id]; return e ? e.title : "?";
  }
  function coverOf(id, entries) {
    var m = mediaOf(id); if (m && m.cover) return m.cover;
    var e = entries[id]; return e ? e.cover : "";
  }
  // Episodes an activity covers (completed counts the final episode).
  function episodesOf(a) {
    if (a.kind === "watched" || a.kind === "rewatched") return a.to && a.from ? (a.to - a.from + 1) : 1;
    if (a.kind === "completed") return 1;
    return 0;
  }
  // Colour by the show's current status: g = finished, y = still watching, x = dropped/other.
  function colorOf(id, entries) {
    var e = entries[id];
    if (!e) return "x";
    if (e.status === "COMPLETED") return "g";
    if (e.episodes && e.progress >= e.episodes) return "g";
    if (e.status === "DROPPED") return "x";
    return "y";
  }
  function lastSeenMap() {
    var m = {};
    (DATA.activities || []).forEach(function (a) {
      if (episodesOf(a) > 0 && !m[a.mediaId]) m[a.mediaId] = a.at * 1000;
    });
    return m;
  }

  // ---------- unfinished ----------
  function renderUnfinished() {
    var entries = DATA.entries || [];
    var seen = lastSeenMap();
    var list = entries.filter(function (e) {
      if (e.status !== "CURRENT" && e.status !== "PAUSED" && e.status !== "REPEATING") return false;
      return !(e.episodes && e.progress >= e.episodes);
    }).map(function (e) {
      var last = Math.max(seen[e.mediaId] || 0, (e.updatedAt || 0) * 1000);
      return { e: e, last: last };
    }).sort(function (a, b) { return b.last - a.last; });

    if (list.length === 0) return '<section><h2>Недосмотренное</h2><div class="empty">Всё досмотрено 🎉</div></section>';

    var shown = SHOW_ALL_UNFINISHED ? list : list.slice(0, 12);
    var cards = shown.map(function (x) {
      var e = x.e;
      var total = e.episodes ? e.episodes : "?";
      var pills = [];
      if (e.aired && (!e.episodes || e.aired < e.episodes)) {
        // Still airing: how far behind the latest episode you are.
        var behind = e.aired - e.progress;
        pills.push(behind > 0
          ? '<span class="pill y">отстал на ' + behind + ' ' + plural(behind, "серию", "серии", "серий") + '</span>'
          : '<span class="pill b">догнал, ждём ' + (e.aired + 1) + '-ю</span>');
      } else if (e.airing === "FINISHED" && e.episodes > e.progress) {
        // Fully out: nothing to wait for, just what's left.
        var left = e.episodes - e.progress;
        pills.push('<span class="pill g">вышло всё · ' + plural(left, "осталась", "осталось", "осталось") + ' ' +
          left + ' ' + plural(left, "серия", "серии", "серий") + '</span>');
      }
      if (e.status === "PAUSED") pills.push('<span class="pill y">на паузе</span>');
      var pill = pills.length ? '<div>' + pills.join("") + '</div>' : "";
      return '<div class="card" data-open="' + e.mediaId + '">' +
        (e.cover ? '<img src="' + esc(e.cover) + '" loading="lazy">' : '<img>') +
        '<div><div class="t">' + esc(e.title) + '</div>' +
        '<div class="s">' + e.progress + ' / ' + total + (x.last ? ' · ' + ago(x.last) : '') + '</div>' + pill + '</div></div>';
    }).join("");
    var more = list.length > 12
      ? '<div style="margin-top:10px"><button data-act="toggle-unfinished">' +
        (SHOW_ALL_UNFINISHED ? 'Свернуть' : 'Показать все (' + list.length + ')') + '</button></div>'
      : '';
    return '<section><h2>Недосмотренное <span class="muted">· ' + list.length + '</span></h2><div class="cards">' + cards + '</div>' + more + '</section>';
  }

  // ---------- calendar ----------
  function renderCalendar() {
    var entries = entryMap();
    var byDay = {};
    (DATA.activities || []).forEach(function (a) {
      if (a.kind === "planning" || a.kind === "other") return;
      var k = dayKey(new Date(a.at * 1000));
      (byDay[k] = byDay[k] || []).push(a);
    });

    var y = VIEW.getFullYear(), mo = VIEW.getMonth();
    var first = new Date(y, mo, 1);
    var offset = (first.getDay() + 6) % 7; // Monday first
    var start = new Date(y, mo, 1 - offset);
    var todayKey = dayKey(new Date());

    var monthEpisodes = 0;
    var cells = "";
    for (var i = 0; i < 42; i++) {
      var d = new Date(start); d.setDate(start.getDate() + i);
      if (i >= 35 && d.getMonth() !== mo) break;
      var k = dayKey(d);
      var acts = (byDay[k] || []).slice().sort(function (a, b) { return a.at - b.at; });

      // One line per show per day, merging its episode ranges.
      var perShow = {}, order = [];
      acts.forEach(function (a) {
        var s = perShow[a.mediaId];
        if (!s) { s = perShow[a.mediaId] = { id: a.mediaId, from: 0, to: 0, completed: false, dropped: false, eps: 0 }; order.push(s); }
        if (a.kind === "watched" || a.kind === "rewatched") {
          if (a.from && (!s.from || a.from < s.from)) s.from = a.from;
          if (a.to && a.to > s.to) s.to = a.to;
        }
        if (a.kind === "completed") s.completed = true;
        if (a.kind === "dropped") s.dropped = true;
        s.eps += episodesOf(a);
      });
      if (d.getMonth() === mo) order.forEach(function (s) { monthEpisodes += s.eps; });

      var evs = order.slice(0, 4).map(function (s) {
        var ep = s.dropped && !s.eps ? "бросил" :
          s.from ? ("эп. " + (s.to && s.to !== s.from ? s.from + "–" + s.to : s.from)) : "";
        if (s.completed) ep = ep ? ep + " ✓" : "финал ✓";
        var cover = coverOf(s.id, entries);
        return '<div class="ev ' + colorOf(s.id, entries) + '" data-open="' + s.id + '" title="' + esc(titleOf(s.id, entries)) + '">' +
          (cover ? '<img src="' + esc(cover) + '" loading="lazy">' : '') +
          '<span class="et">' + esc(titleOf(s.id, entries)) + '</span><span class="ep">' + esc(ep) + '</span></div>';
      }).join("");
      var more = order.length > 4 ? '<div class="more" title="' + esc(order.slice(4).map(function (s) { return titleOf(s.id, entries); }).join(", ")) + '">ещё ' + (order.length - 4) + '</div>' : '';

      cells += '<div class="day' + (d.getMonth() !== mo ? ' out' : '') + (k === todayKey ? ' today' : '') + '">' +
        '<div class="n"><b>' + d.getDate() + '</b></div>' + evs + more + '</div>';
    }

    return '<section>' +
      '<div class="row" style="margin-bottom:12px">' +
        '<button data-act="prev">‹</button><h2 style="margin:0;min-width:170px;text-align:center">' + MONTHS[mo] + ' ' + y + '</h2><button data-act="next">›</button>' +
        '<button data-act="today">Сегодня</button>' +
        '<span class="muted" style="margin-left:6px">' + monthEpisodes + ' ' + plural(monthEpisodes, "серия", "серии", "серий") + ' за месяц</span>' +
        '<span class="spacer"></span>' +
        '<span class="legend"><i style="background:var(--yellow)"></i>смотрю<i style="background:var(--green)"></i>досмотрел<i style="background:var(--gray)"></i>бросил</span>' +
      '</div>' +
      '<div class="cal">' + DOW.map(function (n) { return '<div class="dow">' + n + '</div>'; }).join("") + cells + '</div>' +
      '</section>';
  }

  // ---------- year in review ----------
  function yearsInData() {
    var ys = {};
    (DATA.activities || []).forEach(function (a) { ys[new Date(a.at * 1000).getFullYear()] = 1; });
    return Object.keys(ys).map(Number).sort(function (a, b) { return b - a; });
  }

  function computeReview(year) {
    var entries = entryMap();
    var acts = (DATA.activities || []).filter(function (a) { return new Date(a.at * 1000).getFullYear() === year; })
      .sort(function (a, b) { return a.at - b.at; });

    var episodes = 0, minutes = 0, perMonth = [0,0,0,0,0,0,0,0,0,0,0,0], perDow = [0,0,0,0,0,0,0];
    var perDay = {}, perShow = {}, genres = {}, studios = {}, completed = {}, started = {}, planned = 0, dropped = 0;
    var firstShow = null;

    acts.forEach(function (a) {
      var d = new Date(a.at * 1000);
      var m = mediaOf(a.mediaId);
      if (a.kind === "planning") { planned++; return; }
      if (a.kind === "dropped") { dropped++; return; }
      var eps = episodesOf(a);
      if (!eps) return;
      if (!firstShow) firstShow = { id: a.mediaId, at: a.at };
      episodes += eps;
      minutes += eps * ((m && m.duration) || 24);
      perMonth[d.getMonth()] += eps;
      perDow[(d.getDay() + 6) % 7] += eps;
      var k = dayKey(d);
      var pd = perDay[k] = perDay[k] || { eps: 0, date: d, shows: {} };
      pd.eps += eps; pd.shows[a.mediaId] = 1;
      perShow[a.mediaId] = (perShow[a.mediaId] || 0) + eps;
      if (a.kind === "completed") completed[a.mediaId] = a.at;
      if (a.kind === "watched" && a.from === 1) started[a.mediaId] = 1;
      if (m) {
        (m.genres || []).forEach(function (g) { genres[g] = (genres[g] || 0) + eps; });
        (m.studios || []).forEach(function (s) { studios[s] = (studios[s] || 0) + eps; });
      }
    });

    // Longest run of consecutive days with something watched.
    var days = Object.keys(perDay).map(function (k) { return startOfDay(perDay[k].date).getTime(); }).sort(function (a, b) { return a - b; });
    var streak = 0, best = 0, prev = 0, bestEnd = 0;
    days.forEach(function (t) {
      streak = prev && Math.round((t - prev) / 86400000) === 1 ? streak + 1 : 1;
      if (streak > best) { best = streak; bestEnd = t; }
      prev = t;
    });

    var bestDay = null;
    Object.keys(perDay).forEach(function (k) { if (!bestDay || perDay[k].eps > bestDay.eps) bestDay = perDay[k]; });

    function top(obj, n) {
      return Object.keys(obj).map(function (k) { return [k, obj[k]]; }).sort(function (a, b) { return b[1] - a[1]; }).slice(0, n);
    }
    var lastCompleted = null;
    Object.keys(completed).forEach(function (id) { if (!lastCompleted || completed[id] > lastCompleted.at) lastCompleted = { id: Number(id), at: completed[id] }; });

    return {
      year: year, entries: entries, episodes: episodes, hours: Math.round(minutes / 60), shows: Object.keys(perShow).length,
      completed: Object.keys(completed).length, started: Object.keys(started).length, planned: planned, dropped: dropped,
      activeDays: days.length, streak: best, streakEnd: bestEnd, bestDay: bestDay, perMonth: perMonth, perDow: perDow,
      topShows: top(perShow, 5), topGenres: top(genres, 8), topStudios: top(studios, 6),
      firstShow: firstShow, lastCompleted: lastCompleted,
    };
  }

  function renderReview() {
    if (REVIEW_YEAR === null) return "";
    var years = yearsInData();
    if (years.indexOf(REVIEW_YEAR) < 0 && years.length) REVIEW_YEAR = years[0];
    var r = computeReview(REVIEW_YEAR);
    var e = r.entries;

    function stat(v, label) { return '<div class="stat"><b>' + v + '</b><span>' + label + '</span></div>'; }
    function bars(values, labels) {
      var max = Math.max.apply(null, values.concat([1]));
      return '<div class="bars">' + values.map(function (v, i) {
        return '<div class="bar"><em>' + (v || "") + '</em><div style="height:' + Math.round(v / max * 100) + '%"></div><span>' + labels[i] + '</span></div>';
      }).join("") + '</div>';
    }
    var bestDow = r.perDow.indexOf(Math.max.apply(null, r.perDow));
    var DOW_FULL = ["понедельник","вторник","среда","четверг","пятница","суббота","воскресенье"];

    var body = r.episodes === 0
      ? '<div class="empty">За ' + r.year + ' год в истории AniList нет просмотренных серий.</div>'
      : '<div class="big">' +
          stat(r.episodes, plural(r.episodes, "серия", "серии", "серий")) +
          stat(r.hours, plural(r.hours, "час", "часа", "часов") + " просмотра") +
          stat(r.shows, plural(r.shows, "тайтл", "тайтла", "тайтлов")) +
          stat(r.completed, "досмотрено до конца") +
          stat(r.activeDays, plural(r.activeDays, "день", "дня", "дней") + " с аниме") +
          stat(r.streak, plural(r.streak, "день", "дня", "дней") + " подряд — рекорд") +
        '</div>' +
        '<div class="grid2">' +
          '<div class="stat"><h2>По месяцам</h2>' + bars(r.perMonth, MONTHS_SHORT) + '</div>' +
          '<div class="stat"><h2>По дням недели</h2>' + bars(r.perDow, DOW) +
            '<div class="muted" style="margin-top:8px">Самый анимешный день — ' + DOW_FULL[bestDow] + '</div></div>' +
          '<div class="stat"><h2>Больше всего серий</h2><div class="top">' + r.topShows.map(function (t, i) {
            var id = Number(t[0]); var c = coverOf(id, e);
            return '<div class="topi" data-open="' + id + '"><span class="rank">' + (i + 1) + '</span>' + (c ? '<img src="' + esc(c) + '">' : '') +
              '<div><div>' + esc(titleOf(id, e)) + '</div><div class="muted" style="font-size:12px">' + t[1] + ' ' + plural(t[1], "серия", "серии", "серий") + '</div></div></div>';
          }).join("") + '</div></div>' +
          '<div class="stat"><h2>Жанры</h2><div class="chips">' + r.topGenres.map(function (g) {
            return '<span class="chip">' + esc(g[0]) + '<small>' + g[1] + '</small></span>'; }).join("") + '</div>' +
            '<h2 style="margin-top:16px">Студии</h2><div class="chips">' + r.topStudios.map(function (s) {
            return '<span class="chip">' + esc(s[0]) + '<small>' + s[1] + '</small></span>'; }).join("") + '</div></div>' +
          '<div class="stat moments"><h2>Моменты года</h2>' +
            (r.bestDay ? '<p>🔥 Рекорд за день: <b>' + r.bestDay.eps + ' ' + plural(r.bestDay.eps, "серия", "серии", "серий") + '</b> — ' +
              r.bestDay.date.getDate() + ' ' + MONTHS_GEN[r.bestDay.date.getMonth()] + '</p>' : '') +
            (r.firstShow ? '<p>🌅 Год начался с <b>' + esc(titleOf(r.firstShow.id, e)) + '</b></p>' : '') +
            (r.lastCompleted ? '<p>🏁 Последнее досмотренное: <b>' + esc(titleOf(r.lastCompleted.id, e)) + '</b></p>' : '') +
            '<p>📌 Добавлено в планы: <b>' + r.planned + '</b>' + (r.dropped ? ' · брошено: <b>' + r.dropped + '</b>' : '') + '</p>' +
          '</div>' +
        '</div>';

    var yearSelect = years.length > 1
      ? '<select data-act="year">' + years.map(function (y) { return '<option' + (y === r.year ? ' selected' : '') + '>' + y + '</option>'; }).join("") + '</select>'
      : '';
    return '<div class="review">' +
      '<div class="row"><button data-act="close">← Назад к дневнику</button><h1 style="margin-left:6px">Итоги ' + r.year + ' года</h1><span class="spacer"></span>' + yearSelect + '</div>' +
      '<div class="muted" style="margin-top:6px">По истории AniList' + (r.year === new Date().getFullYear() ? ' — год ещё идёт' : '') + '</div>' +
      body + '</div>';
  }

  // ---------- theme ----------
  function lastWatched() {
    var acts = DATA.activities || [];
    for (var i = 0; i < acts.length; i++) {
      if (episodesOf(acts[i]) > 0) { var m = mediaOf(acts[i].mediaId); if (m) return m; }
    }
    return null;
  }
  function hexToRgb(h) {
    if (!h || h.charAt(0) !== "#" || h.length !== 7) return null;
    return [parseInt(h.substr(1, 2), 16), parseInt(h.substr(3, 2), 16), parseInt(h.substr(5, 2), 16)];
  }
  // Banner (or blurred cover) and accent colour of the last watched anime.
  // The colour is used only if it's neither too dark nor too washed out.
  function applyTheme() {
    var m = DATA && DATA.activities ? lastWatched() : null;
    var hero = document.getElementById("hero");
    var img = m && (m.banner || m.coverLarge || m.cover);
    hero.style.backgroundImage = img ? 'url("' + String(img).replace(/"/g, "%22") + '")' : "none";
    hero.className = "hero" + (m && !m.banner ? " cover" : "");

    var css = document.documentElement.style;
    var rgb = m && hexToRgb(m.color);
    var brand = "#7c6cf2", onBrand = "#fff";
    if (rgb) {
      var lum = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
      var spread = Math.max(rgb[0], rgb[1], rgb[2]) - Math.min(rgb[0], rgb[1], rgb[2]);
      if (lum > 0.22 && lum < 0.85 && spread > 40) {
        brand = m.color;
        onBrand = lum > 0.6 ? "#111" : "#fff";
      }
    }
    css.setProperty("--brand", brand);
    css.setProperty("--on-brand", onBrand);
    return m;
  }

  // ---------- shell ----------
  function render() {
    var root = document.getElementById("root");
    if (!DATA) { root.innerHTML = '<div class="empty">Загружаю историю AniList…</div>'; return; }
    if (DATA.error && !DATA.activities) { root.innerHTML = '<div class="empty error">' + esc(DATA.error) + '</div>'; return; }

    var status = DATA.loading ? "обновляю…" :
      DATA.error ? '<span class="error">' + esc(DATA.error) + '</span>' :
      DATA.partial ? "история загружена не полностью, догружу при следующем открытии" :
      (DATA.activities ? DATA.activities.length + " записей из AniList" : "");
    var years = DATA.activities ? yearsInData() : [];
    var reviewYear = years.length ? years[0] : new Date().getFullYear();

    var last = applyTheme();
    if (REVIEW_YEAR !== null && DATA.activities) {
      root.innerHTML = renderReview();
      return;
    }
    root.innerHTML =
      '<div class="row head"><div><h1>Anime Diary</h1>' +
        (last ? '<div class="last">Последнее: ' + esc(last.title) + '</div>' : '') +
        '</div><span class="spacer"></span>' +
        '<span class="status muted">' + status + '</span>' +
        '<button data-act="refresh" title="Подтянуть новое из AniList">Обновить</button>' +
        '<button class="primary" data-act="review" data-year="' + reviewYear + '">🎉 Итоги ' + reviewYear + '</button>' +
      '</div>' +
      (DATA.activities ? renderUnfinished() + renderCalendar() : '');
  }

  document.addEventListener("click", function (ev) {
    var el = ev.target.closest ? ev.target.closest("[data-open],[data-act]") : null;
    if (!el) return;
    var id = el.getAttribute("data-open");
    if (id) { open(Number(id)); return; }
    var act = el.getAttribute("data-act");
    if (act === "prev") { VIEW.setMonth(VIEW.getMonth() - 1); render(); }
    else if (act === "next") { VIEW.setMonth(VIEW.getMonth() + 1); render(); }
    else if (act === "today") { VIEW = new Date(); VIEW.setDate(1); render(); }
    else if (act === "refresh") { window.webview.send("refresh", {}); }
    else if (act === "review") { REVIEW_YEAR = Number(el.getAttribute("data-year")); render(); }
    else if (act === "close") { REVIEW_YEAR = null; render(); }
    else if (act === "toggle-unfinished") { SHOW_ALL_UNFINISHED = !SHOW_ALL_UNFINISHED; render(); }
  });
  document.addEventListener("change", function (ev) {
    if (ev.target && ev.target.getAttribute && ev.target.getAttribute("data-act") === "year") {
      REVIEW_YEAR = Number(ev.target.value); render();
    }
  });

  window.webview.on("data", function (d) { DATA = d; render(); });
  render();
  </script>
  </body>
  </html>`

  // Loads the history (only new activities unless `full`) and the library,
  // and returns what the page renders. Errors come back as { error }.
  function loadPayload(full: boolean, previous: any): any {
    try {
      const token = $database.anilist.getToken()
      if (!token) return { error: "Нет входа в AniList: войди в аккаунт в Seanime." }

      let cache = full ? null : readCache()
      const userId = cache ? cache.userId : viewerId(token)
      if (!cache || cache.userId !== userId) cache = { userId, activities: [], media: {} }

      const partial = fetchNewActivities(token, cache)
      $storage.set(CACHE_KEY, cache)

      return {
        activities: cache.activities,
        media: cache.media,
        entries: readEntries(cache),
        partial,
        updatedAt: Date.now(),
      }
    } catch (e) {
      console.error("Anime Diary: " + e)
      return Object.assign({}, previous || {}, { loading: false, error: "Не удалось загрузить историю AniList: " + e })
    }
  }

  return { ICON, PAGE_HTML, loadPayload }
}
