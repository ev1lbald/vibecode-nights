from contextlib import contextmanager, nullcontext
import json
import re
from time import sleep
from typing import Callable, TypeVar

import httpx
from langfuse import Langfuse, propagate_attributes

from .config import RuntimeSettings


T = TypeVar("T")


class ModelError(Exception):
    pass


class ChatModel:
    def __init__(self, settings: RuntimeSettings, client: httpx.Client):
        self.settings = settings
        self.client = client
        self.endpoint = str(settings.llm_base_url).rstrip("/") + "/chat/completions"
        self.headers = {}
        if settings.llm_api_key:
            self.headers["Authorization"] = f"Bearer {settings.llm_api_key.get_secret_value()}"
        self.tracing = (
            Langfuse(
                public_key=settings.langfuse_public_key,
                secret_key=settings.langfuse_secret_key.get_secret_value(),
                base_url=str(settings.langfuse_base_url).rstrip("/"),
            )
            if settings.langfuse_public_key and settings.langfuse_secret_key
            else None
        )

    @contextmanager
    def trace(self, stage: str, session_id: str):
        if self.tracing is None:
            yield
            return
        with self.tracing.start_as_current_observation(name=stage) as span:
            with propagate_attributes(session_id=session_id):
                try:
                    yield
                except ModelError:
                    span.update(level="ERROR", status_message="LLM stage failed")
                    raise

    def close(self):
        if self.tracing is not None:
            self.tracing.flush()

    def ask(self, stage: str, instructions: str, data: dict, validate: Callable[[object], T]) -> T:
        messages = [
            {"role": "system", "content": instructions},
            {"role": "user", "content": json.dumps(data, ensure_ascii=False)},
        ]
        payload = {"model": self.settings.llm_model, "messages": messages}
        if self.settings.llm_json_mode:
            payload["response_format"] = {"type": "json_object"}
        if self.settings.llm_temperature is not None:
            payload["temperature"] = self.settings.llm_temperature

        correction = None
        for attempt in range(self.settings.llm_attempts):
            if correction:
                payload["messages"] = [
                    *messages,
                    {"role": "system", "content": f"Исправь нарушение формата: {correction}"},
                ]
            observation = (
                self.tracing.start_as_current_observation(
                    name=stage,
                    as_type="generation",
                    model=self.settings.llm_model,
                    metadata={"attempt": attempt + 1},
                    input=payload["messages"] if self.settings.langfuse_capture_content else None,
                )
                if self.tracing is not None
                else nullcontext()
            )
            with observation as generation:
                retryable = True
                try:
                    response = self.client.post(self.endpoint, headers=self.headers, json=payload)
                    response.raise_for_status()
                    body = response.json()
                    text = body["choices"][0]["message"]["content"]
                    if not isinstance(text, str):
                        raise ValueError("Ожидался текстовый JSON-ответ.")
                    if generation is not None:
                        usage = body.get("usage") or {}
                        generation.update(
                            output=text if self.settings.langfuse_capture_content else None,
                            usage_details={
                                target: usage[source]
                                for source, target in (
                                    ("prompt_tokens", "input"),
                                    ("completion_tokens", "output"),
                                    ("total_tokens", "total"),
                                )
                                if isinstance(usage.get(source), int)
                            },
                        )
                    fenced = re.fullmatch(r"```(?:json)?\s*(.*?)\s*```", text.strip(), re.S | re.I)
                    return validate(json.loads(fenced[1] if fenced else text))
                except httpx.HTTPStatusError as error:
                    status = error.response.status_code
                    reason = f"provider_http_{status}"
                    retryable = status in (408, 429) or status >= 500
                except httpx.RequestError:
                    reason = "provider_connection_error"
                except (ValueError, TypeError, AttributeError, KeyError, IndexError):
                    reason = "invalid_model_output"
                    correction = "Верни валидный JSON по указанной схеме и соблюдай все ограничения и количества."

                if generation is not None:
                    generation.update(level="ERROR", status_message=reason)
            if not retryable:
                break
            if reason != "invalid_model_output" and attempt + 1 < self.settings.llm_attempts:
                sleep(min(2 ** attempt, 8))

        raise ModelError(f"LLM failed at {stage}")
