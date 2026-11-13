"""Generate tracker-index.json and TRACKERS.md from Prowlarr indexer YAML.

    python scripts/generate-support.py --update
    python scripts/generate-support.py --update --definitions-archive local.tar.gz
    python scripts/generate-support.py --update --definitions-dir /path/to/definitions
    python scripts/generate-support.py           # offline: rebuild TRACKERS.md

Requires Python 3.12+ and PyYAML. Browser search precedence:
tracker-overrides.json > Prowlarr browser GET > codebase-defaults.json.
"""

import argparse
import copy
import io
import json
import re
import tarfile
import unicodedata
import urllib.request
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import parse_qsl, quote, urlencode, urljoin, urlsplit, urlunsplit

import yaml

ROOT = Path(__file__).resolve().parent.parent
PROWLARR = 'https://codeload.github.com/Prowlarr/Indexers/tar.gz/refs/heads/master'
VERSIONS = re.compile(r'(?:^|/)definitions/v(\d+)/([^/]+)\.ya?ml$', re.IGNORECASE)
FAMILIES = ('Movies', 'TV', 'Audio', 'Books', 'PC', 'Console', 'XXX', 'Other')
EXAMPLES = {'Movies': 'Terminator', 'TV': 'The Sopranos', 'Audio': 'Pink Floyd',
            'Books': 'Dune', 'PC': 'Half Life', 'Console': 'Super Mario',
            'XXX': 'Test', 'Other': 'Linux'}
VALID_TESTS = {'passed', 'failed', 'untested'}
KEYWORD = re.compile(r'^\s*{{\s*\.Keywords\s*}}\s*$')
CATEGORY_JOIN = re.compile(r'^\s*{{\s*join\s+\.Categories\s+["\']([^"\']+)["\']\s*}}\s*$')
# These strings identify the general website platform, not an API/version/fork.
# Only the last comment of each definition is examined.
CODEBASE_KEYWORDS = {
    'UNIT3D': ('unit3d', 'traxary'),
    'NexusPHP': ('nexusphp',),
    'XBTIT': ('xbtit',),
    'Gazelle': ('gazelle',),
    'Luminance': ('luminance',),
    'TorrentPier': ('torrentpier',),
    'TBDev': ('tbdev', 'tbsource'),
    'TorrentTrader': ('torrenttrader',),
    'TS Special Edition': ('ts special edition',),
    'TSUE': ('tsue',),
    'U-232': ('u-232',),
    'DataLife': ('datalife',),
    'WordPress': ('wordpress',),
    'phpBB': ('phpbb',),
    'NetVision': ('netvision',),
    'XBTT': ('xbtt',),
    'THX': ('thx',),
    '3xT': ('3xt',),
    'AEON': ('aeon',),
    'Discuz!': ('discuz!',),
    'PaTracker': ('patracker',),
    'RarTracker': ('rartracker',),
    'TorrentHR': ('torrenthr',),
    'EzTorrent': ('eztorrent',),
    'BTiTracker': ('btitracker',),
    'Tesla': ('tesla',),
    'Kinokpk': ('kinokpk',),
    'CGPeers': ('cgpeers',),
    'crankShaft': ('crankshaft',),
    'MioBT': ('miobt',),
    'Majomparade': ('majomparádé',),
    'Last Files': ('last files',),
    'Torrent Search': ('torrent search',),
}


def safe_text(value):
    raw = unicodedata.normalize('NFC', str(value if value is not None else ''))
    return ''.join('?' if c == '\ufffd' or unicodedata.category(c) in ('Cc', 'Cf', 'Cs') else c
                   for c in raw.encode('utf-8', errors='replace').decode('utf-8'))


def sanitize_json(value):
    if isinstance(value, str):
        return safe_text(value)
    if isinstance(value, list):
        return [sanitize_json(item) for item in value]
    if isinstance(value, dict):
        return {safe_text(k): sanitize_json(v) for k, v in value.items()}
    return value


