"""Read-only deployment probes. Never print credentials or response bodies."""
import httpx
from langfuse import Langfuse
from pitch_api.config import RuntimeSettings

settings = RuntimeSettings()
headers = {}
if settings.llm_api_key:
    headers["Authorization"] = f"Bearer {settings.llm_api_key.get_secret_value()}"
with httpx.Client(timeout=90) as client:
    response = client.post(
        str(settings.llm_base_url).rstrip("/") + "/chat/completions",
        headers=headers,
        json={"model": settings.llm_model, "messages": [{"role": "user", "content": "Ответь одним словом: готов."}], "max_tokens": 128},
    )
    print(f"Provider probe: HTTP {response.status_code}; model={settings.llm_model}", flush=True)
    response.raise_for_status()
if settings.langfuse_public_key:
    tracer = Langfuse(public_key=settings.langfuse_public_key, secret_key=settings.langfuse_secret_key.get_secret_value(), base_url=str(settings.langfuse_base_url).rstrip('/'))
    print(f"Langfuse authentication: {tracer.auth_check()}", flush=True)
    tracer.shutdown()
