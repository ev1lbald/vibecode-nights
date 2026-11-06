from contextlib import asynccontextmanager
import secrets
from typing import Annotated
from uuid import UUID

import httpx
from fastapi import Depends, FastAPI, File, Form, Request, UploadFile
from fastapi.responses import JSONResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from langgraph.checkpoint.sqlite import SqliteSaver

from .config import Label, RuntimeSettings
from .documents import FILE_EXTENSIONS, InputError
from .llm import ChatModel, ModelError
from .models import Answers, PublicConfig, Session
from .sessions import Sessions
from .workflow import build_graph


bearer = HTTPBearer(auto_error=False)


def authorize(
    request: Request,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer)],
):
    token = request.app.state.settings.api_bearer_token
    if token is not None and (
        credentials is None
        or not secrets.compare_digest(credentials.credentials.encode(), token.get_secret_value().encode())
    ):
        raise InputError(401, "unauthorized", "Требуется действительный сервисный токен.")


def sessions(request: Request) -> Sessions:
    return request.app.state.sessions


def create_app(settings: RuntimeSettings | None = None, transport: httpx.BaseTransport | None = None) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        runtime = settings or RuntimeSettings()
        policy = runtime.load_policy()
        runtime.session_db.parent.mkdir(parents=True, exist_ok=True)
        with (
            httpx.Client(timeout=runtime.llm_timeout_seconds, transport=transport) as client,
            SqliteSaver.from_conn_string(str(runtime.session_db)) as checkpointer,
        ):
            model = ChatModel(runtime, client)
            app.state.settings = runtime
            app.state.sessions = Sessions(build_graph(model, checkpointer), model, policy, runtime.session_db)
            try:
                yield
            finally:
                model.close()

    app = FastAPI(title="Vibecode Nights Pitch API", version="1.0.0", lifespan=lifespan)
    auth = [Depends(authorize)]

    @app.exception_handler(InputError)
    async def input_error(_request: Request, error: InputError):
        return JSONResponse(
            status_code=error.status,
            content={"detail": {"code": error.code, "message": str(error)}},
            headers={"WWW-Authenticate": "Bearer"} if error.status == 401 else None,
        )

    @app.exception_handler(ModelError)
    async def model_error(_request: Request, _error: ModelError):
        return JSONResponse(
            status_code=502,
            content={"detail": {
                "code": "model_error",
                "message": "Провайдер LLM не завершил этап. Повторите запрос с теми же данными.",
            }},
        )

    @app.get("/healthz")
    def health():
        return {"status": "ok"}

    @app.get("/api/v1/config", dependencies=auth)
    def public_config(service: Annotated[Sessions, Depends(sessions)]) -> PublicConfig:
        policy = service.policy
        return PublicConfig(
            personas=[Label(id=item.id, label=item.label) for item in policy.personas],
            categories=[Label(id=item.id, label=item.label) for item in policy.categories],
            criteria=policy.criteria,
            question_count=policy.question_count,
            advice_count=policy.advice_count,
            max_advice_days=policy.max_advice_days,
            score_min=policy.score_min,
            score_max=policy.score_max,
            file_extensions=list(FILE_EXTENSIONS),
            max_files=policy.max_files,
            max_file_bytes=policy.max_file_bytes,
            max_input_chars=policy.max_input_chars,
            max_answer_chars=policy.max_answer_chars,
        )

    @app.put("/api/v1/sessions/{session_id}", dependencies=auth)
    def start_session(
        session_id: UUID,
        service: Annotated[Sessions, Depends(sessions)],
        persona: Annotated[str, Form()],
        pitch: Annotated[str, Form()] = "",
        files: Annotated[list[UploadFile] | None, File()] = None,
    ) -> Session:
        return service.start(str(session_id), persona, pitch, files or [])

    @app.get("/api/v1/sessions/{session_id}", dependencies=auth)
    def get_session(session_id: UUID, service: Annotated[Sessions, Depends(sessions)]) -> Session:
        return service.get(str(session_id))

    @app.put("/api/v1/sessions/{session_id}/answers", dependencies=auth)
    def submit_answers(
        session_id: UUID,
        answers: Answers,
        service: Annotated[Sessions, Depends(sessions)],
    ) -> Session:
        return service.submit(str(session_id), answers)

    return app


app = create_app()
