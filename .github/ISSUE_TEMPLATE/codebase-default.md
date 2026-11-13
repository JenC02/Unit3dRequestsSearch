---
name: Codebase search default
about: Propose a reusable browser-search rule for a tracker codebase
title: '[Codebase default] '
---

## Codebase

**Codebase name** (e.g. UNIT3D, NexusPHP):

## Verified websites

Provide **at least two different websites** using the same codebase, if available. A rule that works for only one tracker is usually a tracker override.

| Tracker | Homepage | Working browser search URL |
|---|---|---|
| | | |
| | | |

## Search rule

- **Search path and query parameter:**
- **Category format and native category IDs (if tested):**
- **Optional metadata parameters (if supported):**
- **Differences between sites (if any):**

**Proposed entry for `data/codebase-defaults.json` (optional):**

```json
{
  "codebase": "ExampleCodebase",
  "search": {"path": "torrents.php", "query_param": "search"}
}
```

Explain how you verified the same rule on the listed sites. If the format is specific to a single site, please use the **Tracker override** issue template instead.

Do not submit passkeys, API keys, cookies, or other credentials.