def host(url):
    try:
        return (urlsplit(url).hostname or '').lower().removeprefix('www.')
    except ValueError:
        return ''


def is_valid_url(value):
    try:
        parts = urlsplit(value)
        return parts.scheme in ('https', 'http') and bool(parts.hostname)
    except (TypeError, ValueError):
        return False


def family(category):
    root = str(category or '').split('/', 1)[0]
    return root if root in FAMILIES else None


def load_json(path):
    return json.loads(path.read_text(encoding='utf-8'))


def write_if_changed(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists() and path.read_text(encoding='utf-8') == value:
        return False
    path.write_text(value, encoding='utf-8')
    return True


def mappings_from_caps(caps):
    output = []
    if not isinstance(caps, dict):
        return output
    for item in caps.get('categorymappings') or []:
        if isinstance(item, dict) and 'id' in item and family(item.get('cat')):
            output.append({'id': item['id'], 'cat': str(item['cat']),
                           'desc': safe_text(item.get('desc') or '')})
    categories = caps.get('categories') or {}
    if isinstance(categories, dict):
        for native_id, cat in categories.items():
            if isinstance(cat, dict):
                cat, description = cat.get('cat'), cat.get('desc', '')
            else:
                description = ''
            if family(cat):
                output.append({'id': native_id, 'cat': str(cat), 'desc': safe_text(description)})
    return output


def prowlarr_codebase(source):
    """Read a footer as a free-form platform hint; ignore API, version and fork names."""
    lines = source.rstrip().splitlines()
    footer = lines[-1].strip().lower() if lines else ''
    if not footer.startswith('#'):
        return 'Custom'
    for codebase, keywords in CODEBASE_KEYWORDS.items():
        if any(keyword in footer for keyword in keywords):
            return codebase
    return 'Custom'


def static_input(value, defaults):
    """Convert literal params and ordinary Prowlarr setting defaults to URL constants."""
    if isinstance(value, bool):
        return str(value).lower()
    if not isinstance(value, str):
        return str(value) if value is not None else None
    if '{{' not in value and '}}' not in value:
        return value
    query_fields = {
        'IMDBID': 'imdbId', 'IMDBIDSHORT': 'imdbNumeric',
        'TMDBID': 'tmdbId', 'TVDBID': 'tvdbId', 'TVMAZEID': 'tvMazeId',
        'YEAR': 'year', 'SEASON': 'season', 'EP': 'episode', 'EPISODE': 'episode',
        'ARTIST': 'artist', 'ALBUM': 'album', 'LABEL': 'label',
        'AUTHOR': 'author', 'TITLE': 'title',
        'RESOLUTION': 'resolution', 'TYPE': 'type'
    }
    query_field = re.fullmatch(r'\s*{{\s*\.Query\.(\w+)\s*}}\s*', value)
    if query_field and query_field.group(1).upper() in query_fields:
        return '{' + query_fields[query_field.group(1).upper()] + '}'
    matched = re.fullmatch(r'\s*{{\s*\.Config\.(\w+)\s*}}\s*', value)
    if matched and matched.group(1) in defaults:
        return static_input(defaults[matched.group(1)], {})
    matched = re.fullmatch(
        r'\s*{{\s*if\s+(not\s+)?\.Config\.(\w+)\s*}}\s*([^{}]*?)'
        r'\s*{{\s*else\s*}}\s*([^{}]*?)\s*{{\s*end\s*}}\s*', value)
    if matched and isinstance(defaults.get(matched.group(2)), bool):
        flag = defaults[matched.group(2)]
        if matched.group(1):
            flag = not flag
        result = matched.group(3 if flag else 4).strip()
        return result if result and '{{' not in result else None
    return None


def raw_category_rule(raw):
    """Handle ordinary Cardigann loops that emit one query pair per category."""
    found = re.fullmatch(r'\s*{{\s*range\s+\.Categories\s*}}(.*?){{\s*end\s*}}\s*', raw, re.DOTALL)
    if not found:
        return None
    fragment = re.sub(r'{{\s*\.\s*}}', '{id}', found.group(1)).strip('& \t\n')
    if '{{' in fragment or '}}' in fragment:
        return None
    pairs = parse_qsl(fragment, keep_blank_values=True)
    if len(pairs) != 1:
        return None
    key, value = pairs[0]
    if '{id}' in key and '{id}' not in value and key.count('{id}') == 1:
        return {'mode': 'keyed', 'param': key, 'value': value, 'source': 'native'}
    if value == '{id}' and '{id}' not in key:
        return {'mode': 'repeat', 'param': key, 'source': 'native'}
    return None


def prowlarr_browser_get(doc):
    """Extract a browser-navigable GET rule from a parsed Cardigann search block.

    We don't emulate Cardigann, export credentials or treat POST/API searches as
    browser navigation. Prefer a path with no category-specific routing.
    """
    if not isinstance(doc, dict):
        return None
    search = doc.get('search') or {}
    if not isinstance(search, dict):
        return None
    for location in (search,):
        headers = location.get('headers') or {}
        if headers and any(k.lower() in ('authorization', 'cookie', 'x-api-key', 'apikey')
                           for k in headers):
            return None
    defaults = {entry['name']: entry['default'] for entry in doc.get('settings', []) or []
                if isinstance(entry, dict) and isinstance(entry.get('name'), str)
                and 'default' in entry}
    paths = search.get('paths') or ([{'path': search['path']}] if search.get('path') else [])
    for path in paths if isinstance(paths, list) else []:
        if isinstance(path, str):
            path = {'path': path}
        if not isinstance(path, dict) or path.get('categories'):
            continue
        endpoint = path.get('path')
        if not isinstance(endpoint, str) or not endpoint or endpoint.startswith(('/', '../', '//')):
            continue
        if str(path.get('method') or search.get('method') or 'get').lower() != 'get':
            continue
        if any(k.lower() in ('authorization', 'cookie', 'x-api-key', 'apikey')
               for k in (path.get('headers') or {})):
            continue
        response = path.get('response') or {}
        if (isinstance(response, dict) and str(response.get('type', '')).lower() in ('json', 'xml')) or \
           str((search.get('response') or {}).get('type', '')).lower() in ('json', 'xml'):
            continue
        if re.search(r'(?:^|/)(?:api|torznab|jackett)(?:/|\.|$)', endpoint, re.IGNORECASE):
            continue
        route, sep, query_string = endpoint.partition('?')
        route = re.sub(r'{{\s*\.Keywords\s*}}', '{query}', route)
        if '{{' in route or '}}' in route:
            continue
        if urlsplit(route).scheme or route.startswith('//'):
            continue
        inputs = search.get('inputs') or {}
        local_inputs = path.get('inputs') or {}
        if not isinstance(inputs, dict) or not isinstance(local_inputs, dict):
            continue
        inputs = {**(inputs if path.get('inheritinputs', True) else {}), **local_inputs}
        params = {}
        query_param = None
        category = None
        invalid = False
        for key, val in ([*parse_qsl(query_string, keep_blank_values=True)] if sep else []) + list(inputs.items()):
            # Author metadata is not an authentication parameter. Keep blocking auth/authkey/authorization, including alongside author components.
            if not isinstance(key, str) or any(word in key.lower()
                for word in ('apikey', 'api_key', 'passkey', 'token', 'password')) or \
               re.search(r'auth(?!or(?:s|ship|id)?(?:$|[^a-z0-9]))', key, re.IGNORECASE):
                invalid = True
                break
            if key == '$raw':
                category = raw_category_rule(str(val))
                if category is None:
                    invalid = True
                    break
            elif isinstance(val, str) and KEYWORD.fullmatch(val):
                if query_param or '{query}' in route:
                    invalid = True
                    break
                query_param = key
            elif isinstance(val, str) and CATEGORY_JOIN.fullmatch(val):
                category = {'mode': 'joined', 'param': key,
                            'separator': CATEGORY_JOIN.fullmatch(val).group(1), 'source': 'native'}
            elif isinstance(val, str) and re.fullmatch(r'{{\s*\.Categories\s*}}', val):
                category = {'mode': 'joined', 'param': key, 'separator': ',', 'source': 'native'}
            else:
                fixed = static_input(val, defaults)
                if fixed is not None:
                    params[key] = fixed
                elif '{{' in str(val):
                    pass
        if invalid or (not query_param and '{query}' not in route):
            continue
        rule = {'path': route}
        if query_param:
            rule['query_param'] = query_param
        if params:
            rule['params'] = params
        if category:
            rule['category'] = category
        return rule
    return None


def make_index(archive_bytes, codebases, overrides):
    """Parse and merge Prowlarr definitions, then apply defaults and overrides."""
    newest = {}
    if isinstance(archive_bytes, (str, Path)) and Path(archive_bytes).is_dir():
        source_files = ((f'definitions/{file.relative_to(archive_bytes).as_posix()}',
                         file.read_text(encoding='utf-8-sig', errors='replace'))
                        for file in Path(archive_bytes).rglob('*.yml'))
    else:
        with tarfile.open(fileobj=io.BytesIO(archive_bytes), mode='r:gz') as archive:
            source_files = []
            for member in archive:
                if member.isfile() and VERSIONS.search(member.name):
                    source_files.append((member.name, archive.extractfile(member).read()
                                         .decode('utf-8-sig', errors='replace')))
    for filename, source in source_files:
        match = VERSIONS.search(filename.replace('\\', '/'))
        if not match:
            continue
        version, ident = int(match.group(1)), match.group(2).lower()
        if version < 11 or (ident in newest and newest[ident][0] >= version):
            continue
        newest[ident] = (version, source)
    if not newest:
        raise ValueError('No Prowlarr v11+ YAML definitions found')

    errors = []
    definitions = []
    for ident, (_, source) in sorted(newest.items()):
        try:
            doc = yaml.safe_load(source)
            if not isinstance(doc, dict):
                continue
            links = [link for link in doc.get('links') or [] if isinstance(link, str) and is_valid_url(link)]
            if not links:
                continue
            legacy = [link for link in doc.get('legacylinks') or [] if isinstance(link, str) and is_valid_url(link)]
            aliases = {host(link) for link in links + legacy}
            language = doc.get('language') or ''
            if isinstance(language, list):
                language = ', '.join(str(item) for item in language)
            name = re.sub(r'\s*(?:\((?:api|2fa|cookie)\)|[-_\s]+(?:api|2fa|cookie))\s*$',
                          '', str(doc.get('name') or ident), flags=re.IGNORECASE).strip()
            search_block = doc.get('search') or {}
            if not isinstance(search_block, dict):
                search_block = {}
            paths = search_block.get('paths') or []
            if not isinstance(paths, list):
                paths = []
            is_api = ident.endswith('-api') or (
                any(k.lower() in ('authorization', 'x-api-key')
                    for k in (search_block.get('headers') or {})) or
                any(isinstance(p, dict) and (
                    'api/' in str(p.get('path') or '').lower() or
                    str((p.get('response') or {}).get('type', '')).lower() in ('json', 'xml'))
                    for p in paths))
            definitions.append({
                'id': ident, 'name': safe_text(name), 'homepage': links[0],
                'hosts': sorted(aliases), 'privacy': str(doc.get('type') or 'unknown').lower(),
                'language': safe_text(language), 'codebase': prowlarr_codebase(source),
                'uses_api': bool(is_api),
                'mappings': mappings_from_caps(doc.get('caps') or {}),
                '_search': prowlarr_browser_get(doc), '_ids': {ident},
            })
        except (yaml.YAMLError, ValueError, TypeError) as exc:
            errors.append((ident, str(exc)))
    if not definitions:
        raise ValueError('No usable Prowlarr YAML definitions')

    groups = []
    for tracker in definitions:
        collisions = [group for group in groups if set(tracker['hosts']) & set(group['hosts'])]
        if not collisions:
            groups.append(tracker)
            continue
        candidates = [tracker] + collisions
        candidates.sort(key=lambda t: (bool(re.search(r'(?:api|2fa|cookie)$', t['id'], re.IGNORECASE)),
                                       len(t['id']), t['id']))
        primary = candidates[0]
        primary['hosts'] = sorted(set().union(*(set(t['hosts']) for t in candidates)))
        primary['_ids'] = set().union(*(t['_ids'] for t in candidates))
        primary['uses_api'] = any(t['uses_api'] for t in candidates)
        primary['codebase'] = next((t['codebase'] for t in candidates if t['codebase'] != 'Custom'), 'Custom')
        primary['_search'] = next((t['_search'] for t in candidates if t['_search']), None)
        primary['language'] = next((t['language'] for t in candidates if t['language']), '')
        by_id_cat = {}
        for variant in candidates:
            for mapping in variant['mappings']:
                key = (str(mapping['id']), mapping['cat'])
                if key not in by_id_cat or 'deprecated' in by_id_cat[key]['desc'].lower():
                    by_id_cat[key] = mapping
        primary['mappings'] = list(by_id_cat.values())
        for old in collisions:
            groups.remove(old)
        groups.append(primary)

    defaults = {entry['codebase']: entry['search'] for entry in codebases['codebases']
                if isinstance(entry, dict) and isinstance(entry.get('codebase'), str)
                and isinstance(entry.get('search'), dict)}
    matched_overrides = set()
    for tracker in groups:
        tracker['search'] = copy.deepcopy(tracker['_search'] or defaults.get(tracker['codebase']))
        tracker['search_source'] = ('prowlarr' if tracker['_search'] else
                                    'codebase' if tracker['search'] else None)
        tracker['codebase_source'] = 'prowlarr_comment' if tracker['codebase'] != 'Custom' else 'unknown'
        for i, override in enumerate(overrides['trackers']):
            if not isinstance(override, dict):
                continue
            override_hosts = {host(override.get('homepage'))} | {
                host(h) if '://' in str(h) else str(h).lower().removeprefix('www.')
                for h in (override.get('hosts') or [])
            }
            override_hosts.discard('')
            override_id = str(override.get('id') or '').removeprefix('tracker:')
            if not (override_hosts.intersection(tracker['hosts']) or
                    (override_id and override_id in tracker['_ids'])):
                continue
            matched_overrides.add(i)
            for key, value in override.items():
                if key == 'id':
                    continue
                if key == 'homepage':
                    if not is_valid_url(value):
                        raise ValueError(f'Invalid override homepage for {tracker["id"]}: {value}')
                    tracker['hosts'] = sorted(set(tracker['hosts']) | {host(value)})
                    tracker['homepage'] = value
                elif key == 'hosts':
                    tracker['hosts'] = sorted(set(tracker['hosts']) | {
                        host(h) if '://' in str(h) else str(h).lower().removeprefix('www.')
                        for h in value
                    })
                elif key == 'name':
                    tracker['name'] = safe_text(value)
                elif key in ('search', 'codebase', 'privacy', 'language', 'mappings', 'uses_api'):
                    tracker[key] = copy.deepcopy(value)
                    if key == 'search':
                        tracker['search_source'] = 'override' if value else None
                    if key == 'codebase':
                        tracker['codebase_source'] = 'override'
                        if 'search' not in override and not tracker['_search']:
                            tracker['search'] = copy.deepcopy(defaults.get(value))
                            tracker['search_source'] = 'codebase' if tracker['search'] else None

    for i, extra in enumerate(overrides['trackers']):
        if i in matched_overrides:
            continue
        if not all(extra.get(k) for k in ('id', 'name', 'homepage')) or not is_valid_url(extra['homepage']):
            continue
        groups.append({
            'id': str(extra['id']).removeprefix('tracker:'),
            'name': safe_text(extra['name']), 'homepage': extra['homepage'],
            'hosts': sorted({host(extra['homepage'])} | set(extra.get('hosts') or [])),
            'privacy': extra.get('privacy', 'unknown'), 'language': safe_text(extra.get('language', '')),
            'codebase': extra.get('codebase', 'Custom'), 'codebase_source': 'override',
            'uses_api': bool(extra.get('uses_api', False)),
            'mappings': copy.deepcopy(extra.get('mappings') or []),
            'search': copy.deepcopy(extra.get('search')),
            'search_source': 'override' if extra.get('search') else None,
        })

    output = []
    for tracker in groups:
        output.append(sanitize_json({
            'id': 'tracker:' + tracker['id'], 'name': tracker['name'],
            'homepage': tracker['homepage'], 'hosts': tracker['hosts'],
            'privacy': tracker['privacy'], 'language': tracker['language'],
            'uses_api': tracker['uses_api'],
            'codebase': tracker['codebase'], 'codebase_source': tracker['codebase_source'],
            'mappings': tracker['mappings'], 'search': tracker['search'],
            'search_source': tracker['search_source'],
        }))
    output.sort(key=lambda t: (t['name'].casefold(), t['id']))
    return {'schema_version': 1,
            'generated_at': datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
            'sources': {'prowlarr': PROWLARR}, 'trackers': output}, errors

def eligible_ids(tracker, families):
    output = []
    for mapping in tracker['mappings']:
        if family(mapping['cat']) in families and 'deprecated' not in mapping['desc'].lower():
            native_id = str(mapping['id'])
            if native_id not in output:
                output.append(native_id)
    return output


def category_selection(tracker, families):
    rule = (tracker.get('search') or {}).get('category')
    if not rule:
        return []
    if rule.get('source') == 'explicit':
        mapping = rule.get('map', {})
        if not set(families).issubset(mapping):
            return []
        ids = list(dict.fromkeys(str(v) for cat in families for v in mapping[cat]))
        return ids if rule.get('mode') != 'single' or len(ids) == 1 else []
    if rule.get('source') == 'native':
        ids = eligible_ids(tracker, families)
        return ids if rule.get('mode') != 'single' or len(ids) == 1 else []
    return []


def category_families(tracker):
    if not tracker.get('search') or not tracker['search'].get('category'):
        return []
    return [f for f in FAMILIES if category_selection(tracker, [f])]


def search_url(tracker, term, families=(), metadata=None):
    """Reference interpreter. Optional metadata tokens are omitted when unavailable."""
    rule = tracker.get('search')
    if not rule or not is_valid_url(tracker['homepage']):
        return tracker['homepage']
    data = dict(metadata or {})
    if data.get('imdbId'):
        data['imdbNumeric'] = str(data['imdbId']).removeprefix('tt')
    fields = ('year', 'season', 'episode', 'imdbId', 'imdbNumeric', 'tmdbId',
              'tvdbId', 'tvMazeId', 'artist', 'album', 'label', 'author', 'title',
              'resolution', 'type')
    placeholder = re.compile(r'\{(' + '|'.join(fields) + r')\}')

    def substitute(value):
        value = str(value)
        found = placeholder.findall(value)
        if any(data.get(name) is None or data.get(name) == '' for name in found):
            return None
        return placeholder.sub(lambda m: str(data[m.group(1)]), value)

    value = term + rule.get('query_suffix', '')
    transform = rule.get('query_transform', 'none')
    if transform.startswith('slug'):
        value = re.sub(r'\s+', '-', re.sub(r'[-&]', '', value).strip())
        if transform == 'slug_lower':
            value = value.lower()
    route = rule.get('path', '')
    path_term = quote(value, safe='')
    route = route.replace('{initial}', path_term[:1]).replace('{query}', path_term)
    base = urljoin(tracker['homepage'].rstrip('/') + '/', route)
    parts = urlsplit(base)
    params = list(parse_qsl(parts.query, keep_blank_values=True))
    for k, v in rule.get('params', {}).items():
        resolved = substitute(v)
        if resolved is not None:
            params.append((str(k), resolved))
    if rule.get('query_param'):
        params.append((rule['query_param'], value))
    native_ids = category_selection(tracker, families)
    cat = rule.get('category') or {}
    if native_ids:
        mode, label = cat.get('mode'), cat.get('param', '')
        if mode == 'indexed':
            params.extend((label.replace('{index}', str(i)), v) for i, v in enumerate(native_ids))
        elif mode == 'repeat':
            params.extend((label, v) for v in native_ids)
        elif mode == 'joined':
            params.append((label, cat.get('separator', ',').join(native_ids)))
        elif mode == 'keyed':
            params.extend((label.replace('{id}', v), cat.get('value', '1')) for v in native_ids)
        elif mode == 'single' and len(native_ids) == 1:
            params.append((label, native_ids[0]))
        if mode != 'single' or len(native_ids) == 1:
            params.extend((str(k), str(v)) for k, v in cat.get('when_selected', {}).items())
    return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(params), '')) \
        .replace('%5B', '[').replace('%5D', ']')


