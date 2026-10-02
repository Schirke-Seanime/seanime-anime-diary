/// <reference path="./plugin.d.ts" />
/// <reference path="./app.d.ts" />
/// <reference path="./core.d.ts" />

// Anime Diary: a sidebar page with a calendar of what you watched and when,
// a heatmap of the year, the shows you started and didn't finish, notes for
// any day, and a year in review. English and Russian.
//
// The history comes from your AniList activity feed (Seanime posts an
// activity for every episode you mark as watched), cached in plugin storage
// and topped up with new activities on every load. Preferences and notes
// stay in plugin storage and never go to AniList.

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
  coverLarge: string
  banner: string
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

interface DiaryPrefs {
  lang: string   // "en" | "ru"
  sort: string   // "recent" | "remaining"
  view: string   // "month" | "year"
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
      // A screen-tall frame that scrolls itself, rather than one sized to fit
      // its content: in a frame with nothing to scroll, Chrome's middle-click
      // autoscroll gets stuck and the wheel stops working until the next click.
      height: "100vh",
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
    page.channel.on("set-prefs", (p: any) => {
      payload.set(Object.assign({}, payload.get() || {}, { prefs: D.savePrefs(p) }))
    })
    page.channel.on("save-note", (p: any) => {
      if (!p || !p.day) return
      payload.set(Object.assign({}, payload.get() || {}, { notes: D.saveNote(String(p.day), String(p.text || "")) }))
    })

    // On start, and again every time the page is opened: only new
    // activities are fetched, so this is a single request most of the time.
    load(false)
    page.onMount(() => load(false))
  })
}

