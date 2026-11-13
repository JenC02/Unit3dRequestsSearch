// Run directly with node tests/test_userscript.js, or through unittest.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'Unit3dRequestsSearch.user.js'), 'utf8');
const marker = '  if (requestsPage) requestPage();';
assert.ok(source.includes(marker));
const script = source.slice(0, source.indexOf(marker)) + `
  globalThis.api = {validIndex, trackerUrl, loadIndex, normalizeMetadata, buildUrl,
    quiAutofill, launchSearch, getTrackers: () => trackers};
})();`;

function harness(settings = {}) {
  const nodes = [];
  const document = {
    createElement() {
      const node = {style: {}, children: [], value: '', append(...items) { this.children.push(...items); },
        replaceChildren(...items) { this.children = items; }, setAttribute() {}, remove() {},
        get options() { return this.children.flatMap(group => group.children); }};
      nodes.push(node);
      return node;
    },
    getElementById: id => nodes.find(node => node.id === id) || null,
    querySelector: () => null,
    querySelectorAll: () => []
  };
  document.body = document.createElement();
  const select = document.createElement();
  select.id = 'tm-request-search-engine';
  const storage = new Map(Object.entries(settings));
  const requests = [];
  const context = {
    location: {protocol: 'https:', pathname: '/requests', hostname: 'example.org',
      origin: 'https://example.org', hash: ''},
    document, localStorage: {getItem: () => null},
    GM_getValue: (key, fallback) => storage.has(key) ? storage.get(key) : fallback,
    GM_setValue: (key, value) => storage.set(key, value),
    GM_registerMenuCommand: () => {}, GM_xmlhttpRequest: request => requests.push(request),
    URL, URLSearchParams, Intl, console,
    setTimeout: fn => setTimeout(fn, 1), clearTimeout,
    setInterval: fn => setInterval(fn, 1), clearInterval
  };
  vm.createContext(context);
  vm.runInContext(script, context);
  return {api: context.api, context, document, storage, requests, select};
}

const tracker = overrides => ({id: 'tracker:example', name: 'Example', homepage: 'https://example.org/',
  mappings: [], search: {path: 'search', query_param: 'q'}, ...overrides});
const index = (...trackers) => ({schema_version: 1, trackers});
const cacheKey = 'tracker_index_cache_v1';
const indexUrl = {'tracker_index_url': 'https://index.example/trackers.json'};

test('index validation accepts all checked-in trackers and rejects malformed nested fields', () => {
  const {api} = harness();
  assert.equal(api.validIndex(JSON.parse(fs.readFileSync(path.join(root, 'data/tracker-index.json')))), true);
  assert.equal(api.validIndex(index(tracker({search: null}))), true);
  for (const bad of [null, tracker({name: undefined}), tracker({name: 123}), tracker({hosts: 'example.org'}),
    tracker({codebase: {}}), tracker({mappings: [null]}), tracker({mappings: [{id: 1}]}),
    tracker({search: []}), tracker({search: {path: 123}}), tracker({search: {params: []}}),
    tracker({search: {category: {mode: 'indexed', source: 'native'}}}),
    tracker({search: {category: {mode: 'single', source: 'explicit', param: 'cat', map: {TV: '2'}}}})]) {
    assert.equal(api.validIndex(index(tracker(), bad)), false, JSON.stringify(bad));
  }
});

