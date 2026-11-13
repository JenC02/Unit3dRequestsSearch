// ==UserScript==
// @name         Unit3dRequestsSearch
// @namespace    unit3d-requests-search
// @version      0.2.2
// @description  Search UNIT3D requests with Prowlarr, qui, web engines and tracker websites
// @author       <OWNER>
// @homepageURL  <REPO_URL>
// @supportURL   <REPO_URL>/issues
// @downloadURL  <RAW_SCRIPT>
// @updateURL    <RAW_SCRIPT>
// @match        https://*/requests*
// @match        *://*/search*
// @match        *://*/qui/search*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      raw.githubusercontent.com
// @connect      github.com
// ==/UserScript==

(() => {
  'use strict';

  const PROWLARR_DEFAULT = 'https://prowlarr.home.arpa/search';
  const QUI_DEFAULT = 'https://qui.home.arpa/qui/search';
  const INDEX_URL_DEFAULT = '<RAW_BASE>/data/tracker-index.json';
  const QUI_KEY = 'qui_search_url';
  const LANG_KEY = 'tm_request_languages';
  const HIDE_PUBLIC_KEY = 'tm_request_hide_public';
  const HIDE_UNSUPPORTED_KEY = 'tm_request_hide_unsupported';
  const ENRICH_KEY = 'tm_request_enrich';
  const UNFILLED_KEY = 'tm_request_unfilled_only';
  const INDEX_URL_KEY = 'tracker_index_url';
  const INDEX_CACHE_KEY = 'tracker_index_cache_v1';
  const PROWLARR_KEY = 'local_search_base'; // preserve prior setting
  const ENGINE_KEY = 'tm_requests_search_engine';
  const FAMILIES = ['Movies', 'TV', 'Audio', 'Books', 'PC', 'Console', 'XXX', 'Other'];
  const ENGINES = [
    { id: 'Prowlarr', name: 'Prowlarr', type: 'local' },
    { id: 'qui', name: 'qui', type: 'local' },
    { id: 'TMDB', name: 'TMDB', url: 'https://www.themoviedb.org/search/%category%?query=%s' },
    { id: 'TVDB', name: 'TVDB', url: 'https://www.thetvdb.com/search?query=%s' },
    { id: 'IMDb', name: 'IMDb', url: 'https://www.imdb.com/find/?q=%s' },
    { id: 'DuckDuckGo', name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=%s' },
    { id: 'Google', name: 'Google', url: 'https://www.google.com/search?q=%s' },
    { id: 'Bing', name: 'Bing', url: 'https://www.bing.com/search?q=%s' }
  ];

  const getProwlarrUrl = () => String(GM_getValue(PROWLARR_KEY, PROWLARR_DEFAULT)).replace(/\/+$/, '');
  const getQuiUrl = () => String(GM_getValue(QUI_KEY, QUI_DEFAULT)).replace(/\/+$/, '');
  const requestsPage = location.protocol === 'https:' && /^\/requests\/?$/.test(location.pathname);
  const detailPage = location.protocol === 'https:' && /^\/requests\/\d+\/?$/.test(location.pathname);
  const atLocalUrl = value => {
    try {
      const url = new URL(value);
      return location.origin === url.origin && location.pathname.replace(/\/$/, '') === url.pathname.replace(/\/$/, '');
    } catch { return false; }
  };
  const prowlarrPage = atLocalUrl(getProwlarrUrl());
  const quiPage = atLocalUrl(getQuiUrl());
  if (!requestsPage && !detailPage && !prowlarrPage && !quiPage) return;

  const text = el => (el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
  const slug = s => String(s || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]/g, '');
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const host = value => String(value || '').toLowerCase().replace(/^www\./, '');
  const family = cat => {
    const parent = String(cat || '').split('/')[0];
    return FAMILIES.includes(parent) ? parent : null;
  };
  let trackers = [];
  let loading = null;
  const detailCache = new Map();
  const isEnriched = () => GM_getValue(ENRICH_KEY, true);
  const nameLanguage = value => String(value || '').split(/\s*,\s*/).map(code => {
    if (!code) return '';
    try {
      const locale = new Intl.Locale(code);
      return new Intl.DisplayNames(['en'], { type: 'language' }).of(locale.language);
    } catch { return code; }
  }).filter(Boolean).join(', ');
  const setInput = (input, value) => {
    const setter = Object.getOwnPropertyDescriptor(
      input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value'
    )?.set;
    if (setter) setter.call(input, String(value)); else input.value = String(value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const waitFor = (target, ms = 8000) => new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const node = typeof target === 'function' ? target() : document.querySelector(target);
      if (node) { clearInterval(timer); resolve(node); }
      else if (Date.now() - started >= ms) { clearInterval(timer); reject(new Error('Search control not found')); }
    }, 100);
  });

  function toast(message, kind = 'info', duration = 15000) {
    let area = document.getElementById('tm-requests-toasts');
    if (!area) {
      area = document.createElement('div');
      area.id = 'tm-requests-toasts';
      Object.assign(area.style, {
        position: 'fixed', bottom: '16px', right: '16px', zIndex: '2147483647',
        width: 'min(420px, calc(100vw - 32px))', display: 'grid', gap: '8px', pointerEvents: 'none'
      });
      document.body.append(area);
    }
    const item = document.createElement('div');
    Object.assign(item.style, {
      display: 'flex', alignItems: 'center', gap: '12px', pointerEvents: 'auto',
      background: '#222936', color: '#fff', padding: '12px 14px', borderRadius: '6px',
      borderLeft: `4px solid ${({ error: '#cf3737', success: '#238653', info: '#287bb5' })[kind]}`,
      boxShadow: '0 4px 20px #0006', font: '13px/1.45 system-ui, sans-serif'
    });
    const label = document.createElement('span');
    label.style.flex = '1';
    label.textContent = message;
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = 'x';
    close.setAttribute('aria-label', 'Dismiss notification');
    Object.assign(close.style, { background: 'none', border: '0', color: 'white', cursor: 'pointer', fontSize: '20px' });
    close.onclick = () => item.remove();
    item.append(label, close);
    area.append(item);
    if (duration > 0) setTimeout(() => item.remove(), duration);
  }

  function httpUrl(value, base) {
    const url = new URL(value, base);
    if (!/^https?:$/.test(url.protocol)) throw new Error('Search destinations must use HTTP(S)');
    return url;
  }

  function validIndex(value) {
    const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
    const scalar = v => typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v));
    const id = v => typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v));
    const optionalStrings = (v, keys) => keys.every(key => v[key] === undefined || typeof v[key] === 'string');
    const params = v => v === undefined || (object(v) && Object.values(v).every(scalar));
    try {
      return value?.schema_version === 1 && Array.isArray(value.trackers) && value.trackers.every(t => {
        if (!object(t) || typeof t.id !== 'string' || !/^tracker:.+/.test(t.id) ||
            typeof t.name !== 'string' || !t.name.trim() || typeof t.homepage !== 'string' ||
            !optionalStrings(t, ['codebase', 'language', 'privacy']) ||
            (t.hosts !== undefined && (!Array.isArray(t.hosts) || !t.hosts.every(h => typeof h === 'string'))) ||
            !Array.isArray(t.mappings) || !t.mappings.every(m => object(m) && id(m.id) &&
              typeof m.cat === 'string' && optionalStrings(m, ['desc']))) return false;
        const homepage = httpUrl(t.homepage);
        if (t.search === undefined || t.search === null) return true;
        const rule = t.search;
        if (!object(rule) || !optionalStrings(rule, ['path', 'query_param', 'query_suffix', 'query_transform']) ||
            !params(rule.params)) return false;
        httpUrl(rule.path || '', homepage.href);
        if (rule.category === undefined) return true;
        const cat = rule.category;
        return object(cat) && ['indexed', 'repeat', 'joined', 'keyed', 'single'].includes(cat.mode) &&
          typeof cat.param === 'string' && cat.param.length > 0 && optionalStrings(cat, ['separator']) &&
          (cat.value === undefined || scalar(cat.value)) && params(cat.when_selected) &&
          (cat.source === 'native' || (cat.source === 'explicit' && object(cat.map) &&
            Object.values(cat.map).every(ids => Array.isArray(ids) && ids.every(id))));
      });
    } catch { return false; }
  }

  function loadIndex(force = false) {
    if (loading) return loading;
    const cache = GM_getValue(INDEX_CACHE_KEY, null);
    if (!force && validIndex(cache)) {
      trackers = cache.trackers;
      populateSelect();
      return Promise.resolve();
    }
    const url = String(GM_getValue(INDEX_URL_KEY, INDEX_URL_DEFAULT)).trim();
    if (!url) {
      toast('Set the tracker-index.json URL in Tampermonkey to load trackers.', 'info', 20000);
      return Promise.resolve();
    }
    try {
      const parsed = new URL(url);
      if (!/^https?:$/.test(parsed.protocol)) {
        throw new Error('Use an HTTP(S) URL to a raw tracker-index.json file');
      }
    } catch (error) { toast('Invalid tracker index URL: ' + error.message, 'error'); return Promise.resolve(); }
    toast('Downloading shared tracker index…');
    loading = new Promise((resolve, reject) => GM_xmlhttpRequest({
      method: 'GET', url, timeout: 60000,
      onload: response => response.status >= 200 && response.status < 300
        ? resolve(response.responseText) : reject(new Error('HTTP ' + response.status)),
      onerror: () => reject(new Error('Download failed')),
      ontimeout: () => reject(new Error('Download timed out'))
    })).then(body => {
      const index = JSON.parse(body);
      if (!validIndex(index)) throw new Error('Invalid tracker index schema');
      trackers = index.trackers;
      populateSelect();
      GM_setValue(INDEX_CACHE_KEY, index);
      toast(`Loaded ${trackers.length} trackers from the configured URL.`, 'success', 20000);
    }).catch(error => toast('Tracker index refresh failed: ' + error.message, 'error', 25000))
      .finally(() => { loading = null; });
    return loading;
  }

  GM_registerMenuCommand('Configure tracker index URL', () => {
    const saved = GM_getValue(INDEX_URL_KEY, INDEX_URL_DEFAULT);
    const input = prompt('Raw URL to data/tracker-index.json:', saved);
    if (input === null) return;
    GM_setValue(INDEX_URL_KEY, input.trim());
    loadIndex(true);
  });
  GM_registerMenuCommand('Refresh tracker index', () => loadIndex(true));
  GM_registerMenuCommand('Configure Prowlarr search URL', () => {
    const input = prompt('Prowlarr search URL:', getProwlarrUrl());
    if (input === null) return;
    try {
      const url = new URL(input.trim());
      if (!/^https?:$/.test(url.protocol) || !url.pathname.replace(/\/$/, '').endsWith('/search')) throw new Error('Expected HTTP(S) /search URL');
      GM_setValue(PROWLARR_KEY, url.origin + url.pathname);
      toast('Prowlarr URL saved. Reload Prowlarr if its address changed.', 'success');
      updateTooltips();
    } catch (error) { toast('Invalid Prowlarr URL: ' + error.message, 'error'); }
  });

  GM_registerMenuCommand('Configure qui search URL', () => {
    const input = prompt('qui search URL:', getQuiUrl());
    if (input === null) return;
    try {
      const url = new URL(input.trim());
      if (!/^https?:$/.test(url.protocol) || !url.pathname.endsWith('/search')) {
        throw new Error('Expected an HTTP(S) URL ending in /search');
      }
      GM_setValue(QUI_KEY, url.origin + url.pathname);
      toast('qui URL saved. Reload the qui page if its address changed.', 'success');
      updateTooltips();
    } catch (error) { toast('Invalid qui URL: ' + error.message, 'error'); }
  });
  GM_registerMenuCommand('Filter tracker languages', () => {
    const entered = prompt('Language codes separated by commas (en, de, en-US). Empty = all languages:',
      GM_getValue(LANG_KEY, ''));
    if (entered === null) return;
    GM_setValue(LANG_KEY, entered.trim());
    populateSelect();
  });
  for (const [key, caption, defaultValue] of [
    [HIDE_UNSUPPORTED_KEY, 'Toggle hide unsupported trackers', false],
    [HIDE_PUBLIC_KEY, 'Toggle hide public trackers', false],
    [ENRICH_KEY, 'Toggle search enrichment', true],
    [UNFILLED_KEY, 'Toggle unfilled-only requests', true]
  ]) {
    GM_registerMenuCommand(caption, () => {
      const active = !GM_getValue(key, defaultValue);
      GM_setValue(key, active);
      if (key !== UNFILLED_KEY) populateSelect();
      toast(caption + ': ' + (active ? 'ON' : 'OFF') +
        (key === UNFILLED_KEY ? ' (applies on next page load)' : ''), 'success');
    });
  }

  function sourceFamilies(categoryLabel) {
    const source = trackers.find(t => (t.hosts || []).some(h => host(h) === host(location.hostname)));
    const lookup = slug(categoryLabel);
    const result = new Set();
    if (source) {
      for (const entry of source.mappings) {
        if (/deprecated/i.test(entry.desc || '')) continue;
        if (slug(entry.desc) === lookup || slug(entry.cat) === lookup || slug(String(entry.id)) === lookup) {
          const normalized = family(entry.cat);
          if (normalized) result.add(normalized);
        }
      }
    }
    // Fallback for common request tables and sites absent from the index.
    if (!result.size) {
      const direct = FAMILIES.find(f => slug(f) === lookup);
      if (direct) result.add(direct);
      else if (lookup === 'movie') result.add('Movies');
      else if (lookup === 'tvshow' || lookup === 'tvshows') result.add('TV');
    }
    return [...result];
  }

  function categoryIds(tracker, families) {
    const output = [];
    for (const entry of tracker.mappings || []) {
      if (families.includes(family(entry.cat)) && !/deprecated/i.test(entry.desc || '')) {
        const id = String(entry.id);
        if (!output.includes(id)) output.push(id);
      }
    }
    return output;
  }

  function selectedCategories(tracker, families) {
    const rule = tracker.search?.category;
    if (!rule) return [];
    if (rule.source === 'native') {
      const ids = categoryIds(tracker, families);
      return rule.mode !== 'single' || ids.length === 1 ? ids : [];
    }
    if (rule.source === 'explicit') {
      const map = rule.map || {};
      if (!families.every(f => Object.hasOwn(map, f))) return [];
      const ids = [...new Set(families.flatMap(f => map[f].map(String)))];
      return rule.mode !== 'single' || ids.length === 1 ? ids : [];
    }
    return [];
  }

  // Generic URL builder. A placeholder is omitted completely when metadata is absent.
  function trackerUrl(tracker, query, families, metadata = {}) {
    httpUrl(tracker.homepage);
    if (!tracker.search) return tracker.homepage;
    const rule = tracker.search;
    const meta = { ...metadata, imdbNumeric: metadata.imdbId?.replace(/^tt/i, '') };
    const template = value => {
      const source = String(value);
      const names = [...source.matchAll(/\{(year|season|episode|imdbId|imdbNumeric|tmdbId|tvdbId|tvMazeId|artist|album|label|author|title|resolution|type)\}/g)];
      if (names.some(([, key]) => meta[key] === null || meta[key] === undefined || meta[key] === '')) return null;
      return source.replace(/\{(year|season|episode|imdbId|imdbNumeric|tmdbId|tvdbId|tvMazeId|artist|album|label|author|title|resolution|type)\}/g,
        (_, key) => String(meta[key]));
    };
    let term = query + (rule.query_suffix || '');
    if ((rule.query_transform || '').startsWith('slug')) {
      term = term.replace(/[-&]/g, '').trim().replace(/\s+/g, '-');
      if (rule.query_transform === 'slug_lower') term = term.toLowerCase();
    }
    const pathTerm = encodeURIComponent(term).replace(/[!'()*]/g,
      c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
    const route = (rule.path || '').replaceAll('{query}', pathTerm)
      .replaceAll('{initial}', pathTerm.slice(0, 1));
    const url = httpUrl(route, tracker.homepage.replace(/\/?$/, '/'));
    for (const [k, v] of Object.entries(rule.params || {})) {
      const resolved = template(v);
      if (resolved !== null) url.searchParams.append(k, resolved);
    }
    if (rule.query_param) url.searchParams.append(rule.query_param, term);
    const ids = selectedCategories(tracker, families);
    const cat = rule.category || {};
    const mode = cat.mode;
    if (ids.length) {
      if (mode === 'indexed') ids.forEach((id, i) => url.searchParams.append(cat.param.replace('{index}', i), id));
      if (mode === 'repeat') ids.forEach(id => url.searchParams.append(cat.param, id));
      if (mode === 'joined') url.searchParams.append(cat.param, ids.join(cat.separator || ','));
      if (mode === 'keyed') ids.forEach(id => url.searchParams.append(cat.param.replace('{id}', id), cat.value || '1'));
      if (mode === 'single' && ids.length === 1) url.searchParams.append(cat.param, ids[0]);
      if (mode !== 'single' || ids.length === 1) {
        for (const [k, v] of Object.entries(cat.when_selected || {})) url.searchParams.append(k, String(v));
      }
    }
    return url.href.replace(/%5B/gi, '[').replace(/%5D/gi, ']');
  }

  function selectedEngine() {
    const name = document.getElementById('tm-request-search-engine')?.value ||
      localStorage.getItem(ENGINE_KEY) || 'Prowlarr';
    return [...ENGINES, ...trackers].find(e => e.id === name) || ENGINES[0];
  }

  // Parse both the live detail page and a fetched detail document.
  function parseRequestDetails(doc) {
    const rawTitle = text(doc.querySelector('.meta .meta__title'));
    const yearMatch = rawTitle.match(/\s*\((19|20)\d{2}\)\s*$/);
    const title = rawTitle.replace(/\s*\((?:19|20)\d{2}\)\s*$/, '').trim();
    const data = {
      title, year: yearMatch ? yearMatch[0].match(/\d{4}/)[0] : '',
      category: text(doc.querySelector('.request__category')),
      resolution: text(doc.querySelector('.request__resolution')),
      type: text(doc.querySelector('.request__type'))
    };
    const ids = {
      imdbId: '.meta__imdb a[href]', tmdbId: '.meta__tmdb a[href]',
      tvdbId: '.meta__tvdb a[href]', tvMazeId: '.meta__tvmaze a[href]'
    };
    for (const [field, selector] of Object.entries(ids)) {
      const url = doc.querySelector(selector)?.getAttribute('href') || '';
      const value = field === 'imdbId' ? url.match(/tt\d+/i)?.[0] : url.match(/\d+(?:\/?$|\?|#)/)?.[0]?.match(/\d+/)?.[0]
        || url.match(/\d+\/?$/)?.[0]?.replace(/\/$/, '');
      if (value) data[field] = value;
    }
    const labels = { Artist: 'artist', Album: 'album', Label: 'label', Author: 'author' };
    for (const chip of doc.querySelectorAll('.meta-chip, .meta__chip-container > article')) {
      const label = text(chip.querySelector('.meta-chip__name')).replace(/:$/, '');
      if (labels[label]) data[labels[label]] = text(chip.querySelector('.meta-chip__value'));
    }
    const context = rawTitle + ' ' + text(doc.querySelector('.request__tags'));
    const season = context.match(/\bS(?:eason)?\s*0*(\d{1,3})(?!\w)/i) || context.match(/\bStaffel\s*0*(\d{1,3})(?!\w)/i);
    const episode = context.match(/\bE(?:pisode)?\s*0*(\d{1,3})(?!\w)/i) || context.match(/\bFolge\s*0*(\d{1,3})(?!\w)/i);
    if (season) data.season = String(Number(season[1]));
    if (episode) data.episode = String(Number(episode[1]));
    return data;
  }

  function normalizeMetadata(data) {
    const original = data.originalTitle || data.title || '';
    const match = original.match(/\bS(?:eason)?\s*0*(\d{1,3})(?:\s*E(?:pisode)?\s*0*(\d{1,3}))?(?!\w)/i)
      || original.match(/\bStaffel\s*0*(\d{1,3})(?:\s*(?:Folge|Episode)\s*0*(\d{1,3}))?(?!\w)/i);
    const season = String(data.season ?? '') || (match ? String(Number(match[1])) : '');
    const episode = String(data.episode ?? '') || (match?.[2] ? String(Number(match[2])) : '');
    const yearSuffix = /\s*\((?:19|20)\d{2}\)\s*$/;
    // The year can appear before or after the season/episode suffix.
    const title = (data.title || original).replace(yearSuffix, '')
      .replace(/\s*[-:]?\s*\b(?:Staffel|Season)\s*\d+(?:\s*(?:Folge|Episode)\s*\d+)?\s*$/i, '')
      .replace(/\s+S\d{1,3}(?:\s*E(?:pisode)?\s*\d{1,3})?\s*$/i, '').replace(yearSuffix, '').trim();
    const year = data.year || original.match(/\((19|20)\d{2}\)/)?.[0]?.slice(1, -1) || '';
    const searchTitle = [title + (year ? ` (${year})` : ''),
      season ? `S${season.padStart(2, '0')}${episode ? 'E' + episode.padStart(2, '0') : ''}` : ''].filter(Boolean).join(' ');
    return { ...data, originalTitle: original, title, year, season, episode,
      families: data.families?.length ? data.families : sourceFamilies(data.category), searchTitle };
  }

  function prowlarrQuery(data) {
    const families = data.families || [];
    const primary = families[0];
    const definitions = {
      Movies: [['ImdbId', 'imdbId'], ['Year', 'year'], ['TmdbId', 'tmdbId']],
      TV: [['ImdbId', 'imdbId'], ['TmdbId', 'tmdbId'], ['Season', 'season'],
        ['TvdbId', 'tvdbId'], ['TvMazeId', 'tvMazeId'], ['Episode', 'episode']],
      Audio: [['Artist', 'artist'], ['Label', 'label'], ['Album', 'album']],
      Books: [['Author', 'author'], ['Title', 'title']]
    };
    const types = { Movies: 'movie', TV: 'tvsearch', Audio: 'music', Books: 'book' };
    const tokens = (definitions[primary] || []).filter(([, key]) => data[key] !== undefined && data[key] !== '')
      .map(([label, key]) => `{${label}:${((key === 'season' || key === 'episode') ? String(data[key]).padStart(2, '0') : String(data[key])).replace(/[{}]/g, '')}}`);
    const hasId = ['imdbId', 'tmdbId', 'tvdbId', 'tvMazeId'].some(key => data[key]);
    const prefix = (primary === 'Movies' || primary === 'TV') && !hasId ? data.title + ' ' : '';
    return { query: tokens.length ? prefix + tokens.join('') : data.searchTitle,
      searchType: tokens.length ? (types[primary] || 'search') : 'search' };
  }

  function buildUrl(query, families, engine = selectedEngine(), metadata = {}) {
    const data = normalizeMetadata({ originalTitle: query, families, ...metadata });
    const rich = isEnriched() && Object.keys(metadata).length > 0;
    const plain = rich ? data.searchTitle : query;
    if (engine.type === 'local') {
      const params = new URLSearchParams({ q: plain });
      if (families.length) params.set('cats', families.join(','));
      if (rich) {
        for (const key of ['title', 'year', 'season', 'episode', 'imdbId', 'tmdbId', 'tvdbId',
                           'tvMazeId', 'artist', 'album', 'label', 'author']) {
          if (data[key]) params.set(key, data[key]);
        }
        if (engine.id === 'Prowlarr') {
          const structured = prowlarrQuery(data);
          params.set('q', structured.query);
          params.set('stype', structured.searchType);
          params.set('fallback', plain);
        }
      }
      return (engine.id === 'qui' ? getQuiUrl() : getProwlarrUrl()) + '#' + params.toString();
    }
    if (engine.id.startsWith('tracker:')) {
      const hasAdvanced = Object.values(engine.search?.params || {}).some(value => /\{(?:year|season|episode|imdbId|imdbNumeric|tmdbId|tvdbId|tvMazeId|artist|album|label|author|title|resolution|type)\}/.test(String(value)));
      return trackerUrl(engine, rich && hasAdvanced ? data.title : plain, families, rich ? data : {});
    }
    let path = 'multi';
    if (families.length === 1 && families[0] === 'Movies') path = 'movie';
    if (families.length === 1 && families[0] === 'TV') path = 'tv';
    return engine.url.replace('%category%', path).replace('%s', encodeURIComponent(plain));
  }

  function populateSelect() {
    const select = document.getElementById('tm-request-search-engine');
    if (!select) return;
    const desired = select.value || localStorage.getItem(ENGINE_KEY) || 'Prowlarr';
    const requested = GM_getValue(LANG_KEY, '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    const visible = trackers.filter(t => {
      if (GM_getValue(HIDE_PUBLIC_KEY, false) && t.privacy === 'public') return false;
      if (GM_getValue(HIDE_UNSUPPORTED_KEY, false) && !t.search) return false;
      if (!requested.length) return true;
      const codes = String(t.language || '').toLowerCase().split(/[,\s]+/);
      return codes.some(code => requested.some(filter => code === filter || (!filter.includes('-') && code.startsWith(filter + '-'))));
    });
    const groups = [['Local', ENGINES.filter(e => e.type === 'local')],
      ['Search engines', ENGINES.filter(e => e.type !== 'local')]];
    const privateTrackers = visible.filter(t => t.privacy !== 'public');
    const known = [...new Set(privateTrackers.map(t => t.codebase || 'Custom'))]
      .filter(codebase => codebase !== 'Custom').sort((a, b) => a.localeCompare(b));
    for (const codebase of known) groups.push([codebase, privateTrackers.filter(t => t.codebase === codebase)]);
    groups.push(['Custom', privateTrackers.filter(t => (t.codebase || 'Custom') === 'Custom' && t.search)]);
    groups.push(['Public trackers', visible.filter(t => t.privacy === 'public')]);
    groups.push(['Unsupported', privateTrackers.filter(t => (t.codebase || 'Custom') === 'Custom' && !t.search)]);
    select.replaceChildren(...groups.filter(([, list]) => list.length).map(([heading, list]) => {
      const group = document.createElement('optgroup');
      group.label = heading;
      for (const item of [...list].sort((a, b) => a.name.localeCompare(b.name))) {
        const option = document.createElement('option');
        option.value = item.id;
        option.textContent = item.language ? `${item.name} (${nameLanguage(item.language)})` : item.name;
        group.append(option);
      }
      return group;
    }));
    const options = [...select.options].map(option => option.value);
    select.value = options.includes(desired) ? desired : 'Prowlarr';
    updateTooltips();
  }

  function rowData(button) {
    const row = button.closest('tr');
    const link = row?.querySelector('td:first-child > a[href]');
    return { originalTitle: text(link), title: text(link), url: link?.href,
      category: text(row?.querySelector('td:nth-child(2)')),
      resolution: text(row?.querySelector('td:nth-child(4)')),
      type: text(row?.querySelector('td:nth-child(3)')),
      families: sourceFamilies(text(row?.querySelector('td:nth-child(2)'))) };
  }

  function buttonData(button) {
    return button.closest('tr') ? rowData(button) : {
      ...parseRequestDetails(document),
      originalTitle: text(document.querySelector('.meta__title')),
    };
  }

  function updateTooltips() {
    const engine = selectedEngine();
    document.querySelectorAll('.tm-search-btn').forEach(button => {
      const data = buttonData(button);
      if (!data.originalTitle) return;
      try {
        button.title = buildUrl(data.originalTitle, data.families || sourceFamilies(data.category), engine,
          detailPage ? data : {});
        if (requestsPage && isEnriched()) button.title += '\n(Request metadata loaded when clicked)';
      } catch (error) { button.title = 'Search unavailable: ' + error.message; }
    });
  }

  function addControls() {
    if (document.getElementById('tm-request-search-engine')) return;
    let bar;
    if (requestsPage) {
      const heading = [...document.querySelectorAll('h2.panel__heading')].find(h => text(h) === 'Requests');
      if (!heading) return;
      bar = document.createElement('div');
      Object.assign(bar.style, { margin: '8px 0 12px', display: 'flex', alignItems: 'center', gap: '8px' });
      heading.after(bar);
    } else if (detailPage) {
      const menu = document.querySelector('menu.torrent__buttons.form__group--short-horizontal');
      if (!menu || !document.querySelector('.meta')) return;
      const searchMenu = document.createElement('menu');
      searchMenu.className = 'torrent__buttons form__group--short-horizontal tm-request-search-menu';
      Object.assign(searchMenu.style, {
        display: 'flex', justifyContent: 'center', alignItems: 'center',
        width: '100%', gap: '8px', marginTop: '12px'
      });
      menu.after(searchMenu);
      bar = document.createElement('li');
      bar.className = 'form__group form__group--short-horizontal';
      Object.assign(bar.style, { display: 'flex', alignItems: 'center', gap: '6px' });
      searchMenu.append(bar);
    } else return;
    const label = document.createElement('label');
    label.textContent = 'Search engine: ';
    const select = document.createElement('select');
    select.id = 'tm-request-search-engine';
    select.onchange = () => { localStorage.setItem(ENGINE_KEY, select.value); updateTooltips(); };
    label.append(select);
    bar.append(label);
    if (detailPage) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'form__button form__button--outlined form__button--centered tm-search-btn';
      button.textContent = '🔍';
      button.onclick = event => { event.preventDefault(); launchSearch(button); };
      bar.append(button);
    }
    populateSelect();
    loadIndex();
  }

  async function launchSearch(button) {
    const initial = buttonData(button);
    if (!initial.originalTitle) return;
    const engine = selectedEngine();
    const families = initial.families || sourceFamilies(initial.category);
    const target = window.open('about:blank', '_blank'); // Synchronous: preserve popup permission.
    if (!target) { toast('Browser blocked the search tab.', 'error'); return; }
    try { target.opener = null; } catch { /* Browser may forbid modifying the opener. */ }
    let data = initial;
    if (isEnriched() && requestsPage && initial.url) {
      try {
        const url = new URL(initial.url);
        if (url.origin !== location.origin || !/^\/requests\/\d+\/?$/.test(url.pathname)) {
          throw new Error('Not a request detail URL');
        }
        if (!detailCache.has(url.href)) {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 8000);
          try {
            const response = await fetch(url.href, { credentials: 'same-origin', signal: controller.signal });
            if (!response.ok) throw new Error('HTTP ' + response.status);
            const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
            if (!doc.querySelector('.meta')) throw new Error('Request metadata not found');
            detailCache.set(url.href, parseRequestDetails(doc));
          } finally { clearTimeout(timer); }
        }
        data = { ...initial, ...detailCache.get(url.href), originalTitle: initial.originalTitle };
      } catch (error) {
        toast('Metadata lookup failed; using request table values (' + error.message + ').', 'info', 10000);
      }
    }
    try {
      const link = buildUrl(initial.originalTitle, families, engine,
        isEnriched() ? data : {});
      httpUrl(link);
      target.location.replace(link);
    } catch (error) {
      target.close();
      toast('Search failed: ' + error.message, 'error');
    }
  }

  function addButtons() {
    const heading = [...document.querySelectorAll('h2.panel__heading')].find(h => text(h) === 'Requests');
    const table = heading?.closest('.panelV2')?.querySelector('.data-table');
    if (!table) return;
    table.querySelectorAll('tbody tr').forEach(row => {
      const link = row.querySelector('td:first-child > a[href]');
      if (!link || row.querySelector('td:first-child > .tm-search-btn')) return;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'tm-search-btn';
      button.textContent = '🔍';
      Object.assign(button.style, { marginLeft: '6px', cursor: 'pointer' });
      button.onclick = event => { event.preventDefault(); event.stopPropagation(); launchSearch(button); };
      link.after(button);
      button.title = buildUrl(text(link), sourceFamilies(text(row.querySelector('td:nth-child(2)'))));
    });
  }

  function requestPage() {
    const url = new URL(location.href);
    if (GM_getValue(UNFILLED_KEY, true) && url.searchParams.get('unfilled') !== 'true') {
      url.searchParams.set('unfilled', 'true');
      location.replace(url.href);
      return;
    }
    const refresh = () => { addControls(); addButtons(); };
    refresh();
    new MutationObserver(refresh).observe(document.body, { childList: true, subtree: true });
  }

  // Prowlarr uses React. Select the search mode first, then populate its controlled input.
  let autofillRunning = false;
  async function prowlarrAutofill() {
    if (autofillRunning) return;
    const params = new URLSearchParams(location.hash.replace(/^#/, ''));
    let query = params.get('q');
    const categories = (params.get('cats') || params.get('cat') || '').split(',').filter(c => FAMILIES.includes(c));
    if (!query) return;
    autofillRunning = true;
    try {
      const input = await waitFor('input[name="searchQuery"]');
      const mode = params.get('stype') || 'search';
      if (mode !== 'search') {
        try {
          const container = input.closest('[class*="inputContainer"]') || input.parentElement?.parentElement;
          const toggle = container?.querySelector('button[title]') ||
            [...document.querySelectorAll('button[title]')].find(b => /query options/i.test(b.title));
          if (!toggle) throw new Error('Query options button unavailable');
          toggle.click();
          const picker = await waitFor('select[name="searchType"]', 4000);
          if (![...picker.options].some(o => o.value === mode)) throw new Error('Search type unsupported');
          picker.value = mode;
          picker.dispatchEvent(new Event('change', { bubbles: true }));
          await delay(150);
          const footer = picker.closest('[class*="ModalContent"]')?.querySelector('[class*="ModalFooter"]');
          const close = footer?.querySelector('button:last-child');
          if (!close) throw new Error('Query options Close button unavailable');
          close.click();
          await delay(150);
        } catch (error) {
          query = params.get('fallback') || query;
          toast('Prowlarr search type unavailable; falling back to title search: ' + error.message, 'info');
        }
      }
      setInput(input, query);
      input.focus();
      await delay(200);
      if (categories.length) {
        const section = () => [...document.querySelectorAll('[class*="SearchFooter-indexerContainer"]')]
          .find(el => text(el.querySelector('[class*="SearchFooterLabel-label"]')) === 'Categories');
        const selected = () => new Set(
          [...(section()?.querySelectorAll('button [class*="Label-label"]') || [])].map(text)
        );
        const option = label => [...document.querySelectorAll('[class*="EnhancedSelectInputOption-option"]')]
          .find(el => text(el) === label || text(el).startsWith(label + ' '));
        const target = new Set(categories);
        const container = await waitFor(section);
        const dropdown = container.querySelector('button[class*="EnhancedSelectInput-enhancedSelect"]');
        if (!dropdown) throw new Error('Categories dropdown not found');
        for (const label of FAMILIES) {
          const want = target.has(label);
          if (selected().has(label) === want) continue;
          if (!option(label)) { dropdown.click(); await waitFor(() => option(label), 3500); }
          const checkbox = option(label)?.querySelector('input[type="checkbox"]');
          if (!checkbox) throw new Error('Category not available: ' + label);
          if (checkbox.checked !== want) checkbox.click();
          await waitFor(() => selected().has(label) === want, 3500);
        }
        if (FAMILIES.some(c => selected().has(c) !== target.has(c))) {
          throw new Error('Could not verify category selection');
        }
        await delay(200);
      }
      (await waitFor('[class*="SearchFooter-searchButton"]')).click();
    } catch (error) { toast('Prowlarr autofill failed: ' + error.message, 'error', 25000); }
    finally { autofillRunning = false; }
  }

  async function quiAutofill() {
    if (autofillRunning) return;
    const params = new URLSearchParams(location.hash.replace(/^#/, ''));
    const query = params.get('q');
    if (!query) return;
    autofillRunning = true;
    try {
      const field = await waitFor('input#query');
      const family = (params.get('cats') || '').split(',')[0];
      const category = { Movies: 'movies', TV: 'tv', Audio: 'music', Books: 'books',
        PC: 'apps', Console: 'apps', XXX: 'xxx' }[family];
      if (category) {
        const toggle = await waitFor('button#search-type');
        const nativeSelect = toggle.parentElement?.querySelector('select');
        if (!nativeSelect || nativeSelect.value !== category) {
          toggle.click();
          const item = await waitFor(() => [...document.querySelectorAll('[role="option"]')]
            .find(o => o.getAttribute('data-value') === category ||
              o.getAttribute('value') === category ||
              ({ movies: 'Movies', tv: 'TV', music: 'Music', books: 'Books & comics',
                apps: 'Apps & games', xxx: 'Adult' })[category] === text(o)), 4000);
          item.click();
          await waitFor(() => toggle.parentElement?.querySelector('select')?.value === category, 3500);
        }
      }
      setInput(field, query);
      const advanced = {
        imdbId: 'imdbId', tvdbId: 'tvdbId', year: 'year',
        season: 'season', episode: 'episode', artist: 'artist', album: 'album'
      };
      const hasControls = () => Object.values(advanced).some(id => document.getElementById('advanced-' + id));
      const trigger = [...document.querySelectorAll('form button')].find(b => text(b) === 'Advanced');
      if (!hasControls() && trigger) {
        trigger.click();
        await waitFor(hasControls);
      } else if (!hasControls() && Object.keys(advanced).some(key => params.get(key))) {
        await waitFor(hasControls);
      }
      // Every hash describes a new search, including when Advanced was collapsed.
      for (const [key, id] of Object.entries(advanced)) {
        const control = document.getElementById('advanced-' + id);
        if (control) setInput(control, params.get(key) || '');
      }
      await delay(250);
      const submit = await waitFor(() => [...document.querySelectorAll('form button[type="submit"]')]
        .find(b => !b.disabled));
      submit.click();
    } catch (error) { toast('qui autofill failed: ' + error.message, 'error', 25000); }
    finally { autofillRunning = false; }
  }

  if (requestsPage) requestPage();
  else if (detailPage) {
    const refresh = () => addControls();
    refresh();
    new MutationObserver(refresh).observe(document.body, { childList: true, subtree: true });
  } else {
    const fill = prowlarrPage ? prowlarrAutofill : quiAutofill;
    fill();
    window.addEventListener('hashchange', fill);
  }
})();