def md(value):
    return str(value).replace('|', '\\|').replace('\n', ' ').replace(']', '\\]')


def markdown_link(label, url):
    return f'[{md(label)}]({url.replace("(", "%28").replace(")", "%29")})'


def validate_tests(tests):
    if not isinstance(tests, dict):
        raise TypeError('tracker-tests.json must contain a JSON object')
    for domain, test in tests.items():
        if not isinstance(test, dict):
            raise TypeError(f'{domain}: expected an object')
        if test.get('search', 'untested') not in VALID_TESTS:
            raise ValueError(f'{domain}: invalid search test status')
        for cat, status in test.get('categories', {}).items():
            if cat not in FAMILIES or status not in VALID_TESTS:
                raise ValueError(f'{domain}: invalid test for {cat}')


def render(index, tests):
    groups = defaultdict(list)
    totals = Counter()
    for tracker in index['trackers']:
        supported = bool(tracker.get('search'))
        group = ('Public trackers' if tracker['privacy'] == 'public' else
                 tracker['codebase'] if tracker['codebase'] != 'Custom' else
                 'Custom' if supported else 'Unsupported')
        groups[group].append(tracker)
        totals['all'] += 1
        totals['supported'] += supported
    order = sorted(g for g in groups if g not in ('Custom', 'Public trackers', 'Unsupported'))
    order.extend(g for g in ('Custom', 'Public trackers', 'Unsupported') if g in groups)
    result = ['# Tracker compatibility', '',
              '> [!NOTE]',
              '> Generated from `data/tracker-index.json` and `data/tracker-tests.json`.',
              '> A generated search link is **not** proof that the search works on the website.',
              '> Search and category test results are recorded manually.', '',
              f'**{totals["all"]} trackers** · **{totals["supported"]} searchable**', '',
              'Category links use fixed example terms so they can be tested manually.',
              '`*` means category selection requires JavaScript and the URL alone is insufficient.', '']
    for group in order:
        trackers = groups[group]
        result += [f'## {group} ({len(trackers)})', '',
                   '| Tracker | Codebase | Search | Search tested | Category filters | Category tested |',
                   '| --- | --- | :---: | :---: | --- | :---: |']
        for tracker in trackers:
            website = tracker['homepage']
            test = tests.get(host(website), {})
            search = tracker.get('search')
            cat_test = test.get('categories', {})
            possible = category_families(tracker)
            filters = []
            for cat in possible:
                link = markdown_link(cat + ('*' if search.get('requires_js') else ''),
                                     search_url(tracker, EXAMPLES[cat], [cat]))
                filters.append(link)
            passed = sum(cat_test.get(c) == 'passed' for c in possible)
            failed = sum(cat_test.get(c) == 'failed' for c in possible)
            tested = f'{passed}/{len(possible)}' + (f' · {failed} ❌' if failed else '') if possible else '—'
            status = {'passed': '✅', 'failed': '❌', 'untested': '❔'}[test.get('search', 'untested')]
            result.append(f'| {markdown_link(tracker["name"], website)} | {md(tracker["codebase"])} '
                          f'| {"✅" if search else "—"} '
                          f'| {status if search else '—'} '
                          f'| {", ".join(filters) if filters else "—"} | {tested} |')
        result.append('')
    return '\n'.join(result).rstrip() + '\n'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--update', action='store_true', help='Refresh tracker index from Prowlarr')
    source = parser.add_mutually_exclusive_group()
    source.add_argument('--definitions-archive', type=Path, help='Local Prowlarr definitions archive (with --update)')
    source.add_argument('--definitions-dir', type=Path, help='Local Prowlarr definitions/ directory (with --update)')
    parser.add_argument('--index', type=Path, default=ROOT / 'data/tracker-index.json')
    parser.add_argument('--codebase-defaults', type=Path, default=ROOT / 'data/codebase-defaults.json')
    parser.add_argument('--overrides', type=Path, default=ROOT / 'data/tracker-overrides.json')
    parser.add_argument('--tests', type=Path, default=ROOT / 'data/tracker-tests.json')
    parser.add_argument('--output', type=Path, default=ROOT / 'docs/TRACKERS.md')
    args = parser.parse_args()
    if args.update:
        if args.definitions_dir:
            source = args.definitions_dir
        elif args.definitions_archive:
            source = args.definitions_archive.read_bytes()
        else:
            request = urllib.request.Request(PROWLARR, headers={'User-Agent': 'Unit3dRequestsSearch/1.0'})
            with urllib.request.urlopen(request, timeout=90) as response:
                source = response.read()
        index, skipped = make_index(source, load_json(args.codebase_defaults), load_json(args.overrides))
        if args.index.exists():
            previous = load_json(args.index)
            if previous.get('trackers') == index['trackers'] and previous.get('sources') == index['sources']:
                index['generated_at'] = previous.get('generated_at')
        changed = write_if_changed(args.index, json.dumps(index, ensure_ascii=False, indent=2) + '\n')
        print(f'{"Updated" if changed else "Unchanged"} {args.index}: {len(index["trackers"])} trackers')
        counts = Counter(t['search_source'] or 'unsupported' for t in index['trackers'])
        print('Search rules: ' + ', '.join(f'{k}={v}' for k, v in sorted(counts.items())))
        print('Codebases identified: ' + str(sum(t['codebase'] != 'Custom' for t in index['trackers'])))
        for ident, reason in skipped[:30]:
            print(f'WARNING {ident}: {reason}')
        if len(skipped) > 30:
            print(f'... and {len(skipped) - 30} more warnings')
    elif not args.index.exists():
        parser.error('No tracker index exists. Run with --update first.')
    index = load_json(args.index)
    if index.get('schema_version') != 1 or not isinstance(index.get('trackers'), list):
        raise ValueError('Unsupported tracker-index.json schema')
    tests = load_json(args.tests) if args.tests.exists() else {}
    validate_tests(tests)
    changed = write_if_changed(args.output, render(index, tests))
    print(f'{"Updated" if changed else "Unchanged"} {args.output}')
    unlisted = set(tests) - {host(t['homepage']) for t in index['trackers']}
    if unlisted:
        print('WARNING: test domains absent from index: ' + ', '.join(sorted(unlisted)))


if __name__ == '__main__':
    main()
