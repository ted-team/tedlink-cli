# tedlink-cli

Node.js rewrite of the TedLink CLI client.

Usage:

```bash
./src/main.js --help
```

For the v3.1 `tedlink-server` API:

```bash
export TEDLINK_BASE_URL=http://127.0.0.1:8000
export TEDLINK_AUTH_TOKEN=replace-me
export ANTHROPIC_AUTH_TOKEN=sk-ant-...
export ANTHROPIC_BASE_URL=https://api.anthropic.com
export ANTHROPIC_MODEL=claude-sonnet-4-6
./src/main.js --prompt "run simulation" --dir .
```

The client uses:

- `POST /api/v3/session/create`
- `POST /api/v3/orchestrate/chat`
- `POST /api/v3/session/recover`
- `GET /api/v3/sync/download`
