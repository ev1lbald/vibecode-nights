from io import BytesIO
import json
from threading import Event, Thread
from uuid import uuid4

from docx import Document
from fastapi.testclient import TestClient
import httpx
import pytest
from pptx import Presentation
from pypdf import PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject

from pitch_api.api import create_app
from pitch_api.config import RuntimeSettings
from pitch_api.workflow import _assessment


class Provider:
    def __init__(self):
        self.calls = []
        self.fail_next = None
        self.invalid_next = None
        self.pause = None

    def __call__(self, request):
        assert request.url.path == "/v1/chat/completions"
        payload = json.loads(request.content)
        assert payload["model"] == "test-model"
        assert request.headers.get("Authorization") == "Bearer test-key"
        data = json.loads(payload["messages"][1]["content"])
        category = data.get("category", {}).get("id")
        if "candidates" in data:
            stage = "select_advice" if "assessment" in data else "select_questions"
            output = {"ids": [item["id"] for item in data["candidates"][-data["count"]:]]}
        elif "criteria" in data:
            stage = "assessment"
            output = {"criteria": [
                {"id": item["id"], "score": (index or None), "rationale": "Обоснование"}
                for index, item in enumerate(data["criteria"])
            ]}
        elif "max_days" in data:
            stage = "category_advice"
            output = {"advice": [
                {"action": f"{category} действие {index}", "expected_result": "Артефакт", "estimated_days": 2}
                for index in range(data["count"])
            ]}
        elif "count" in data:
            stage = "category_questions" if category else "general_questions"
            output = {"questions": [f"{category} вопрос {index}?" for index in range(data["count"])]}
        else:
            stage = "inspect"
            output = {"summary": "Описание проекта"}

        self.calls.append((stage, data))
        if self.pause is not None and stage == "inspect":
            entered, release = self.pause
            entered.set()
            assert release.wait(10)
        if self.fail_next == (stage, category):
            self.fail_next = None
            return httpx.Response(400)
        if self.invalid_next == stage:
            self.invalid_next = None
            output = {"ids": ["unexpected-id"]}
        return httpx.Response(200, json={
            "choices": [{"message": {"content": json.dumps(output, ensure_ascii=False)}}],
            "usage": {"prompt_tokens": 20, "completion_tokens": 10},
        })


def runtime(tmp_path, **overrides):
    return RuntimeSettings(
        _env_file=None,
        llm_base_url="http://model.test/v1",
        llm_model="test-model",
        llm_api_key="test-key",
        session_db=tmp_path / "sessions.sqlite3",
        **overrides,
    )


def app_client(settings, provider, **kwargs):
    return TestClient(create_app(settings, httpx.MockTransport(provider)), **kwargs)


def files():
    pdf = PdfWriter()
    page = pdf.add_blank_page(width=200, height=200)
    font = DictionaryObject({
        NameObject("/Type"): NameObject("/Font"),
        NameObject("/Subtype"): NameObject("/Type1"),
        NameObject("/BaseFont"): NameObject("/Helvetica"),
    })
    page[NameObject("/Resources")] = DictionaryObject({
        NameObject("/Font"): DictionaryObject({NameObject("/F1"): font})
    })
    stream = DecodedStreamObject()
    stream.set_data(b"BT /F1 12 Tf 20 100 Td (PDF text) Tj ET")
    page[NameObject("/Contents")] = stream
    pdf_file = BytesIO()
    pdf.write(pdf_file)

    deck = Presentation()
    slide = deck.slides.add_slide(deck.slide_layouts[0])
    slide.shapes.title.text = "PPTX title"
    slides_file = BytesIO()
    deck.save(slides_file)

    doc = Document()
    doc.add_paragraph("DOCX paragraph")
    doc.add_table(rows=1, cols=1).cell(0, 0).text = "DOCX cell"
    doc_file = BytesIO()
    doc.save(doc_file)

    return [
        ("files", ("idea.md", b"# Markdown")),
        ("files", ("metrics.txt", "Текст из TXT".encode("utf-16"))),
        ("files", ("plan.pdf", pdf_file.getvalue())),
        ("files", ("slides.PPTX", slides_file.getvalue())),
        ("files", ("notes.docx", doc_file.getvalue())),
    ]


def answers_for(session):
    return {"answers": [
        {"question_id": item["id"], "answer": f"Ответ на {item['id']}"}
        for item in session["questions"]
    ]}


