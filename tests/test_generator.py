"""Offline tests: python -m unittest discover -s tests -v"""
import importlib.util
import io
import json
import subprocess
import tarfile
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('generator', ROOT / 'scripts/generate-support.py')
g = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(g)


class GeneratorTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.defaults = g.load_json(ROOT / 'data/codebase-defaults.json')
        cls.overrides = g.load_json(ROOT / 'data/tracker-overrides.json')
        archive = (ROOT / 'tests/fixtures/definitions.tar.gz').read_bytes()
        cls.index, cls.errors = g.make_index(archive, cls.defaults, cls.overrides)
        cls.trackers = {t['name'].lower(): t for t in cls.index['trackers']}

    def test_index_without_hdvinnie(self):
        self.assertEqual(self.errors, [])
        self.assertEqual(self.index['schema_version'], 1)
        self.assertEqual(list(self.index['sources']), ['prowlarr'])
        self.assertTrue(all('language' in t and 'uses_api' in t for t in self.index['trackers']))
        self.assertIsInstance(self.overrides['trackers'], list)
        self.assertNotIn('public', self.overrides)
        self.assertNotIn('extra_trackers', self.overrides)

    def test_codebase_classification_uses_general_family(self):
        for footer, expected in {
            '# xbtit': 'XBTIT', '# xbtitFM v4.2.13': 'XBTIT',
            '# NexusPHP v1.10.2 2026-04-11': 'NexusPHP',
            '# Ourbits 1.1 (Based on NexusPHP Standard v1.5)': 'NexusPHP',
            '# json Traxary v0.1.54 (based on UNIT3D 9.2.0)': 'UNIT3D',
            '# json UNIT3D 9.2.0': 'UNIT3D',
            '# Project Gazelle': 'Gazelle', '# luminance': 'Luminance',
            '# TBdev (custom)': 'TBDev', '# torznab xml': 'Custom',
            '# engine n/a': 'Custom', '# engine n/a (based on NexusPHP)': 'NexusPHP',
        }.items():
            with self.subTest(footer=footer):
                self.assertEqual(g.prowlarr_codebase('id: example\n' + footer), expected)

    def test_variant_merge_preserves_unit3d_categories(self):
        tracker = self.trackers['seedpool']
        self.assertEqual(sum(t['name'].lower() == 'seedpool' for t in self.index['trackers']), 1)
        self.assertEqual(tracker['codebase'], 'UNIT3D')
        self.assertEqual(tracker['search_source'], 'codebase')
        self.assertTrue(tracker['uses_api'])
        self.assertEqual(g.eligible_ids(tracker, ['Movies']), ['1', '6'])
        self.assertEqual(g.eligible_ids(tracker, ['TV']), ['2', '6'])

    def test_0daykiev_get_url_and_language(self):
        tracker = self.trackers['0day.kiev']
        self.assertEqual(tracker['language'], 'uk-UA')
        self.assertEqual(tracker['codebase'], 'Custom')
        self.assertEqual(tracker['search_source'], 'prowlarr')
        self.assertFalse(tracker['uses_api'])
        self.assertEqual(tracker['search']['category'],
                         {'mode': 'keyed', 'param': 'c{id}', 'value': '1', 'source': 'native'})
        url = g.search_url(tracker, 'Terminator', ['Movies'])
        for item in ('browse.php', 'search=Terminator', 'incldead=1', 'c10=1', 'c11=1', 'c16=1', 'c27=1'):
            self.assertIn(item, url)
        self.assertNotIn('c19=1', url)

    def test_0dayfiles_auth_api_uses_codebase_browser_url(self):
        tracker = self.trackers['0dayfiles']
        self.assertEqual(tracker['language'], 'en-US')
        self.assertEqual(tracker['codebase'], 'UNIT3D')
        self.assertTrue(tracker['uses_api'])
        self.assertEqual(tracker['search_source'], 'codebase')
        self.assertIn('/torrents?', g.search_url(tracker, 'Terminator', ['Movies']))
        self.assertNotIn('apikey', json.dumps(tracker).lower())

    def test_known_codebases_and_privacy_sections(self):
        self.assertEqual(self.trackers['hd-space']['codebase'], 'XBTIT')
        self.assertEqual(self.trackers['example semi']['privacy'], 'semi-private')
        self.assertEqual(self.trackers['example semi']['language'], 'de-DE')
        known = self.trackers['known no search']
        self.assertEqual(known['codebase'], 'TorrentPier')
        self.assertIsNone(known['search'])
        report = g.render(self.index, {})
        self.assertIn('## TorrentPier (1)', report)
        self.assertIn('[Example Semi](https://semi.example.org/)', report)
        self.assertNotIn('## Semi-private trackers', report)
        self.assertIn('## Gazelle (1)', report)
        self.assertLess(report.index('## Public trackers'), report.index('## Unsupported'))
        self.assertIn('[Movies](https://seedpool.org/torrents?', report)

    def test_indexed_and_explicit_categories(self):
        self.assertIn('categoryIds[0]=1', g.search_url(self.trackers['seedpool'], 'Terminator', ['Movies']))
        self.assertIn('categoryIds[1]=6', g.search_url(self.trackers['seedpool'], 'Terminator', ['Movies']))
        rule = next(t['search'] for t in self.overrides['trackers'] if t.get('id') == 'tracker:thepiratebay')
        tp = {'homepage': 'https://thepiratebay.org/', 'search': rule, 'mappings': []}
        self.assertIn('cat=201', g.search_url(tp, 'Terminator', ['Movies']))
        self.assertNotIn('cat=', g.search_url(tp, 'Terminator', ['Movies', 'TV']))

    def test_string_ids_and_eight_families(self):
        mapping = [{'id': name, 'cat': name, 'desc': name} for name in g.FAMILIES]
        rule = next(t['search'] for t in self.defaults['codebases'] if t['codebase'] == 'UNIT3D')
        tracker = {'homepage': 'https://example.org/', 'mappings': mapping, 'search': rule}
        self.assertEqual(g.category_selection(tracker, list(g.FAMILIES)), list(g.FAMILIES))
        self.assertEqual(g.category_families(tracker), list(g.FAMILIES))

    def test_get_inputs_and_auth_guard(self):
        doc = {'search': {'paths': [{'path': 'browse.php'}], 'inputs': {
            '$raw': '{{ range .Categories }}catlist[]={{.}}&{{end}}',
            'search': '{{ .Keywords }}', 'sort': '{{ .Config.sort }}'}}}
        self.assertEqual(g.prowlarr_browser_get(doc)['category']['mode'], 'repeat')
        self.assertNotIn('sort', g.prowlarr_browser_get(doc).get('params', {}))
        doc['search']['paths'] = [{'path': 'torznab.php', 'response': {'type': 'xml'}}]
        self.assertIsNone(g.prowlarr_browser_get(doc))
        doc['search']['paths'] = [{'path': 'search.php', 'method': 'post'}]
        self.assertIsNone(g.prowlarr_browser_get(doc))
        doc['search']['paths'] = [{'path': 'search/{{ .Keywords }}/1/'}]
        doc['search']['inputs'] = {}
        self.assertEqual(g.prowlarr_browser_get(doc)['path'], 'search/{query}/1/')
        doc['search']['headers'] = {'Authorization': 'Bearer secret'}
        self.assertIsNone(g.prowlarr_browser_get(doc))

    def test_author_parameters_are_not_credentials(self):
        for key in ('author', 'authors', 'search_author', 'author_name', 'authorId', 'authorship'):
            with self.subTest(key=key):
                doc = {'search': {'paths': [{'path': 'browse.php'}], 'inputs': {
                    'search': '{{ .Keywords }}', key: '{{ .Query.Author }}'}}}
                rule = g.prowlarr_browser_get(doc)
                self.assertIsNotNone(rule)
                self.assertEqual(rule['params'][key], '{author}')
                url = g.search_url({'homepage': 'https://example.org/', 'search': rule},
                                   'Dune', metadata={'author': 'Frank Herbert'})
                self.assertIn(key + '=Frank+Herbert', url)

    def test_credential_parameters_remain_blocked(self):
        for key in ('auth', 'authkey', 'auth_key', 'Authorization', 'authentication',
                    'auth_token', 'oauth', 'api_key', 'apikey', 'passkey', 'password',
                    'access_token', 'author_auth', 'author_authkey', 'author_token',
                    'author_api_key', 'search_password'):
            with self.subTest(key=key):
                for endpoint, inputs in (
                    ('browse.php', {'search': '{{ .Keywords }}', key: 'secret'}),
                    ('browse.php?' + key + '=secret', {'search': '{{ .Keywords }}'}),
                ):
                    doc = {'search': {'paths': [{'path': endpoint}], 'inputs': inputs}}
                    self.assertIsNone(g.prowlarr_browser_get(doc))

    def test_userscript_regressions(self):
        proc = subprocess.run(['node', str(ROOT / 'tests/test_userscript.js')],
                              check=False, text=True, capture_output=True)
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)

    def test_hostname_merge_even_when_names_are_different(self):
        definitions = {
            'web.yml': '''id: web\nname: Normal Site\ntype: private\nlinks: [https://site.example/]\nsearch:\n  paths: [{path: browse.php}]\n  inputs: {search: "{{ .Keywords }}"}\n# engine n/a\n''',
            'api.yml': '''id: web-api\nname: Very Different Name (API)\ntype: private\nlanguage: en-US\nlinks: [https://www.site.example/]\ncaps:\n  categorymappings: [{id: 10, cat: Movies, desc: Movie}]\nsearch:\n  paths: [{path: api/torrents/filter, response: {type: json}}]\n  headers: {Authorization: "Bearer {{ .Config.apikey }}"}\n# json UNIT3D 9.2.0\n''',
        }
        binary = io.BytesIO()
        with tarfile.open(fileobj=binary, mode='w:gz') as tar:
            for name, data in definitions.items():
                contents = data.encode()
                info = tarfile.TarInfo('Indexers-master/definitions/v11/' + name)
                info.size = len(contents)
                tar.addfile(info, io.BytesIO(contents))
        index, errors = g.make_index(binary.getvalue(), self.defaults, {'trackers': [
            {'homepage': 'https://site.example/', 'id': 'tracker:other-name',
             'search': {'path': 'find', 'query_param': 'q'}}]})
        self.assertFalse(errors)
        self.assertEqual(len(index['trackers']), 1)
        tracker = index['trackers'][0]
        self.assertEqual(tracker['name'], 'Normal Site')
        self.assertEqual(tracker['codebase'], 'UNIT3D')
        self.assertEqual(tracker['language'], 'en-US')
        self.assertEqual(tracker['hosts'], ['site.example'])
        self.assertEqual(tracker['search_source'], 'override')
        self.assertEqual(tracker['search']['path'], 'find')
        self.assertEqual(g.eligible_ids(tracker, ['Movies']), ['10'])
        self.assertTrue(tracker['uses_api'])

    def test_local_definition_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'v11'
            path.mkdir()
            (path / 'test.yml').write_text('''id: test\nname: Test\ntype: public\nlinks: [https://test.example/]\nsearch:\n  paths: [{path: search}]\n  inputs: {q: "{{ .Keywords }}"}\n# engine n/a\n''')
            index, errors = g.make_index(Path(directory), {'codebases': []}, {'trackers': []})
            self.assertFalse(errors)
            self.assertEqual(index['trackers'][0]['search']['query_param'], 'q')

    def test_utf8_sanitization(self):
        self.assertEqual(g.safe_text('Жанр\u200e\ud800\x07\ufffd'), 'Жанр????')

    def test_js_matches_python_url_builder(self):
        js = (ROOT / 'Unit3dRequestsSearch.user.js').read_text(encoding='utf-8')
        ending = "  if (requestsPage) requestPage();"
        self.assertIn(ending, js)
        js = js[:js.index(ending)] + "globalThis.__test = { trackerUrl, sourceFamilies, normalizeMetadata, prowlarrQuery, buildUrl, parseRequestDetails, setTrackers: x => { trackers = x; } };\n})();"
        cases = [
            (self.trackers['seedpool'], 'Terminator', ['Movies']),
            (self.trackers['0day.kiev'], 'Terminator', ['Movies']),
            (self.trackers['0dayfiles'], 'Terminator', ['TV']),
            (self.trackers['hd-space'], 'Terminator', ['Movies', 'TV']),
            (self.trackers['1337x'], 'Terminator', []),
            (self.trackers['digitalcore'], 'A&B', []),
            (self.trackers['seedpool'], 'Terminator (1984)', ['Movies']),
            *[({'homepage': 'https://example.org/', 'search': t['search'], 'mappings': []},
               'A&B (2026)', []) for t in self.overrides['trackers'] if t.get('search')],
        ]
        node = r'''
const vm = require('vm'), fs = require('fs');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const ctx = { location: {protocol:'https:', pathname:'/requests',hostname:'seedpool.org',origin:'https://seedpool.org'},
  GM_getValue:(_,x)=>x, GM_registerMenuCommand:()=>{}, GM_setValue:()=>{}, console, URL, URLSearchParams,
  setTimeout, clearTimeout };
vm.createContext(ctx);
vm.runInContext(input.script, ctx);
ctx.__test.setTrackers(input.cases.map(c => c[0]));
console.log(JSON.stringify({urls: input.cases.map(c => ctx.__test.trackerUrl(c[0],c[1],c[2])),
 families: ctx.__test.sourceFamilies('Anime')}));
'''
        proc = subprocess.run(['node', '-e', node], input=json.dumps({'script': js, 'cases': cases}),
                              text=True, capture_output=True, check=True)
        result = json.loads(proc.stdout)
        for i, case in enumerate(cases):
            with self.subTest(case=i):
                self.assertEqual(result['urls'][i], g.search_url(*case))
        self.assertEqual(set(result['families']), {'Movies', 'TV'})

    def test_metadata_placeholders_in_default_and_prowlarr(self):
        unit = self.trackers['seedpool']
        meta = {'year': '1998', 'imdbId': 'tt0120800', 'tmdbId': '18937',
                'title': 'Quest for Camelot', 'resolution': '2160p', 'type': 'WEB-DL'}
        url = g.search_url(unit, 'Quest for Camelot', ['Movies'], meta)
        self.assertIn('startYear=1998', url)
        self.assertIn('endYear=1998', url)
        self.assertIn('imdbId=0120800', url)
        self.assertIn('tmdbId=18937', url)
        self.assertNotIn('seasonNumber=', url)
        self.assertNotIn('episodeNumber=', url)
        self.assertEqual(g.static_input('{{ .Query.IMDBIDShort }}', {}), '{imdbNumeric}')
        self.assertEqual(g.static_input('{{ .Query.TMDBID }}', {}), '{tmdbId}')
        self.assertEqual(g.static_input('{{ .Query.Season }}', {}), '{season}')
        example = {'search': {'paths': [{'path':'browse.php'}],
                              'inputs': {'search':'{{ .Keywords }}', 'imdb':'{{ .Query.IMDBIDShort }}'}}}
        self.assertEqual(g.prowlarr_browser_get(example)['params']['imdb'], '{imdbNumeric}')

    def test_js_metadata_and_search_consistency(self):
        js = (ROOT / 'Unit3dRequestsSearch.user.js').read_text(encoding='utf-8')
        marker = '  if (requestsPage) requestPage();'
        self.assertIn(marker, js)
        js = js[:js.index(marker)] + '''globalThis.__test = {trackerUrl, normalizeMetadata, prowlarrQuery, buildUrl, parseRequestDetails};
})();'''
        node = r'''
const vm = require('vm'), fs = require('fs');
const input = JSON.parse(fs.readFileSync(0,'utf8'));
const ctx = { location:{protocol:'https:',pathname:'/requests',hostname:'example.org',origin:'https://example.org'},
  GM_getValue:(_, fallback)=>fallback, GM_registerMenuCommand:()=>{}, GM_setValue:()=>{},
  URL, URLSearchParams, console, setTimeout, clearTimeout, Intl };
vm.createContext(ctx);
vm.runInContext(input.script,ctx);
const data=ctx.__test.normalizeMetadata({originalTitle:'The X Factor (DE) - Staffel 2',
  title:'X Factor', year:'2010', families:['TV']});
const movie=ctx.__test.normalizeMetadata({originalTitle:'Das magische Schwert',
  title:'Das magische Schwert', year:'1998', imdbId:'tt0120800', tmdbId:'18937',families:['Movies']});
const got={ normalized:data.searchTitle, movieQuery:ctx.__test.prowlarrQuery(movie),
  url:ctx.__test.trackerUrl(input.tracker, 'Quest for Camelot', ['Movies'], input.meta),
  local:ctx.__test.buildUrl(movie.originalTitle, movie.families, {id:'Prowlarr',type:'local'}, movie) };
console.log(JSON.stringify(got));
'''
        tracker=self.trackers['seedpool']
        meta={'title':'Quest for Camelot','year':'1998','imdbId':'tt0120800','tmdbId':'18937'}
        proc=subprocess.run(['node','-e',node],input=json.dumps({'script':js,'tracker':tracker,'meta':meta}),
                            text=True,capture_output=True,check=True)
        result=json.loads(proc.stdout)
        self.assertEqual(result['normalized'],'X Factor (2010) S02')
        self.assertEqual(result['movieQuery']['searchType'],'movie')
        self.assertEqual(result['movieQuery']['query'], '{ImdbId:tt0120800}{Year:1998}{TmdbId:18937}')
        self.assertEqual(result['url'], g.search_url(tracker,'Quest for Camelot',['Movies'],meta))
        self.assertIn('stype=movie',result['local'])


if __name__ == '__main__':
    unittest.main()
