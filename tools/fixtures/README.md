# Reference fixtures

`fixtures/` holds parsedmarc's own output for every file in `samples/`, used by the tests to check that tsdmarc produces the same content.

Regenerate them after porting a new parsedmarc version:

```bash
uv venv .venv -p python3.14
uv pip install -p .venv/bin/python "./upstream/parsedmarc[all,postgresql]" ./upstream/mailsuite
pnpm fixtures
```

Parsing runs offline with the bundled files only, and with `TZ=UTC`, so the output is deterministic.
