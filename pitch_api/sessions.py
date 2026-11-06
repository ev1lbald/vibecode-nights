from contextlib import closing, contextmanager
import hashlib
import json
from pathlib import Path
import sqlite3
from threading import Lock

from fastapi import UploadFile
from langgraph.types import Command

from .config import Policy
from .documents import InputError, collect_uploads, extract_sources, input_digest
from .llm import ChatModel
from .models import Answers, Session


class Sessions:
    def __init__(self, graph, model: ChatModel, policy: Policy, database: Path):
        self.graph = graph
        self.model = model
        self.policy = policy
        self.database = database
        self.active: set[str] = set()
        self.guard = Lock()
        with closing(sqlite3.connect(database)) as connection, connection:
            connection.execute("""
                CREATE TABLE IF NOT EXISTS submitted_answers (
                    session_id TEXT PRIMARY KEY,
                    digest TEXT NOT NULL
                )
            """)

    def _config(self, session_id: str) -> dict:
        return {
            "configurable": {"thread_id": session_id},
            "max_concurrency": self.model.settings.graph_max_concurrency,
        }

    @contextmanager
    def _writing(self, session_id: str):
        with self.guard:
            if session_id in self.active:
                raise InputError(409, "session_busy", "Сессия уже обрабатывает запрос.")
            self.active.add(session_id)
        try:
            yield
        finally:
            with self.guard:
                self.active.remove(session_id)

    def _run(self, stage: str, session_id: str, data) -> None:
        with self.model.trace(stage, session_id):
            self.graph.invoke(data, self._config(session_id), durability="sync")

    def _snapshot(self, session_id: str):
        return self.graph.get_state(self._config(session_id))

    def _answer_digest(self, session_id: str) -> str | None:
        with closing(sqlite3.connect(self.database)) as connection:
            row = connection.execute(
                "SELECT digest FROM submitted_answers WHERE session_id = ?", (session_id,)
            ).fetchone()
        return row[0] if row else None

    def _accept_answers(self, session_id: str, answers: dict[str, str]) -> None:
        serialized = json.dumps(answers, ensure_ascii=False, sort_keys=True)
        digest = hashlib.sha256(serialized.encode()).hexdigest()
        with closing(sqlite3.connect(self.database)) as connection, connection:
            connection.execute(
                "INSERT OR IGNORE INTO submitted_answers (session_id, digest) VALUES (?, ?)",
                (session_id, digest),
            )
            saved, = connection.execute(
                "SELECT digest FROM submitted_answers WHERE session_id = ?", (session_id,)
            ).fetchone()
        if saved != digest:
            raise InputError(409, "answers_already_submitted", "Для этой сессии уже приняты другие ответы.")

    def get(self, session_id: str) -> Session:
        state = self._snapshot(session_id).values
        if "persona" not in state:
            raise InputError(404, "session_not_found", "Сессия не найдена.")
        if "advice" in state:
            status = "completed"
        elif "answers" in state or ("questions" in state and self._answer_digest(session_id)):
            status = "analyzing"
        elif "questions" in state:
            status = "awaiting_answers"
        else:
            status = "generating_questions"
        return Session(
            id=session_id,
            persona=state["persona"],
            status=status,
            questions=state.get("questions", []),
            assessment=state["assessment"] if status == "completed" else None,
            advice=state.get("advice", []),
        )

    def start(self, session_id: str, persona: str, pitch: str, files: list[UploadFile]) -> Session:
        with self._writing(session_id):
            snapshot = self._snapshot(session_id)
            state = snapshot.values
            exists = "persona" in state
            policy = Policy.model_validate(state["policy"]) if exists else self.policy
            if persona not in {role.id for role in policy.personas}:
                raise InputError(422, "unknown_persona", "Неизвестная роль критика.")

            pitch = pitch.strip()
            uploads = collect_uploads(pitch, files, policy)
            digest = input_digest(persona, pitch, uploads)
            if not exists:
                self._run("generate_questions", session_id, {
                    "persona": persona,
                    "policy": policy.model_dump(),
                    "input_digest": digest,
                    "sources": extract_sources(pitch, uploads, policy),
                })
            elif state["input_digest"] != digest:
                raise InputError(409, "session_already_exists", "Для этой сессии уже приняты другие материалы.")
            elif "answers" not in state and not snapshot.interrupts and not self._answer_digest(session_id):
                self._run("generate_questions", session_id, None)
            return self.get(session_id)

    def submit(self, session_id: str, request: Answers) -> Session:
        with self._writing(session_id):
            snapshot = self._snapshot(session_id)
            state = snapshot.values
            if "persona" not in state:
                raise InputError(404, "session_not_found", "Сессия не найдена.")
            if "questions" not in state:
                raise InputError(409, "questions_not_ready", "Вопросы ещё не готовы.")

            answers = {item.question_id: item.answer for item in request.answers}
            expected = {item["id"] for item in state["questions"]}
            if len(answers) != len(request.answers) or answers.keys() != expected:
                raise InputError(422, "invalid_question_ids", "Ответьте на каждый заданный вопрос ровно один раз.")
            limit = state["policy"]["max_answer_chars"]
            if any(len(text) > limit for text in answers.values()):
                raise InputError(413, "answer_too_long", "Превышен лимит длины ответа.")

            self._accept_answers(session_id, answers)
            if "advice" not in state:
                if "answers" in state:
                    self._run("analyze_project", session_id, None)
                else:
                    if not snapshot.interrupts:
                        self._run("generate_questions", session_id, None)
                    self._run("analyze_project", session_id, Command(resume=answers))
            return self.get(session_id)