// Everything the plugin does. Self-contained: compiled from its own source
// by $shared, so it may only use globals ($anilist, $storage, ...).
// Keep it free of anything esbuild compiles into top-level helpers (tagged
// templates like String.raw, for one): those would be outside this function.
function createAnimeDiary() {
  // v2: media gained banner and large cover, so older caches are fetched again.
  const CACHE_KEY = "diary-cache-v2"
  const PREFS_KEY = "diary-prefs"
  const NOTES_KEY = "diary-notes"
  // AniList returns at most 50 activities per page; stop after this many pages
  // (5000 activities) on a first load.
  const MAX_PAGES = 100
  const MAX_NOTE_LENGTH = 2000

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
    if (!id) throw new Error("could not get the AniList user")
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

  // The current list status and progress of every anime in the library.
  function readEntries(): any[] {
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
  // Preferences and notes
  // ---------------------------------------------------------------------------

  function cleanPrefs(p: any): DiaryPrefs {
    p = p || {}
    return {
      lang: p.lang === "ru" ? "ru" : "en",
      sort: p.sort === "remaining" ? "remaining" : "recent",
      view: p.view === "year" ? "year" : "month",
    }
  }

  function readPrefs(): DiaryPrefs {
    try { return cleanPrefs($storage.get(PREFS_KEY)) } catch (e) { return cleanPrefs(null) }
  }

  function savePrefs(p: any): DiaryPrefs {
    const prefs = cleanPrefs(Object.assign({}, readPrefs(), p || {}))
    $storage.set(PREFS_KEY, prefs)
    return prefs
  }

  function readNotes(): { [day: string]: string } {
    try {
      const n = $storage.get(NOTES_KEY)
      return n && typeof n === "object" ? n : {}
    } catch (e) {
      return {}
    }
  }

  // An empty note deletes the day's note.
  function saveNote(day: string, text: string): { [day: string]: string } {
    const notes = readNotes()
    const value = text.trim().slice(0, MAX_NOTE_LENGTH)
    if (value) notes[day] = value
    else delete notes[day]
    $storage.set(NOTES_KEY, notes)
    return notes
  }

  // ---------------------------------------------------------------------------
  // Page (runs inside the webview iframe). A plain template literal: no
  // backslashes and no interpolation inside, so nothing to escape.
  // ---------------------------------------------------------------------------

  const PAGE_HTML = `<!DOCTYPE html>
<html>
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
  html { background: var(--bg); color-scheme: dark; scrollbar-width: thin; scrollbar-color: #3a3a46 transparent; }
  /* Banner of the last watched anime, fading into the page */
  .hero { position: absolute; top: 0; left: 0; right: 0; height: 440px; pointer-events: none;
    background-size: cover; background-position: center 30%; opacity: .5;
    -webkit-mask-image: linear-gradient(to bottom, #000 0%, rgba(0,0,0,.55) 45%, transparent 100%);
    mask-image: linear-gradient(to bottom, #000 0%, rgba(0,0,0,.55) 45%, transparent 100%); }
  /* A portrait cover instead of a banner: blur it so it reads as colour */
  .hero.cover { filter: blur(28px) saturate(1.4); transform: scale(1.15); opacity: .6; }
  .wrap { position: relative; padding: 8px 4px 32px; max-width: 1600px; margin: 0 auto; }
  body { position: relative; overflow-x: hidden; }
  html, body { margin: 0; color: var(--text); font: 14px/1.4 Inter, "Segoe UI", system-ui, sans-serif; }
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
  .seg { display: inline-flex; background: var(--paper2); border: 1px solid var(--line); border-radius: 10px; padding: 2px; }
  .seg button { border: 0; background: transparent; padding: 5px 11px; border-radius: 8px; color: var(--muted); }
  .seg button.on { background: var(--brand); color: var(--on-brand); font-weight: 600; }
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
  .day { min-height: 112px; background: var(--paper2); border: 1px solid var(--line); border-radius: 10px; padding: 6px; overflow: hidden; cursor: pointer; }
  .day:hover { border-color: #3a3a46; }
  .day.out { opacity: .35; }
  .day.today { border-color: var(--brand); box-shadow: inset 0 0 0 1px var(--brand); }
  .day.sel { background: #22222b; border-color: var(--text); }
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
  .more { font-size: 11px; color: var(--muted); padding-left: 4px; }
  .legend { font-size: 12px; color: var(--muted); }
  .legend i { display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin: 0 5px 0 12px; vertical-align: -1px; }

  /* Heatmap */
  /* --cell is set from the available width by fitHeatmaps() */
  .heat { overflow-x: auto; padding-bottom: 4px; --cell: 14px; }
  .heat-months { display: grid; grid-auto-flow: column; grid-auto-columns: var(--cell); gap: 3px; margin-left: 30px; font-size: 11px; color: var(--muted); height: 16px; }
  .heat-months span { white-space: nowrap; }
  .heat-body { display: flex; gap: 6px; }
  .heat-days { display: grid; grid-template-rows: repeat(7, var(--cell)); gap: 3px; font-size: 10px; color: var(--muted); width: 24px; align-items: center; }
  .heat-grid { display: grid; grid-auto-flow: column; grid-template-rows: repeat(7, var(--cell)); grid-auto-columns: var(--cell); gap: 3px; }
  .hc { width: var(--cell); height: var(--cell); border-radius: 3px; background: var(--paper2); cursor: pointer; }
  .heat-legend .hc { width: 12px; height: 12px; }
  .hc.none { visibility: hidden; cursor: default; }
  .hc.l1 { background: color-mix(in srgb, var(--brand) 30%, var(--paper2)); }
  .hc.l2 { background: color-mix(in srgb, var(--brand) 55%, var(--paper2)); }
  .hc.l3 { background: color-mix(in srgb, var(--brand) 80%, var(--paper2)); }
  .hc.l4 { background: var(--brand); }
  .hc.today { outline: 1px solid var(--text); outline-offset: 1px; }
  .hc.sel { outline: 2px solid var(--text); outline-offset: 1px; }
  .hc.note { box-shadow: inset 0 0 0 2px var(--yellow); }
  .heat-legend { display: flex; align-items: center; gap: 3px; font-size: 11px; color: var(--muted); margin-top: 8px; }
  .heat-legend .hc { cursor: default; }

  /* Day details */
  .dayp .item { display: flex; gap: 10px; align-items: center; padding: 6px 0; border-top: 1px solid var(--line); }
  .dayp .item:first-of-type { border-top: 0; }
  .dayp .time { width: 72px; white-space: nowrap; color: var(--muted); font-variant-numeric: tabular-nums; flex: none; }
  .dayp img { width: 30px; height: 42px; object-fit: cover; border-radius: 5px; flex: none; }
  .dayp .ttl { cursor: pointer; font-weight: 600; }
  .dayp .ttl:hover { text-decoration: underline; }
  .dot { width: 8px; height: 8px; border-radius: 99px; flex: none; }
  .dot.y { background: var(--yellow); } .dot.g { background: var(--green); } .dot.x { background: var(--gray); }
  textarea { width: 100%; min-height: 90px; resize: vertical; font: inherit; color: var(--text); background: var(--paper2);
    border: 1px solid var(--line); border-radius: 10px; padding: 10px; }
  textarea:focus { outline: none; border-color: var(--brand); }
  .note-flag { font-size: 11px; }

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
<div class="wrap" id="root"><div class="empty">Loading your AniList history…</div></div>
<script>
var DATA = null;
var VIEW = new Date(); VIEW.setDate(1);
var HEAT_YEAR = new Date().getFullYear();
var REVIEW_YEAR = null;
var SHOW_ALL_UNFINISHED = false;
var SELECTED_DAY = null;   // "Y-M-D"
var DRAFTS = {};           // unsaved note text per day
var SAVED_DAY = null;      // shows "Saved" until the next change
var PREFS = { lang: "en", sort: "recent", view: "month" };

// ---------- texts ----------
function ruPlural(n, one, few, many) {
  var a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}
function en(n, one, many) { return n === 1 ? one : many; }

var TEXT = {
  en: {
    locale: "en-US",
    loading: "Loading your AniList history…",
    lastWatched: "Last watched: ",
    entries: function (n) { return n + " " + en(n, "entry", "entries") + " from AniList"; },
    updating: "updating…",
    partial: "history not fully loaded yet, the rest comes next time",
    refresh: "Refresh", refreshTip: "Fetch new activity from AniList",
    reviewBtn: function (y) { return "🎉 " + y + " in review"; },
    errNoToken: "Not logged in to AniList: log in in Seanime.",
    errLoad: "Couldn't load your AniList history: ",
    unfinished: "Unfinished", allDone: "All caught up 🎉",
    sortRecent: "Recent", sortRemaining: "Almost done",
    showAll: function (n) { return "Show all (" + n + ")"; }, showLess: "Show less",
    behind: function (n) { return n + " " + en(n, "episode", "episodes") + " behind"; },
    caughtUp: function (n) { return "caught up, ep. " + n + " next"; },
    allOut: function (n) { return "all out · " + n + " left"; },
    paused: "paused",
    today: "today", yesterday: "yesterday",
    daysAgo: function (n) { return n + " " + en(n, "day", "days") + " ago"; },
    monthsAgo: function (n) { return n + " " + en(n, "month", "months") + " ago"; },
    yearsAgo: function (n) { return n + " " + en(n, "year", "years") + " ago"; },
    todayBtn: "Today", month: "Month", year: "Year",
    monthEpisodes: function (n) { return n + " " + en(n, "episode", "episodes") + " this month"; },
    yearEpisodes: function (n) { return n + " " + en(n, "episode", "episodes") + " this year"; },
    watching: "watching", finished: "finished", droppedLegend: "dropped",
    ep: "ep. ", finale: "finale ✓", dropped: "dropped", more: function (n) { return "+" + n + " more"; },
    less: "Less", moreHeat: "More",
    heatTip: function (date, n) { return date + ": " + (n ? n + " " + en(n, "episode", "episodes") : "nothing watched"); },
    nothingThisDay: "Nothing watched this day.",
    addedToPlanning: "added to planning", pausedKind: "paused", completed: "completed ✓",
    note: "Note", notePlaceholder: "What do you want to remember about this day?",
    save: "Save", saved: "Saved", close: "Close",
    reviewTitle: function (y) { return y + " in review"; },
    back: "← Back to the diary",
    fromAniList: "From your AniList history", ongoingYear: " — the year isn't over yet",
    noEpisodes: function (y) { return "No episodes watched in " + y + " in your AniList history."; },
    statEpisodes: function (n) { return en(n, "episode", "episodes"); },
    statHours: function (n) { return en(n, "hour", "hours") + " watched"; },
    statShows: function (n) { return en(n, "show", "shows"); },
    statCompleted: "completed",
    statDays: function (n) { return en(n, "day", "days") + " with anime"; },
    statStreak: function (n) { return en(n, "day", "days") + " in a row — best streak"; },
    byMonth: "By month", byWeekday: "By weekday", yearByDay: "Year by day",
    animeDay: function (d) { return "Your anime day is " + d; },
    mostEpisodes: "Most episodes", genres: "Genres", studios: "Studios", highlights: "Highlights",
    epCount: function (n) { return n + " " + en(n, "episode", "episodes"); },
    bestDay: function (n, date) { return "🔥 Best day: <b>" + n + " " + en(n, "episode", "episodes") + "</b> — " + date; },
    started: function (t) { return "🌅 The year started with <b>" + t + "</b>"; },
    lastCompleted: function (t) { return "🏁 Last completed: <b>" + t + "</b>"; },
    planned: function (n, d) { return "📌 Added to planning: <b>" + n + "</b>" + (d ? " · dropped: <b>" + d + "</b>" : ""); },
  },
  ru: {
    locale: "ru-RU",
    loading: "Загружаю историю AniList…",
    lastWatched: "Последнее: ",
    entries: function (n) { return n + " " + ruPlural(n, "запись", "записи", "записей") + " из AniList"; },
    updating: "обновляю…",
    partial: "история загружена не полностью, догружу при следующем открытии",
    refresh: "Обновить", refreshTip: "Подтянуть новое из AniList",
    reviewBtn: function (y) { return "🎉 Итоги " + y; },
    errNoToken: "Нет входа в AniList: войди в аккаунт в Seanime.",
    errLoad: "Не удалось загрузить историю AniList: ",
    unfinished: "Недосмотренное", allDone: "Всё досмотрено 🎉",
    sortRecent: "Недавние", sortRemaining: "Почти досмотрено",
    showAll: function (n) { return "Показать все (" + n + ")"; }, showLess: "Свернуть",
    behind: function (n) { return "отстал на " + n + " " + ruPlural(n, "серию", "серии", "серий"); },
    caughtUp: function (n) { return "догнал, ждём " + n + "-ю"; },
    allOut: function (n) { return "вышло всё · " + ruPlural(n, "осталась", "осталось", "осталось") + " " + n + " " + ruPlural(n, "серия", "серии", "серий"); },
    paused: "на паузе",
    today: "сегодня", yesterday: "вчера",
    daysAgo: function (n) { return n + " " + ruPlural(n, "день", "дня", "дней") + " назад"; },
    monthsAgo: function (n) { return n + " " + ruPlural(n, "месяц", "месяца", "месяцев") + " назад"; },
    yearsAgo: function (n) { return n + " " + ruPlural(n, "год", "года", "лет") + " назад"; },
    todayBtn: "Сегодня", month: "Месяц", year: "Год",
    monthEpisodes: function (n) { return n + " " + ruPlural(n, "серия", "серии", "серий") + " за месяц"; },
    yearEpisodes: function (n) { return n + " " + ruPlural(n, "серия", "серии", "серий") + " за год"; },
    watching: "смотрю", finished: "досмотрел", droppedLegend: "бросил",
    ep: "эп. ", finale: "финал ✓", dropped: "бросил", more: function (n) { return "ещё " + n; },
    less: "Меньше", moreHeat: "Больше",
    heatTip: function (date, n) { return date + ": " + (n ? n + " " + ruPlural(n, "серия", "серии", "серий") : "ничего не смотрел"); },
    nothingThisDay: "В этот день ничего не смотрел.",
    addedToPlanning: "добавил в планы", pausedKind: "отложил", completed: "досмотрел ✓",
    note: "Заметка", notePlaceholder: "Что хочешь запомнить об этом дне?",
    save: "Сохранить", saved: "Сохранено", close: "Закрыть",
    reviewTitle: function (y) { return "Итоги " + y + " года"; },
    back: "← Назад к дневнику",
    fromAniList: "По истории AniList", ongoingYear: " — год ещё идёт",
    noEpisodes: function (y) { return "За " + y + " год в истории AniList нет просмотренных серий."; },
    statEpisodes: function (n) { return ruPlural(n, "серия", "серии", "серий"); },
    statHours: function (n) { return ruPlural(n, "час", "часа", "часов") + " просмотра"; },
    statShows: function (n) { return ruPlural(n, "тайтл", "тайтла", "тайтлов"); },
    statCompleted: "досмотрено до конца",
    statDays: function (n) { return ruPlural(n, "день", "дня", "дней") + " с аниме"; },
    statStreak: function (n) { return ruPlural(n, "день", "дня", "дней") + " подряд — рекорд"; },
    byMonth: "По месяцам", byWeekday: "По дням недели", yearByDay: "Год по дням",
    animeDay: function (d) { return "Самый анимешный день — " + d; },
    mostEpisodes: "Больше всего серий", genres: "Жанры", studios: "Студии", highlights: "Моменты года",
    epCount: function (n) { return n + " " + ruPlural(n, "серия", "серии", "серий"); },
    bestDay: function (n, date) { return "🔥 Рекорд за день: <b>" + n + " " + ruPlural(n, "серия", "серии", "серий") + "</b> — " + date; },
    started: function (t) { return "🌅 Год начался с <b>" + t + "</b>"; },
    lastCompleted: function (t) { return "🏁 Последнее досмотренное: <b>" + t + "</b>"; },
    planned: function (n, d) { return "📌 Добавлено в планы: <b>" + n + "</b>" + (d ? " · брошено: <b>" + d + "</b>" : ""); },
  },
};
function T() { return TEXT[PREFS.lang] || TEXT.en; }

// Month and weekday names come from the browser for the chosen language.
function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
function monthName(m) { return cap(new Date(2026, m, 1).toLocaleString(T().locale, { month: "long" })); }
function monthShort(m) { return new Date(2026, m, 1).toLocaleString(T().locale, { month: "short" }).replace(".", ""); }
// 0 = Monday
function weekdayShort(i) { return cap(new Date(2024, 0, 1 + i).toLocaleString(T().locale, { weekday: "short" })); }
function weekdayLong(i) { return new Date(2024, 0, 1 + i).toLocaleString(T().locale, { weekday: "long" }); }
function dateLong(d) { return cap(d.toLocaleDateString(T().locale, { weekday: "long", day: "numeric", month: "long", year: "numeric" })); }
function dateShort(d) { return d.toLocaleDateString(T().locale, { day: "numeric", month: "long" }); }
function timeOf(d) { return d.toLocaleTimeString(T().locale, { hour: "2-digit", minute: "2-digit" }); }

// ---------- helpers ----------
function esc(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function dayKey(d) { return d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate(); }
function parseDay(k) { var p = k.split("-"); return new Date(+p[0], +p[1] - 1, +p[2]); }
function startOfDay(d) { var x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function ago(ts) {
  var t = T();
  var days = Math.floor((startOfDay(new Date()) - startOfDay(new Date(ts))) / 86400000);
  if (days <= 0) return t.today;
  if (days === 1) return t.yesterday;
  if (days < 30) return t.daysAgo(days);
  var m = Math.floor(days / 30);
  if (m < 12) return t.monthsAgo(m);
  return t.yearsAgo(Math.floor(days / 365));
}
function send(ev, p) { window.webview.send(ev, p || {}); }
function setPref(p) {
  for (var k in p) PREFS[k] = p[k];
  send("set-prefs", p);
  render();
}

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
function activitiesByDay() {
  var by = {};
  (DATA.activities || []).forEach(function (a) {
    var k = dayKey(new Date(a.at * 1000));
    (by[k] = by[k] || []).push(a);
  });
  return by;
}
function episodesByDay() {
  var by = {};
  (DATA.activities || []).forEach(function (a) {
    var n = episodesOf(a); if (!n) return;
    var k = dayKey(new Date(a.at * 1000));
    by[k] = (by[k] || 0) + n;
  });
  return by;
}
// One line per show per day, merging its episode ranges.
function showsOfDay(acts) {
  var perShow = {}, order = [];
  acts.slice().sort(function (a, b) { return a.at - b.at; }).forEach(function (a) {
    if (a.kind === "planning" || a.kind === "other") return;
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
  return order;
}
function episodeLabel(s) {
  var t = T();
  var ep = s.dropped && !s.eps ? t.dropped : s.from ? (t.ep + (s.to && s.to !== s.from ? s.from + "–" + s.to : s.from)) : "";
  if (s.completed) ep = ep ? ep + " ✓" : t.finale;
  return ep;
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
    if (lum > 0.22 && lum < 0.85 && spread > 40) { brand = m.color; onBrand = lum > 0.6 ? "#111" : "#fff"; }
  }
  css.setProperty("--brand", brand);
  css.setProperty("--on-brand", onBrand);
  return m;
}

// ---------- unfinished ----------
function lastSeenMap() {
  var m = {};
  (DATA.activities || []).forEach(function (a) {
    if (episodesOf(a) > 0 && !m[a.mediaId]) m[a.mediaId] = a.at * 1000;
  });
  return m;
}
// Episodes you could watch right now: what's left of a finished show, or
// what's aired and not watched of an airing one.
function availableLeft(e) {
  if (e.aired && (!e.episodes || e.aired < e.episodes)) return e.aired - e.progress;
  if (e.episodes) return e.episodes - e.progress;
  return 0;
}
function renderUnfinished() {
  var t = T();
  var seen = lastSeenMap();
  var list = (DATA.entries || []).filter(function (e) {
    if (e.status !== "CURRENT" && e.status !== "PAUSED" && e.status !== "REPEATING") return false;
    return !(e.episodes && e.progress >= e.episodes);
  }).map(function (e) {
    return { e: e, last: Math.max(seen[e.mediaId] || 0, (e.updatedAt || 0) * 1000), left: availableLeft(e) };
  });

  list.sort(function (a, b) { return b.last - a.last; });
  if (PREFS.sort === "remaining") {
    // Fewest episodes left first; caught-up airing shows (nothing to watch) last.
    list.sort(function (a, b) {
      var al = a.left > 0 ? a.left : 1e9, bl = b.left > 0 ? b.left : 1e9;
      return al - bl || b.last - a.last;
    });
  }

  var sortSeg = '<span class="seg">' +
    '<button data-act="sort" data-v="recent" class="' + (PREFS.sort === "recent" ? "on" : "") + '">' + t.sortRecent + '</button>' +
    '<button data-act="sort" data-v="remaining" class="' + (PREFS.sort === "remaining" ? "on" : "") + '">' + t.sortRemaining + '</button></span>';
  var head = '<div class="row" style="margin-bottom:12px"><h2 style="margin:0">' + t.unfinished +
    ' <span class="muted">· ' + list.length + '</span></h2><span class="spacer"></span>' + (list.length ? sortSeg : '') + '</div>';
  if (list.length === 0) return '<section>' + head + '<div class="empty">' + t.allDone + '</div></section>';

  var shown = SHOW_ALL_UNFINISHED ? list : list.slice(0, 12);
  var cards = shown.map(function (x) {
    var e = x.e;
    var pills = [];
    if (e.aired && (!e.episodes || e.aired < e.episodes)) {
      var behind = e.aired - e.progress;
      pills.push(behind > 0 ? '<span class="pill y">' + t.behind(behind) + '</span>' : '<span class="pill b">' + t.caughtUp(e.aired + 1) + '</span>');
    } else if (e.airing === "FINISHED" && e.episodes > e.progress) {
      pills.push('<span class="pill g">' + t.allOut(e.episodes - e.progress) + '</span>');
    }
    if (e.status === "PAUSED") pills.push('<span class="pill y">' + t.paused + '</span>');
    return '<div class="card" data-open="' + e.mediaId + '">' +
      (e.cover ? '<img src="' + esc(e.cover) + '" loading="lazy">' : '<img>') +
      '<div><div class="t">' + esc(e.title) + '</div>' +
      '<div class="s">' + e.progress + ' / ' + (e.episodes || "?") + (x.last ? ' · ' + ago(x.last) : '') + '</div>' +
      (pills.length ? '<div>' + pills.join("") + '</div>' : '') + '</div></div>';
  }).join("");
  var more = list.length > 12
    ? '<div style="margin-top:10px"><button data-act="toggle-unfinished">' + (SHOW_ALL_UNFINISHED ? t.showLess : t.showAll(list.length)) + '</button></div>'
    : '';
  return '<section>' + head + '<div class="cards">' + cards + '</div>' + more + '</section>';
}

// ---------- calendar: month ----------
function renderMonth() {
  var t = T();
  var entries = entryMap();
  var byDay = activitiesByDay();
  var notes = DATA.notes || {};
  var y = VIEW.getFullYear(), mo = VIEW.getMonth();
  var first = new Date(y, mo, 1);
  var start = new Date(y, mo, 1 - (first.getDay() + 6) % 7); // Monday first
  var todayKey = dayKey(new Date());
  var monthEpisodes = 0, cells = "";

  for (var i = 0; i < 42; i++) {
    var d = new Date(start); d.setDate(start.getDate() + i);
    if (i >= 35 && d.getMonth() !== mo) break;
    var k = dayKey(d);
    var order = showsOfDay(byDay[k] || []);
    if (d.getMonth() === mo) order.forEach(function (s) { monthEpisodes += s.eps; });
    var evs = order.slice(0, 4).map(function (s) {
      var cover = coverOf(s.id, entries);
      return '<div class="ev ' + colorOf(s.id, entries) + '" data-open="' + s.id + '" title="' + esc(titleOf(s.id, entries)) + '">' +
        (cover ? '<img src="' + esc(cover) + '" loading="lazy">' : '') +
        '<span class="et">' + esc(titleOf(s.id, entries)) + '</span><span class="ep">' + esc(episodeLabel(s)) + '</span></div>';
    }).join("");
    var more = order.length > 4 ? '<div class="more">' + t.more(order.length - 4) + '</div>' : '';
    cells += '<div class="day' + (d.getMonth() !== mo ? ' out' : '') + (k === todayKey ? ' today' : '') + (k === SELECTED_DAY ? ' sel' : '') +
      '" data-act="day" data-day="' + k + '"><div class="n"><b>' + d.getDate() + '</b>' +
      (notes[k] ? '<span class="note-flag" title="' + esc(notes[k]) + '">📝</span>' : '') + '</div>' + evs + more + '</div>';
  }

  var dows = "";
  for (var w = 0; w < 7; w++) dows += '<div class="dow">' + weekdayShort(w) + '</div>';
  return {
    nav: '<button data-act="prev">‹</button><h2 style="margin:0;min-width:170px;text-align:center">' + monthName(mo) + ' ' + y + '</h2><button data-act="next">›</button>' +
      '<button data-act="today">' + t.todayBtn + '</button><span class="muted" style="margin-left:6px">' + t.monthEpisodes(monthEpisodes) + '</span>',
    body: '<div class="cal">' + dows + cells + '</div>',
  };
}

// ---------- calendar: year heatmap ----------
function heatLevel(n) { return n <= 0 ? 0 : n <= 2 ? 1 : n <= 5 ? 2 : n <= 9 ? 3 : 4; }
function renderHeatmap(year) {
  var t = T();
  var eps = episodesByDay();
  var notes = DATA.notes || {};
  var jan1 = new Date(year, 0, 1);
  var start = new Date(year, 0, 1 - (jan1.getDay() + 6) % 7);
  var end = new Date(year, 11, 31);
  var todayKey = dayKey(new Date());
  var cells = "", months = "", total = 0, lastMonth = -1, cols = 0;

  // Whole weeks, Monday to Sunday, from the week of Jan 1 to the week of Dec 31.
  for (var d = new Date(start); d <= end || (d.getDay() + 6) % 7 !== 0; d.setDate(d.getDate() + 1)) {
    var dow = (d.getDay() + 6) % 7;
    if (dow === 0) {
      // Month label over the first week that has the month's 1st... or later days of it.
      var sunday = new Date(d); sunday.setDate(sunday.getDate() + 6);
      var m = sunday.getFullYear() === year ? sunday.getMonth() : -1;
      var label = "";
      if (m >= 0 && m !== lastMonth) { label = monthShort(m); lastMonth = m; }
      months += '<span>' + label + '</span>';
      cols++;
    }
    if (d.getFullYear() !== year) { cells += '<div class="hc none"></div>'; continue; }
    var k = dayKey(d), n = eps[k] || 0;
    total += n;
    cells += '<div class="hc l' + heatLevel(n) + (k === todayKey ? ' today' : '') + (k === SELECTED_DAY ? ' sel' : '') + (notes[k] ? ' note' : '') +
      '" data-act="day" data-day="' + k + '" title="' + esc(t.heatTip(dateShort(d), n)) + '"></div>';
  }
  var days = "";
  for (var w = 0; w < 7; w++) days += '<span>' + (w % 2 === 0 ? weekdayShort(w) : '') + '</span>';
  var legend = '<div class="heat-legend">' + t.less + ' ' + [0, 1, 2, 3, 4].map(function (l) { return '<div class="hc l' + l + '"></div>'; }).join("") + ' ' + t.moreHeat + '</div>';
  return {
    total: total,
    html: '<div class="heat" data-cols="' + cols + '"><div class="heat-months">' + months + '</div><div class="heat-body"><div class="heat-days">' + days + '</div>' +
      '<div class="heat-grid">' + cells + '</div></div>' + legend + '</div>',
  };
}
// Square cells as large as the width allows (within 10–24 px).
function fitHeatmaps() {
  var list = document.querySelectorAll(".heat");
  for (var i = 0; i < list.length; i++) {
    var el = list[i], cols = Number(el.getAttribute("data-cols")) || 53;
    var cell = Math.floor((el.clientWidth - 30 + 3) / cols - 3);
    el.style.setProperty("--cell", Math.max(10, Math.min(24, cell)) + "px");
  }
}
window.addEventListener("resize", fitHeatmaps);
function renderYear() {
  var t = T();
  var h = renderHeatmap(HEAT_YEAR);
  return {
    nav: '<button data-act="heat-prev">‹</button><h2 style="margin:0;min-width:80px;text-align:center">' + HEAT_YEAR + '</h2><button data-act="heat-next">›</button>' +
      '<span class="muted" style="margin-left:6px">' + t.yearEpisodes(h.total) + '</span>',
    body: h.html,
  };
}

function renderCalendar() {
  var t = T();
  var part = PREFS.view === "year" ? renderYear() : renderMonth();
  var viewSeg = '<span class="seg">' +
    '<button data-act="view" data-v="month" class="' + (PREFS.view !== "year" ? "on" : "") + '">' + t.month + '</button>' +
    '<button data-act="view" data-v="year" class="' + (PREFS.view === "year" ? "on" : "") + '">' + t.year + '</button></span>';
  return '<section><div class="row" style="margin-bottom:12px">' + part.nav + '<span class="spacer"></span>' +
    (PREFS.view === "year" ? '' : '<span class="legend"><i style="background:var(--yellow)"></i>' + t.watching +
      '<i style="background:var(--green)"></i>' + t.finished + '<i style="background:var(--gray)"></i>' + t.droppedLegend + '</span>') +
    viewSeg + '</div>' + part.body + '</section>';
}

// ---------- day details ----------
function renderDay() {
  if (!SELECTED_DAY) return "";
  var t = T();
  var entries = entryMap();
  var acts = (activitiesByDay()[SELECTED_DAY] || []).slice().sort(function (a, b) { return a.at - b.at; });
  var items = acts.map(function (a) {
    var label = "";
    if (a.kind === "watched" || a.kind === "rewatched") label = t.ep + (a.to && a.to !== a.from ? a.from + "–" + a.to : (a.from || ""));
    else if (a.kind === "completed") label = t.completed;
    else if (a.kind === "planning") label = t.addedToPlanning;
    else if (a.kind === "dropped") label = t.dropped;
    else if (a.kind === "paused") label = t.pausedKind;
    var c = coverOf(a.mediaId, entries);
    return '<div class="item"><span class="time">' + timeOf(new Date(a.at * 1000)) + '</span>' +
      '<span class="dot ' + colorOf(a.mediaId, entries) + '"></span>' +
      (c ? '<img src="' + esc(c) + '" loading="lazy">' : '') +
      '<div><div class="ttl" data-open="' + a.mediaId + '">' + esc(titleOf(a.mediaId, entries)) + '</div>' +
      '<div class="muted" style="font-size:12px">' + esc(label) + '</div></div></div>';
  }).join("");
  var note = DRAFTS[SELECTED_DAY] != null ? DRAFTS[SELECTED_DAY] : ((DATA.notes || {})[SELECTED_DAY] || "");
  return '<section id="day-panel" class="dayp"><div class="row" style="margin-bottom:8px"><h2 style="margin:0">' + esc(dateLong(parseDay(SELECTED_DAY))) + '</h2>' +
    '<span class="spacer"></span><button data-act="close-day">' + t.close + '</button></div>' +
    (items || '<div class="muted" style="padding:6px 0">' + t.nothingThisDay + '</div>') +
    '<h2 style="margin-top:16px">' + t.note + '</h2>' +
    '<textarea id="note" maxlength="2000" placeholder="' + esc(t.notePlaceholder) + '">' + esc(note) + '</textarea>' +
    '<div class="row" style="margin-top:8px"><button class="primary" data-act="save-note">' + t.save + '</button>' +
    (SAVED_DAY === SELECTED_DAY ? '<span class="muted">' + t.saved + '</span>' : '') + '</div></section>';
}
function selectDay(k) {
  SELECTED_DAY = SELECTED_DAY === k ? null : k;
  SAVED_DAY = null;
  render();
  var p = document.getElementById("day-panel");
  if (p && p.scrollIntoView) p.scrollIntoView({ behavior: "smooth", block: "nearest" });
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
  var perDay = {}, perShow = {}, genres = {}, studios = {}, completed = {}, planned = 0, dropped = 0, firstShow = null;

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
    var pd = perDay[k] = perDay[k] || { eps: 0, date: d };
    pd.eps += eps;
    perShow[a.mediaId] = (perShow[a.mediaId] || 0) + eps;
    if (a.kind === "completed") completed[a.mediaId] = a.at;
    if (m) {
      (m.genres || []).forEach(function (g) { genres[g] = (genres[g] || 0) + eps; });
      (m.studios || []).forEach(function (s) { studios[s] = (studios[s] || 0) + eps; });
    }
  });

  // Longest run of consecutive days with something watched.
  var days = Object.keys(perDay).map(function (k) { return startOfDay(perDay[k].date).getTime(); }).sort(function (a, b) { return a - b; });
  var streak = 0, best = 0, prev = 0;
  days.forEach(function (x) {
    streak = prev && Math.round((x - prev) / 86400000) === 1 ? streak + 1 : 1;
    if (streak > best) best = streak;
    prev = x;
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
    completed: Object.keys(completed).length, planned: planned, dropped: dropped, activeDays: days.length, streak: best,
    bestDay: bestDay, perMonth: perMonth, perDow: perDow, topShows: top(perShow, 5), topGenres: top(genres, 8),
    topStudios: top(studios, 6), firstShow: firstShow, lastCompleted: lastCompleted,
  };
}
function renderReview() {
  var t = T();
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
  var monthLabels = [], dowLabels = [];
  for (var i = 0; i < 12; i++) monthLabels.push(monthShort(i));
  for (var w = 0; w < 7; w++) dowLabels.push(weekdayShort(w));
  var bestDow = r.perDow.indexOf(Math.max.apply(null, r.perDow));

  var body = r.episodes === 0
    ? '<div class="empty">' + t.noEpisodes(r.year) + '</div>'
    : '<div class="big">' +
        stat(r.episodes, t.statEpisodes(r.episodes)) + stat(r.hours, t.statHours(r.hours)) + stat(r.shows, t.statShows(r.shows)) +
        stat(r.completed, t.statCompleted) + stat(r.activeDays, t.statDays(r.activeDays)) + stat(r.streak, t.statStreak(r.streak)) +
      '</div>' +
      '<div class="stat" style="margin-bottom:12px"><h2>' + t.yearByDay + '</h2>' + renderHeatmap(r.year).html + '</div>' +
      '<div class="grid2">' +
        '<div class="stat"><h2>' + t.byMonth + '</h2>' + bars(r.perMonth, monthLabels) + '</div>' +
        '<div class="stat"><h2>' + t.byWeekday + '</h2>' + bars(r.perDow, dowLabels) +
          '<div class="muted" style="margin-top:8px">' + t.animeDay(weekdayLong(bestDow)) + '</div></div>' +
        '<div class="stat"><h2>' + t.mostEpisodes + '</h2><div class="top">' + r.topShows.map(function (x, i) {
          var id = Number(x[0]), c = coverOf(id, e);
          return '<div class="topi" data-open="' + id + '"><span class="rank">' + (i + 1) + '</span>' + (c ? '<img src="' + esc(c) + '">' : '') +
            '<div><div>' + esc(titleOf(id, e)) + '</div><div class="muted" style="font-size:12px">' + t.epCount(x[1]) + '</div></div></div>';
        }).join("") + '</div></div>' +
        '<div class="stat"><h2>' + t.genres + '</h2><div class="chips">' + r.topGenres.map(function (g) {
          return '<span class="chip">' + esc(g[0]) + '<small>' + g[1] + '</small></span>'; }).join("") + '</div>' +
          '<h2 style="margin-top:16px">' + t.studios + '</h2><div class="chips">' + r.topStudios.map(function (s) {
          return '<span class="chip">' + esc(s[0]) + '<small>' + s[1] + '</small></span>'; }).join("") + '</div></div>' +
        '<div class="stat moments"><h2>' + t.highlights + '</h2>' +
          (r.bestDay ? '<p>' + t.bestDay(r.bestDay.eps, dateShort(r.bestDay.date)) + '</p>' : '') +
          (r.firstShow ? '<p>' + t.started(esc(titleOf(r.firstShow.id, e))) + '</p>' : '') +
          (r.lastCompleted ? '<p>' + t.lastCompleted(esc(titleOf(r.lastCompleted.id, e))) + '</p>' : '') +
          '<p>' + t.planned(r.planned, r.dropped) + '</p>' +
        '</div>' +
      '</div>';
  var yearSelect = years.length > 1
    ? '<select data-act="year">' + years.map(function (y) { return '<option' + (y === r.year ? ' selected' : '') + '>' + y + '</option>'; }).join("") + '</select>'
    : '';
  return '<div class="review"><div class="row"><button data-act="close">' + t.back + '</button><h1 style="margin-left:6px">' + t.reviewTitle(r.year) + '</h1>' +
    '<span class="spacer"></span>' + yearSelect + '</div>' +
    '<div class="muted" style="margin-top:6px">' + t.fromAniList + (r.year === new Date().getFullYear() ? t.ongoingYear : '') + '</div>' + body + '</div>';
}

// ---------- shell ----------
function langSwitch() {
  return '<span class="seg"><button data-act="lang" data-v="en" class="' + (PREFS.lang === "en" ? "on" : "") + '">EN</button>' +
    '<button data-act="lang" data-v="ru" class="' + (PREFS.lang === "ru" ? "on" : "") + '">RU</button></span>';
}
function render() {
  var t = T();
  var root = document.getElementById("root");
  document.documentElement.lang = PREFS.lang;
  if (!DATA) { root.innerHTML = '<div class="empty">' + t.loading + '</div>'; return; }
  var errorText = DATA.error === "no-token" ? t.errNoToken : DATA.error ? t.errLoad + (DATA.errorDetail || "") : "";
  if (DATA.error && !DATA.activities) { root.innerHTML = '<div class="empty error">' + esc(errorText) + '</div>'; return; }

  var last = applyTheme();
  if (REVIEW_YEAR !== null && DATA.activities) { root.innerHTML = renderReview(); fitHeatmaps(); return; }

  var status = DATA.loading ? t.updating : DATA.error ? '<span class="error">' + esc(errorText) + '</span>' :
    DATA.partial ? t.partial : (DATA.activities ? t.entries(DATA.activities.length) : "");
  var years = DATA.activities ? yearsInData() : [];
  var reviewYear = years.length ? years[0] : new Date().getFullYear();
  root.innerHTML =
    '<div class="row head"><div><h1>Anime Diary</h1>' +
      (last ? '<div class="last">' + t.lastWatched + esc(last.title) + '</div>' : '') +
      '</div><span class="spacer"></span>' +
      '<span class="status muted">' + status + '</span>' + langSwitch() +
      '<button data-act="refresh" title="' + esc(t.refreshTip) + '">' + t.refresh + '</button>' +
      '<button class="primary" data-act="review" data-year="' + reviewYear + '">' + t.reviewBtn(reviewYear) + '</button>' +
    '</div>' +
    (DATA.activities ? renderUnfinished() + renderCalendar() + renderDay() : '');
  fitHeatmaps();
}

document.addEventListener("click", function (ev) {
  var el = ev.target.closest ? ev.target.closest("[data-open],[data-act]") : null;
  if (!el) return;
  var id = el.getAttribute("data-open");
  if (id) { send("open", { id: Number(id) }); return; }
  var act = el.getAttribute("data-act"), v = el.getAttribute("data-v");
  if (act === "prev") { VIEW.setMonth(VIEW.getMonth() - 1); render(); }
  else if (act === "next") { VIEW.setMonth(VIEW.getMonth() + 1); render(); }
  else if (act === "today") { VIEW = new Date(); VIEW.setDate(1); render(); }
  else if (act === "heat-prev") { HEAT_YEAR--; render(); }
  else if (act === "heat-next") { HEAT_YEAR++; render(); }
  else if (act === "day") { selectDay(el.getAttribute("data-day")); }
  else if (act === "close-day") { SELECTED_DAY = null; render(); }
  else if (act === "save-note") {
    var ta = document.getElementById("note");
    send("save-note", { day: SELECTED_DAY, text: ta ? ta.value : "" });
    delete DRAFTS[SELECTED_DAY];
    SAVED_DAY = SELECTED_DAY;
  }
  else if (act === "refresh") { send("refresh"); }
  else if (act === "review") { REVIEW_YEAR = Number(el.getAttribute("data-year")); render(); }
  else if (act === "close") { REVIEW_YEAR = null; render(); }
  else if (act === "toggle-unfinished") { SHOW_ALL_UNFINISHED = !SHOW_ALL_UNFINISHED; render(); }
  else if (act === "lang") { setPref({ lang: v }); }
  else if (act === "sort") { setPref({ sort: v }); }
  else if (act === "view") { setPref({ view: v }); }
});
document.addEventListener("change", function (ev) {
  if (ev.target && ev.target.getAttribute && ev.target.getAttribute("data-act") === "year") {
    REVIEW_YEAR = Number(ev.target.value); render();
  }
});
// Keep what's typed if the page re-renders before it's saved.
document.addEventListener("input", function (ev) {
  if (ev.target && ev.target.id === "note" && SELECTED_DAY) { DRAFTS[SELECTED_DAY] = ev.target.value; SAVED_DAY = null; }
});

window.webview.on("data", function (d) {
  DATA = d;
  if (d && d.prefs) PREFS = d.prefs;
  render();
});
render();
</script>
</body>
</html>`

  // Loads the history (only new activities unless `full`) and the library,
  // and returns what the page renders. Errors come back as { error } codes
  // that the page shows in its language.
  function loadPayload(full: boolean, previous: any): any {
    const prefs = readPrefs()
    const notes = readNotes()
    try {
      const token = $database.anilist.getToken()
      if (!token) return { error: "no-token", prefs, notes }

      let cache = full ? null : readCache()
      const userId = cache ? cache.userId : viewerId(token)
      if (!cache || cache.userId !== userId) cache = { userId, activities: [], media: {} }

      const partial = fetchNewActivities(token, cache)
      $storage.set(CACHE_KEY, cache)

      return {
        activities: cache.activities,
        media: cache.media,
        entries: readEntries(),
        prefs,
        notes,
        partial,
        updatedAt: Date.now(),
      }
    } catch (e) {
      console.error("Anime Diary: " + e)
      return Object.assign({}, previous || {}, { loading: false, error: "load-failed", errorDetail: String(e), prefs, notes })
    }
  }

  return { ICON, PAGE_HTML, loadPayload, savePrefs, saveNote }
}