def test_session_restart_and_idempotent_submissions(tmp_path):
    settings = runtime(tmp_path, api_bearer_token="site-token")
    provider = Provider()
    provider.invalid_next = "select_questions"
    url = f"/api/v1/sessions/{uuid4()}"
    headers = {"Authorization": "Bearer site-token"}
    data = {"persona": "corporation", "pitch": "Первый питч"}
    attachments = files()

    with app_client(settings, provider) as client:
        assert client.get("/api/v1/config").status_code == 401
        config = client.get("/api/v1/config", headers=headers).json()
        assert len(config["personas"]) == 4
        assert len(config["categories"]) == 7
        assert len(config["criteria"]) == 10
        assert client.get(url, headers=headers).status_code == 404
        response = client.put(url, data=data, files=attachments, headers=headers)
        assert response.status_code == 200, response.text
        initial = response.json()
        assert initial["status"] == "awaiting_answers"
        assert len(initial["questions"]) == 5
        assert initial["assessment"] is None and initial["advice"] == []
        assert all(item["category_id"] == "broken_link" for item in initial["questions"])

    selections = [data for stage, data in provider.calls if stage == "select_questions"]
    assert len(selections) == 2
    assert len(selections[-1]["candidates"]) == 75
    assert len([item for item in selections[-1]["candidates"] if item["category_id"] is None]) == 5
    source_text = "\n".join(item["text"] for item in selections[-1]["sources"])
    for expected in ("Первый питч", "# Markdown", "Текст из TXT", "PDF text", "PPTX title", "DOCX cell"):
        assert expected in source_text
    assert selections[-1]["persona"]["id"] == "corporation"

    with app_client(settings, provider, headers=headers) as client:
        assert client.get(url).json() == initial
        assert client.put(f"{url}/answers", json={"answers": answers_for(initial)["answers"][:1]}).status_code == 422
        submitted = answers_for(initial)
        response = client.put(f"{url}/answers", json=submitted)
        assert response.status_code == 200, response.text
        final = response.json()
        assert final["status"] == "completed"
        assert final["questions"] == initial["questions"]
        assert final["assessment"]["score"] == pytest.approx(4.44)
        assert final["assessment"]["criteria"][0]["score"] == 2
        assert len(final["advice"]) == 3
        assert all(item["estimated_days"] == 2 for item in final["advice"])
        assert client.get(url).json() == final

        call_count = len(provider.calls)
        assert client.put(url, data=data, files=attachments).json() == final
        submitted["answers"].reverse()
        assert client.put(f"{url}/answers", json=submitted).json() == final
        submitted["answers"][0]["answer"] = "Другое содержание"
        assert client.put(f"{url}/answers", json=submitted).status_code == 409
        assert client.put(url, data={**data, "pitch": "Другой питч"}, files=attachments).status_code == 409
        assert len(provider.calls) == call_count

    workers = [data for stage, data in provider.calls if stage == "category_advice"]
    assert len(workers) == 7
    assert all(
        len(item["questions_and_answers"]) == 5 and item["assessment"]["score"] == pytest.approx(4.44)
        for item in workers
    )
    chief, = [data for stage, data in provider.calls if stage == "select_advice"]
    assert len(chief["candidates"]) == 21
    assert len(chief["question_candidates"]) == 75


def test_resume_from_failed_parallel_steps(tmp_path):
    settings = runtime(tmp_path, llm_attempts=1)
    provider = Provider()
    provider.fail_next = ("category_questions", "copycat")
    url = f"/api/v1/sessions/{uuid4()}"
    data = {"persona": "business_angel", "pitch": "Питч"}

    with app_client(settings, provider) as client:
        response = client.put(url, data=data)
        assert response.status_code == 502, response.text
        assert client.get(url).json()["status"] == "generating_questions"

    with app_client(settings, provider) as client:
        initial = client.put(url, data=data).json()
        assert initial["status"] == "awaiting_answers"
        provider.fail_next = ("category_advice", "copycat")
        submitted = answers_for(initial)
        response = client.put(f"{url}/answers", json=submitted)
        assert response.status_code == 502, response.text
        assert client.get(url).json()["status"] == "analyzing"

    with app_client(settings, provider) as client:
        different = answers_for(initial)
        different["answers"][0]["answer"] = "Другой ответ"
        assert client.put(f"{url}/answers", json=different).status_code == 409
        response = client.put(f"{url}/answers", json=submitted)
        assert response.status_code == 200, response.text
        assert response.json()["status"] == "completed"
    assert [stage for stage, _ in provider.calls].count("inspect") == 1
    assert [stage for stage, _ in provider.calls].count("assessment") == 1


