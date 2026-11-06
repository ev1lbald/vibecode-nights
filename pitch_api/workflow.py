import json
from operator import or_
from statistics import mean
from typing import Annotated

from langgraph.graph import END, START, StateGraph
from langgraph.types import Send, interrupt
from typing_extensions import TypedDict

from .config import NonEmpty, Policy
from .documents import Source
from .llm import ChatModel
from .models import Advice, Assessment, CriterionScore, LabeledScore, Output, ProposedAdvice, Question


class State(TypedDict, total=False):
    persona: str
    policy: dict
    input_digest: str
    sources: list[Source]
    summary: str
    general_questions: list[dict]
    category_questions: Annotated[dict[str, list[dict]], or_]
    questions: list[dict]
    answers: dict[str, str]
    assessment: dict
    category_advice: Annotated[dict[str, list[dict]], or_]
    advice: list[dict]


class CategoryState(TypedDict):
    policy: dict
    context: dict
    category: dict


class Summary(Output):
    summary: NonEmpty


class Questions(Output):
    questions: list[NonEmpty]


class Selection(Output):
    ids: list[str]


class Scores(Output):
    criteria: list[CriterionScore]


class Suggestions(Output):
    advice: list[ProposedAdvice]


def _require_distinct(values: list[str], count: int):
    if len(values) != count or len(set(values)) != count:
        raise ValueError("Wrong count or repeated entries")


def _question_batch(raw, count: int, category_id: str | None) -> list[dict]:
    texts = Questions.model_validate(raw).questions
    _require_distinct([" ".join(text.casefold().split()) for text in texts], count)
    return [
        Question(
            id=f"general-{index}" if category_id is None else f"category-{category_id}-{index}",
            text=text,
            category_id=category_id,
        ).model_dump()
        for index, text in enumerate(texts, 1)
    ]


def _select(raw, candidates: list[dict], count: int, text_field: str) -> list[dict]:
    ids = Selection.model_validate(raw).ids
    _require_distinct(ids, count)
    by_id = {item["id"]: item for item in candidates}
    selected = [by_id[item_id] for item_id in ids]
    _require_distinct([" ".join(item[text_field].casefold().split()) for item in selected], count)
    return selected


def _assessment(raw, policy: Policy) -> dict:
    scores = Scores.model_validate(raw).criteria
    _require_distinct([item.id for item in scores], len(policy.criteria))
    by_id = {item.id: item for item in scores}
    criteria = [
        LabeledScore(**by_id[item.id].model_dump(), label=item.label)
        for item in policy.criteria
    ]
    known = [item.score for item in criteria if item.score is not None]
    if any(not policy.score_min <= score <= policy.score_max for score in known):
        raise ValueError("Score outside configured scale")
    return Assessment(
        score=mean(known) if known else None,
        score_min=policy.score_min,
        score_max=policy.score_max,
        criteria=criteria,
    ).model_dump()


def _advice_batch(raw, policy: Policy, category_id: str) -> list[dict]:
    proposals = Suggestions.model_validate(raw).advice
    _require_distinct([" ".join(item.action.casefold().split()) for item in proposals], policy.advice_per_category)
    if any(item.estimated_days > policy.max_advice_days for item in proposals):
        raise ValueError("Advice exceeds the allowed duration")
    return [
        {"id": f"{category_id}-{index}", **Advice(category_id=category_id, **item.model_dump()).model_dump()}
        for index, item in enumerate(proposals, 1)
    ]


def _project_context(state: State, policy: Policy) -> dict:
    persona = next(role for role in policy.personas if role.id == state["persona"])
    return {
        "persona": persona.model_dump(),
        "sources": state["sources"],
        "summary": state.get("summary"),
    }


def _review_context(state: State, policy: Policy) -> dict:
    return {
        **_project_context(state, policy),
        "questions_and_answers": [
            {**question, "answer": state["answers"][question["id"]]}
            for question in state["questions"]
        ],
        "assessment": state.get("assessment"),
    }


def _question_candidates(state: State, policy: Policy) -> list[dict]:
    return [
        *state["general_questions"],
        *(question for category in policy.categories for question in state["category_questions"][category.id]),
    ]


def _await_answers(state: State) -> dict:
    return {"answers": interrupt({"questions": state["questions"]})}


