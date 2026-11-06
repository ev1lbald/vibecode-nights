from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from .config import Label, NonEmpty


class Output(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, allow_inf_nan=False)


class Question(Output):
    id: str
    text: NonEmpty
    category_id: str | None


class Answer(Output):
    question_id: NonEmpty
    answer: NonEmpty


class Answers(Output):
    answers: list[Answer] = Field(min_length=1)


class CriterionScore(Output):
    id: str
    score: float | None
    rationale: NonEmpty


class LabeledScore(CriterionScore):
    label: str


class Assessment(Output):
    score: float | None
    score_min: float
    score_max: float
    criteria: list[LabeledScore]


class ProposedAdvice(Output):
    action: NonEmpty
    expected_result: NonEmpty
    estimated_days: int = Field(ge=1)


class Advice(ProposedAdvice):
    category_id: str


class Session(BaseModel):
    id: UUID
    persona: str
    status: Literal["generating_questions", "awaiting_answers", "analyzing", "completed"]
    questions: list[Question]
    assessment: Assessment | None
    advice: list[Advice]


class PublicConfig(BaseModel):
    personas: list[Label]
    categories: list[Label]
    criteria: list[Label]
    question_count: int
    advice_count: int
    max_advice_days: int
    score_min: float
    score_max: float
    file_extensions: list[str]
    max_files: int
    max_file_bytes: int
    max_input_chars: int
    max_answer_chars: int