def test_upload_validation(tmp_path):
    provider = Provider()
    url = f"/api/v1/sessions/{uuid4()}"
    data = {"persona": "grant_fund"}

    with app_client(runtime(tmp_path), provider) as client:
        assert client.put(url, data=data).json()["detail"]["code"] == "missing_materials"
        response = client.put(url, data=data, files=[("files", ("unsupported.png", b"data"))])
        assert response.status_code == 415
        response = client.put(url, data=data, files=[("files", ("broken.pptx", b"data"))])
        assert response.status_code == 422
        response = client.put(url, data=data, files=[("files", ("empty.md", b" "))])
        assert response.json()["detail"]["code"] == "empty_file"
        assert client.get(url).status_code == 404
        assert not provider.calls
        response = client.put(url, data=data, files=[("files", ("good.txt", b"Standalone file"))])
        assert response.status_code == 200
        assert response.json()["status"] == "awaiting_answers"


def test_conflicting_writes(tmp_path):
    settings = runtime(tmp_path)
    provider = Provider()
    entered, release = Event(), Event()
    provider.pause = (entered, release)
    url = f"/api/v1/sessions/{uuid4()}"
    data = {"persona": "venture_fund", "pitch": "Питч"}

    with app_client(settings, provider) as client:
        responses = []
        writer = Thread(target=lambda: responses.append(client.put(url, data=data)))
        writer.start()
        try:
            assert entered.wait(10)
            assert client.get(url).json()["status"] == "generating_questions"
            response = client.put(url, data=data)
            assert response.status_code == 409
            assert response.json()["detail"]["code"] == "session_busy"
        finally:
            release.set()
            writer.join(10)
        assert responses[0].json()["status"] == "awaiting_answers"


def test_counts_are_configurable_and_saved_per_session(tmp_path):
    provider = Provider()
    defaults = runtime(tmp_path).pitch_config.read_text(encoding="utf-8")
    policy_path = tmp_path / "policy.toml"
    customized = (
        defaults.replace("\nquestion_count = 5", "\nquestion_count = 2")
        .replace("\nquestions_per_category = 10", "\nquestions_per_category = 2")
        .replace("\nadvice_count = 3", "\nadvice_count = 2")
        .replace("\nadvice_per_category = 3", "\nadvice_per_category = 1")
    )
    policy_path.write_text(customized, encoding="utf-8")
    url = f"/api/v1/sessions/{uuid4()}"
    with app_client(runtime(tmp_path, pitch_config=policy_path), provider) as client:
        config = client.get("/api/v1/config").json()
        assert config["question_count"] == config["advice_count"] == 2
        response = client.put(url, data={"persona": "venture_fund", "pitch": "Питч"})
        assert response.status_code == 200, response.text
        session = response.json()
        assert len(session["questions"]) == 2
    selection, = [data for stage, data in provider.calls if stage == "select_questions"]
    assert len(selection["candidates"]) == 19

    with app_client(runtime(tmp_path), provider) as client:
        assert client.get("/api/v1/config").json()["advice_count"] == 3
        response = client.put(f"{url}/answers", json=answers_for(session))
        assert response.status_code == 200, response.text
        assert len(response.json()["advice"]) == 2
    chief, = [data for stage, data in provider.calls if stage == "select_advice"]
    assert len(chief["candidates"]) == 7


def test_assessment_weights_by_persona_and_missing_scores(tmp_path):
    policy = runtime(tmp_path).load_policy()
    raw = {"criteria": [
        {"id": criterion.id, "score": index or None, "rationale": "Пояснение"}
        for index, criterion in enumerate(policy.criteria)
    ]}
    expected_scores = {
        "business_angel": 4.52,
        "corporation": 4.44,
        "grant_fund": 4.83,
        "venture_fund": 4.60,
    }
    for role, expected in expected_scores.items():
        weights = policy.assessment_weights[role]
        assert sum(weights.values()) == pytest.approx(10)
        assert _assessment(raw, policy, weights)["score"] == pytest.approx(expected)

    for criterion in raw["criteria"]:
        criterion["score"] = None
    result = _assessment(raw, policy, policy.assessment_weights["grant_fund"])
    assert result["score"] == pytest.approx(2)
    assert all(item["score"] == 2 for item in result["criteria"])

    # Explicit evidence-based zeroes remain zero; uncertainty is not failure.
    for criterion in raw["criteria"]:
        criterion["score"] = 0
    assert _assessment(raw, policy, policy.assessment_weights["grant_fund"])["score"] == 0

    legacy = type(policy).model_validate(policy.model_dump(exclude={"assessment_weights"}))
    assert legacy.assessment_weights == policy.assessment_weights