def build_graph(model: ChatModel, checkpointer):
    def ask(stage: str, policy: Policy, schema: type[Output], context: dict, validate):
        structure = json.dumps(schema.model_json_schema(), ensure_ascii=False)
        instructions = "\n".join((
            policy.prompts.shared,
            getattr(policy.prompts, stage),
            f"Язык текстовых полей: {policy.output_language}.",
            f"Схема ответа: {structure}",
        ))
        return model.ask(stage, instructions, context, validate)

    def inspect(state: State):
        policy = Policy.model_validate(state["policy"])
        result = ask("inspect", policy, Summary, _project_context(state, policy), Summary.model_validate)
        return {"summary": result.summary}

    def general_questions(state: State):
        policy = Policy.model_validate(state["policy"])
        count = policy.general_question_count
        questions = ask(
            "general_questions", policy, Questions, {**_project_context(state, policy), "count": count},
            lambda raw: _question_batch(raw, count, None),
        )
        return {"general_questions": questions}

    def distribute_questions(state: State):
        policy = Policy.model_validate(state["policy"])
        context = _project_context(state, policy)
        return [
            Send("category_questions", {"policy": state["policy"], "context": context, "category": category.model_dump()})
            for category in policy.categories
        ]

    def category_questions(state: CategoryState):
        policy = Policy.model_validate(state["policy"])
        category = state["category"]
        count = policy.questions_per_category
        questions = ask(
            "category_questions", policy, Questions, {**state["context"], "category": category, "count": count},
            lambda raw: _question_batch(raw, count, category["id"]),
        )
        return {"category_questions": {category["id"]: questions}}

    def select_questions(state: State):
        policy = Policy.model_validate(state["policy"])
        candidates = _question_candidates(state, policy)
        selected = ask(
            "select_questions", policy, Selection,
            {**_project_context(state, policy), "count": policy.question_count, "candidates": candidates},
            lambda raw: _select(raw, candidates, policy.question_count, "text"),
        )
        return {"questions": [{**item, "id": f"q-{index}"} for index, item in enumerate(selected, 1)]}

    def assess_project(state: State):
        policy = Policy.model_validate(state["policy"])
        context = {
            **_review_context(state, policy),
            "criteria": [item.model_dump() for item in policy.criteria],
            "score_min": policy.score_min,
            "score_max": policy.score_max,
        }
        assessment = ask("assessment", policy, Scores, context, lambda raw: _assessment(raw, policy))
        return {"assessment": assessment}

    def distribute_advice(state: State):
        policy = Policy.model_validate(state["policy"])
        return [
            Send("category_advice", {
                "policy": state["policy"],
                "context": {
                    **_review_context(state, policy),
                    "category_questions": state["category_questions"][category.id],
                },
                "category": category.model_dump(),
            })
            for category in policy.categories
        ]

    def category_advice(state: CategoryState):
        policy = Policy.model_validate(state["policy"])
        category = state["category"]
        context = {
            **state["context"],
            "category": category,
            "count": policy.advice_per_category,
            "max_days": policy.max_advice_days,
        }
        advice = ask(
            "category_advice", policy, Suggestions, context,
            lambda raw: _advice_batch(raw, policy, category["id"]),
        )
        return {"category_advice": {category["id"]: advice}}

    def select_advice(state: State):
        policy = Policy.model_validate(state["policy"])
        candidates = [item for category in policy.categories for item in state["category_advice"][category.id]]
        selected = ask(
            "select_advice", policy, Selection,
            {
                **_review_context(state, policy),
                "question_candidates": _question_candidates(state, policy),
                "count": policy.advice_count,
                "candidates": candidates,
            },
            lambda raw: _select(raw, candidates, policy.advice_count, "action"),
        )
        return {"advice": [{key: value for key, value in item.items() if key != "id"} for item in selected]}

    graph = StateGraph(State)
    graph.add_node("inspect", inspect)
    graph.add_node("general_questions", general_questions)
    graph.add_node("category_questions", category_questions)
    graph.add_node("select_questions", select_questions)
    graph.add_node("await_answers", _await_answers)
    graph.add_node("assess_project", assess_project)
    graph.add_node("category_advice", category_advice)
    graph.add_node("select_advice", select_advice)
    graph.add_edge(START, "inspect")
    graph.add_edge("inspect", "general_questions")
    graph.add_conditional_edges("general_questions", distribute_questions, ["category_questions"])
    graph.add_edge("category_questions", "select_questions")
    graph.add_edge("select_questions", "await_answers")
    graph.add_edge("await_answers", "assess_project")
    graph.add_conditional_edges("assess_project", distribute_advice, ["category_advice"])
    graph.add_edge("category_advice", "select_advice")
    graph.add_edge("select_advice", END)
    return graph.compile(checkpointer=checkpointer)
