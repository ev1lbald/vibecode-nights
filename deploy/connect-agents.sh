#!/usr/bin/env bash
# Source archive and root-only environment files are supplied outside Git.
set -euo pipefail
release="/opt/vibecode-nights/releases/$(date -u +%Y%m%dT%H%M%SZ)-live"
mkdir -p "$release"
tar -xzf /tmp/vibecode-nights-live.tar.gz -C "$release"
cd "$release"
docker build --progress=plain -f Dockerfile.agents -t vibecode-nights-agents:latest .
docker build --progress=plain -t vibecode-nights:latest .
docker network inspect vibecode-nights_private >/dev/null 2>&1 || docker network create vibecode-nights_private
docker volume create vibecode-nights-agent-data >/dev/null
if docker container inspect vibecode-nights-agents >/dev/null 2>&1; then
  docker stop vibecode-nights-agents
  docker rename vibecode-nights-agents "vibecode-nights-agents-previous-$(date +%s)"
fi
docker run -d --name vibecode-nights-agents --restart unless-stopped --network vibecode-nights_private --env-file /opt/vibecode-nights/shared/agents.env -v vibecode-nights-agent-data:/app/data vibecode-nights-agents:latest
for attempt in $(seq 1 30); do
  if docker exec vibecode-nights-agents /app/.venv/bin/python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=4)"; then break; fi
  sleep 2
done
docker exec vibecode-nights-agents /app/.venv/bin/python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=4)"
docker exec -i vibecode-nights-agents /app/.venv/bin/python < deploy/verify-provider.py
previous="vibecode-nights-web-previous-$(date +%s)"
docker stop vibecode-nights-web
docker rename vibecode-nights-web "$previous"
rollback() {
  docker rm -f vibecode-nights-web >/dev/null 2>&1 || true
  docker rename "$previous" vibecode-nights-web
  docker start vibecode-nights-web
}
if ! docker run -d --name vibecode-nights-web --restart unless-stopped --network npa-analyst_default --env-file /opt/vibecode-nights/shared/web.env -v vibecode-nights-data:/app/data vibecode-nights:latest; then rollback; exit 1; fi
docker network connect vibecode-nights_private vibecode-nights-web
for attempt in $(seq 1 20); do
  if docker exec vibecode-nights-web node -e "fetch('http://127.0.0.1:3000/api/v1/config').then(async r=>{const c=await r.json();process.exit(r.ok&&c.mode==='live'?0:1)}).catch(()=>process.exit(1))"; then break; fi
  sleep 2
done
if ! docker exec vibecode-nights-web node -e "fetch('http://127.0.0.1:3000/api/v1/config').then(async r=>{const c=await r.json();console.log(JSON.stringify({mode:c.mode,questions:c.question_count,advice:c.advice_count}));process.exit(r.ok&&c.mode==='live'?0:1)}).catch(()=>process.exit(1))"; then rollback; exit 1; fi
ln -sfn "$release" /opt/vibecode-nights/current
curl -fsS --retry 3 https://157-228-191-238.sslip.io/healthz
docker ps --format '{{.Names}} {{.Status}}' | head -8
