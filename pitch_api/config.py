from pathlib import Path
import tomllib
from typing import Annotated

from pydantic import AnyHttpUrl, BaseModel, ConfigDict, Field, SecretStr, StringConstraints
from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


NonEmpty = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]
ConfigId = Annotated[str, StringConstraints(pattern=r"^[a-z][a-z0-9_]*$")]
PositiveInt = Annotated[int, Field(gt=0)]


class ConfigModel(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class Label(ConfigModel):
    id: ConfigId
    label: NonEmpty


class Role(Label):
    guidance: NonEmpty


class Prompts(ConfigModel):
    shared: NonEmpty
    inspect: NonEmpty
    general_questions: NonEmpty
    category_questions: NonEmpty
    select_questions: NonEmpty
    assessment: NonEmpty
    category_advice: NonEmpty
    select_advice: NonEmpty


class Policy(ConfigModel):
    general_question_count: PositiveInt
    questions_per_category: PositiveInt
    question_count: PositiveInt
    advice_per_category: PositiveInt
    advice_count: PositiveInt
    max_advice_days: PositiveInt
    score_min: float
    score_max: float
    output_language: NonEmpty
    max_files: PositiveInt
    max_file_bytes: PositiveInt
    max_office_uncompressed_bytes: PositiveInt
    max_input_chars: PositiveInt
    max_answer_chars: PositiveInt
    prompts: Prompts
    personas: Annotated[list[Role], Field(min_length=1)]
    categories: Annotated[list[Role], Field(min_length=1)]
    criteria: Annotated[list[Label], Field(min_length=1)]

    @model_validator(mode="after")
    def validate_counts_and_ids(self):
        for group in (self.personas, self.categories, self.criteria):
            if len({entry.id for entry in group}) != len(group):
                raise ValueError("IDs must be unique within each configuration group")
        if self.score_min >= self.score_max:
            raise ValueError("score_min must be less than score_max")
        if self.question_count > self.general_question_count + len(self.categories) * self.questions_per_category:
            raise ValueError("question_count exceeds the number of candidates")
        if self.advice_count > len(self.categories) * self.advice_per_category:
            raise ValueError("advice_count exceeds the number of candidates")
        return self


class RuntimeSettings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    llm_base_url: AnyHttpUrl
    llm_model: NonEmpty
    llm_api_key: SecretStr | None = None
    llm_timeout_seconds: Annotated[float, Field(gt=0)] = 90
    llm_attempts: PositiveInt = 3
    llm_json_mode: bool = False
    llm_temperature: Annotated[float, Field(ge=0, le=2)] | None = None
    graph_max_concurrency: PositiveInt = 4
    session_db: Path = Path("data/pitch.sqlite3")
    api_bearer_token: SecretStr | None = None
    pitch_config: Path = Path(__file__).with_name("defaults.toml")
    langfuse_public_key: NonEmpty | None = None
    langfuse_secret_key: SecretStr | None = None
    langfuse_base_url: AnyHttpUrl = "https://cloud.langfuse.com"
    langfuse_capture_content: bool = False

    @model_validator(mode="after")
    def validate_tracing_credentials(self):
        if bool(self.langfuse_public_key) != bool(self.langfuse_secret_key):
            raise ValueError("Set both Langfuse keys to enable tracing")
        return self

    def load_policy(self) -> Policy:
        with self.pitch_config.open("rb") as file:
            return Policy.model_validate(tomllib.load(file))
