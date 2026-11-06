import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { zipSync, strToU8 } from "fflate";
import { createApp } from "../server/app";
import { extractFile } from "../server/files";
import type { Session } from "../shared/types";

test("complete session lifecycle, idempotency, ownership and durable storage", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "vibe-test-"));
  const { app, db } = createApp(dir);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  let cookie = "";
  const req = async (p: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (cookie) headers.set("cookie", cookie);
    const r = await fetch(base + p, { ...init, headers });
    const set = r.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    return r;
  };
  const form = (
    pitch = "Проект помогает небольшим кафе планировать смены. Есть прототип и два пилота.",
  ) => {
    const f = new FormData();
    f.set("title", "Смена");
    f.set("persona", "business_angel");
    f.set("pitch", pitch);
    return f;
  };
  try {
    let res = await req("/api/v1/config");
    assert.equal(res.status, 200);
    assert.equal((await res.json()).question_count, 5);
    const id = randomUUID();
    res = await req(`/api/v1/sessions/${id}`, { method: "PUT", body: form() });
    assert.equal(res.status, 200);
    const session: Session = await res.json();
    assert.equal(session.questions.length, 5);
    assert.equal(session.status, "awaiting_answers");
    res = await req(`/api/v1/sessions/${id}`, { method: "PUT", body: form() });
    assert.equal(res.status, 200);
    res = await req(`/api/v1/sessions/${id}`, {
      method: "PUT",
      body: form("Другой проект"),
    });
    assert.equal(res.status, 409);
    res = await fetch(base + `/api/v1/sessions/${id}`);
    assert.equal(res.status, 404);
    const json = (data: unknown) => ({
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(data),
    });
    res = await req(
      `/api/v1/sessions/${id}/answers`,
      json({ answers: [{ question_id: "q-1", answer: "Ответ" }] }),
    );
    assert.equal(res.status, 422);
    res = await req(
      `/api/v1/sessions/${id}/answers`,
      json({
        answers: session.questions.map(() => ({
          question_id: "q-1",
          answer: "Ответ",
        })),
      }),
    );
    assert.equal(res.status, 422);
    const answers = session.questions.map((q) => ({
      question_id: q.id,
      answer: "Пока не знаю",
    }));
    res = await req(`/api/v1/sessions/${id}/answers`, json({ answers }));
    assert.equal(res.status, 200);
    const completed: Session = await res.json();
    assert.equal(completed.status, "completed");
    assert.equal(completed.advice.length, 3);
    assert.equal(completed.assessment?.criteria.length, 10);
    assert.equal(completed.assessment?.score, null);
    assert(completed.assessment?.criteria.every((c) => c.score === null));
    res = await req(`/api/v1/sessions/${id}/answers`, json({ answers }));
    assert.equal(res.status, 200);
    res = await req(
      `/api/v1/sessions/${id}/answers`,
      json({ answers: answers.map((a) => ({ ...a, answer: "Другой ответ" })) }),
    );
    assert.equal(res.status, 409);
    res = await req("/api/app/history");
    assert.equal((await res.json()).length, 1);
    const ownerDb = createApp(dir);
    const owner = await import("node:crypto");
    const token = cookie.split("=")[1];
    const stored = ownerDb.db.get(
      id,
      owner.createHash("sha256").update(token).digest("hex"),
    );
    assert.equal(stored?.session.status, "completed");
    ownerDb.db.close();
    res = await req(`/api/v1/sessions/${randomUUID()}`, {
      method: "PUT",
      body: form("   "),
    });
    assert.equal(res.status, 422);
    const invalid = form();
    invalid.append("files", new Blob(["hello"]), "script.html");
    res = await req(`/api/v1/sessions/${randomUUID()}`, {
      method: "PUT",
      body: invalid,
    });
    assert.equal(res.status, 415);
    const fileOnly = form("");
    fileOnly.append(
      "files",
      new Blob(["Описание проекта: сервис для кафе"]),
      "pitch.txt",
    );
    res = await req(`/api/v1/sessions/${randomUUID()}`, {
      method: "PUT",
      body: fileOnly,
    });
    assert.equal(res.status, 200);
    const cross = form();
    res = await req(`/api/v1/sessions/${randomUUID()}`, {
      method: "PUT",
      headers: { origin: "https://other.invalid" },
      body: cross,
    });
    assert.equal(res.status, 403);
    res = await req(`/api/app/sessions/${id}`, { method: "DELETE" });
    assert.equal(res.status, 204);
    res = await req(`/api/v1/sessions/${id}`);
    assert.equal(res.status, 404);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("document text extraction, slide order and corrupt archive handling", async () => {
  const file = (name: string, buffer: Uint8Array) =>
    ({
      originalname: name,
      buffer: Buffer.from(buffer),
    }) as Express.Multer.File;
  const archive = zipSync({
    "ppt/slides/slide2.xml": strToU8("<p:sld><a:t>Второй слайд</a:t></p:sld>"),
    "ppt/slides/slide1.xml": strToU8("<p:sld><a:t>Первый слайд</a:t></p:sld>"),
  });
  const text = await extractFile(file("pitch.pptx", archive));
  assert(text.includes("Первый слайд"));
  assert(text.indexOf("Первый") < text.indexOf("Второй"));
  await assert.rejects(() =>
    extractFile(file("broken.pdf", strToU8("not a PDF"))),
  );
  await assert.rejects(() =>
    extractFile(file("broken.docx", strToU8("not a zip"))),
  );
});