test('index and URL builder reject executable schemes, including normalized variants', () => {
  const {api} = harness();
  for (const value of ['javascript:void(0)', 'JaVaScRiPt:void(0)', 'java\nscript:void(0)',
    'data:text/html,test', 'file:///tmp/test']) {
    const route = tracker({search: {path: value}});
    assert.equal(api.validIndex(index(route)), false, value);
    assert.throws(() => api.trackerUrl(route, 'Title', []), /HTTP\(S\)/);
    const homepage = tracker({homepage: value, search: null});
    assert.equal(api.validIndex(index(homepage)), false, value);
    assert.throws(() => api.trackerUrl(homepage, 'Title', []), /HTTP\(S\)/);
  }
  const dynamic = tracker({search: {path: '{query}:void(0)'}});
  assert.throws(() => api.trackerUrl(dynamic, 'javascript', []), /HTTP\(S\)/);
  for (const route of ['search/{query}', '/search/{query}', 'https://search.example/{query}',
    '//search.example/{query}', 'http://search.example/{query}']) {
    const entry = tracker({search: {path: route}});
    assert.equal(api.validIndex(index(entry)), true);
    assert.match(api.trackerUrl(entry, 'A&B', []), /^https?:\/\//);
  }
});

test('launchSearch rejects unsafe persisted local URLs and closes the blank tab', async () => {
  const {api, context, document} = harness({local_search_base: 'javascript:void(0)'});
  const navigations = [];
  let closed = false;
  context.window = {open: () => ({location: {replace: url => navigations.push(url)},
    close: () => { closed = true; }})};
  const row = {querySelector: selector => selector === 'td:first-child > a[href]' ? {textContent: 'Example'} : null};
  await api.launchSearch({closest: () => row});
  assert.deepEqual(navigations, []);
  assert.equal(closed, true);
  assert.ok(document.getElementById('tm-requests-toasts'));
});

test('normal and forced loads recover from a malformed cached index', async () => {
  const malformed = index(tracker(), tracker({id: 'tracker:bad', name: undefined}));
  const replacement = index(tracker({id: 'tracker:replacement', name: 'Replacement'}));
  for (const force of [false, true]) {
    const {api, storage, requests, select} = harness({...indexUrl, [cacheKey]: malformed});
    const loading = api.loadIndex(force);
    assert.equal(requests.length, 1);
    requests[0].onload({status: 200, responseText: JSON.stringify(replacement)});
    await loading;
    assert.equal(storage.get(cacheKey).trackers[0].name, 'Replacement');
    assert.ok(select.options.some(option => option.value === 'tracker:replacement'));
  }
});

test('invalid refresh leaves the last working index usable and permits another refresh', async () => {
  const working = index(tracker());
  const {api, storage, requests, select} = harness({...indexUrl, [cacheKey]: working});
  await api.loadIndex();
  const badRefresh = api.loadIndex(true);
  requests[0].onload({status: 200, responseText: JSON.stringify(index(tracker({name: 1})))});
  await badRefresh;
  assert.equal(storage.get(cacheKey), working);
  assert.equal(api.getTrackers(), working.trackers);
  assert.ok(select.options.some(option => option.value === 'tracker:example'));
  const nextRefresh = api.loadIndex(true);
  assert.equal(requests.length, 2);
  requests[1].onload({status: 200, responseText: JSON.stringify(index(tracker({name: 'Updated'})))});
  await nextRefresh;
  assert.equal(storage.get(cacheKey).trackers[0].name, 'Updated');
});

test('normalization handles either year/season order without duplicating metadata', () => {
  const {api} = harness();
  for (const [input, expected] of [
    ['Example (2020) S01', 'Example (2020) S01'],
    ['Example S01 (2020)', 'Example (2020) S01'],
    ['Example (2020) S01E02', 'Example (2020) S01E02'],
    ['Example Season 1 (2020)', 'Example (2020) S01'],
    ['Example Season 1 Episode 2', 'Example S01E02'],
    ['Example S01 Episode 2', 'Example S01E02'],
    ['Example (2020) - Staffel 2 Folge 3', 'Example (2020) S02E03'],
    ['S1m0ne (2002)', 'S1m0ne (2002)'],
    ['Example S1234', 'Example S1234'],
    ['Offseason 1', 'Offseason 1'],
    ['Plain title', 'Plain title']
  ]) assert.equal(api.normalizeMetadata({originalTitle: input}).searchTitle, expected, input);
  const explicit = api.normalizeMetadata({originalTitle: 'Example S02E03', season: 0, episode: 1});
  assert.equal(explicit.searchTitle, 'Example S00E01');
});

test('enrichment retains the existing title-only query for trackers with advanced parameters', () => {
  const {api} = harness();
  const trackers = JSON.parse(fs.readFileSync(path.join(root, 'data/tracker-index.json'))).trackers;
  const trezzor = trackers.find(t => t.id === 'tracker:trezzor');
  const url = new URL(api.buildUrl('Example S02E03', ['TV'], trezzor, {originalTitle: 'Example S02E03'}));
  assert.equal(url.searchParams.get('search'), 'Example');
});

function quiHarness({collapsed = false, available = true, fields = ['imdbId', 'tvdbId', 'year',
  'season', 'episode', 'artist', 'album']} = {}) {
  const h = harness();
  class Input {
    constructor(value = '') { this._value = value; this.events = []; }
    set value(value) { this._value = value; }
    get value() { return this._value; }
    dispatchEvent(event) { this.events.push(event.type); }
  }
  const controls = Object.fromEntries(fields.map(id => ['advanced-' + id, new Input()]));
  const query = new Input();
  let expanded = available && !collapsed;
  let toggles = 0;
  const submissions = [];
  const trigger = {textContent: 'Advanced', click() { expanded = !expanded; toggles++; }};
  const submit = {disabled: false, click() {
    submissions.push({query: query.value, ...Object.fromEntries(Object.entries(controls).map(([key, input]) => [key, input.value]))});
  }};
  const getElementById = h.document.getElementById;
  h.document.getElementById = id => (expanded && controls[id]) || getElementById(id);
  h.document.querySelector = selector => selector === 'input#query' ? query : null;
  h.document.querySelectorAll = selector => selector === 'form button' ? (available ? [trigger] : []) :
    selector === 'form button[type="submit"]' ? [submit] : [];
  Object.assign(h.context, {HTMLInputElement: Input, HTMLTextAreaElement: class {}, Event: class {
    constructor(type) { this.type = type; }
  }});
  return {...h, controls, submissions, toggles: () => toggles, collapse: () => { expanded = false; }};
}

test('qui replaces advanced filters on consecutive searches, including a collapsed panel', async () => {
  for (const collapsed of [false, true]) {
    const h = quiHarness({collapsed});
    h.context.location.hash = '#q=First&imdbId=tt0120800&season=2&episode=3';
    await h.api.quiAutofill();
    assert.equal(h.submissions[0]['advanced-imdbId'], 'tt0120800');
    h.collapse();
    h.context.location.hash = '#q=Second';
    await h.api.quiAutofill();
    assert.equal(h.submissions[1].query, 'Second');
    for (const [id, control] of Object.entries(h.controls)) {
      assert.equal(h.submissions[1][id], '', id);
      assert.deepEqual(control.events, ['input', 'change', 'input', 'change']);
    }
    assert.equal(h.toggles(), collapsed ? 2 : 1);
  }
});

test('qui clears omitted fields when the new search includes only some metadata', async () => {
  const h = quiHarness();
  h.context.location.hash = '#q=First&imdbId=tt0120800&year=1998';
  await h.api.quiAutofill();
  h.context.location.hash = '#q=Second&year=2020';
  await h.api.quiAutofill();
  assert.equal(h.submissions[1]['advanced-year'], '2020');
  assert.equal(h.submissions[1]['advanced-imdbId'], '');
  assert.equal(h.toggles(), 0);
});

test('qui supports a plain form or advanced controls without an IMDb field', async () => {
  const plain = quiHarness({available: false, fields: []});
  plain.context.location.hash = '#q=Plain';
  await plain.api.quiAutofill();
  assert.equal(plain.submissions[0].query, 'Plain');
  const music = quiHarness({collapsed: true, fields: ['artist', 'album']});
  music.context.location.hash = '#q=Music&artist=Example';
  await music.api.quiAutofill();
  assert.equal(music.submissions[0]['advanced-artist'], 'Example');
});
