import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createApp } from "../server/app";
import { stubConfig } from "../shared/catalog";
import { stubQuestions, stubAssessment } from "../server/agents";
import type { Session } from "../shared/types";

test("live proxy: async stages, authenticated upstream, persisted uploads, retry and private sessions", async () => {
  const states = new Map<string, any>();
  let starts = 0;
  const upstream = createServer(async (req, res) => {
    try {
      assert.equal(req.headers.authorization, "Bearer test-service-token");
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/v1/config") {
        res.end(JSON.stringify({ ...stubConfig, max_answer_chars: 4000 }));
        return;
      }
      const parts = req.url!.split("/");
      const id = parts[4];
      if (req.method === "GET") {
        if (!states.has(id)) {
          res.statusCode = 404;
          res.end("{}");
        } else res.end(JSON.stringify(states.get(id)));
        return;
      }
      let body = "";
      for await (const chunk of req) body += chunk;
      await sleep(100);
      if (parts[5] === "answers") {
        const state = states.get(id);
        const answers = JSON.parse(body).answers;
        const result = {
          ...state,
          ...stubAssessment({ ...state, deadline: "Завтра" }, answers),
          status: "completed",
        };
        result.assessment.score = 6.2;
        states.set(id, result);
        res.end(JSON.stringify(result));
        return;
      }
      starts++;
      assert(body.includes("material.txt"));
      assert(body.includes("Persistent upload text"));
      if (starts === 1) {
        res.statusCode = 502;
        res.end(
          JSON.stringify({
            detail: { code: "model_error", message: "Повторите этап." },
          }),
        );
        return;
      }
      const state = {
        id,
        persona: "business_angel",
        status: "awaiting_answers",
        questions: stubQuestions({ persona: "business_angel", title: "Тест" }),
        assessment: null,
        advice: [],
      };
      states.set(id, state);
      res.end(JSON.stringify(state));
    } catch (e) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: String(e) }));
    }
  }).listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const upstreamAddress = upstream.address();
  assert(upstreamAddress && typeof upstreamAddress !== "string");
  process.env.AGENT_API_URL = `http://127.0.0.1:${upstreamAddress.port}`;
  process.env.AGENT_API_TOKEN = "test-service-token";
  const dir = mkdtempSync(path.join(tmpdir(), "vibe-live-test-"));
  const { app, db } = createApp(dir);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  let cookie = "";
  async function call(p: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    if (cookie) headers.set("cookie", cookie);
    const r = await fetch(base + p, { ...init, headers });
    const c = r.headers.get("set-cookie");
    if (c) cookie = c.split(";")[0];
    return r;
  }
  async function until(id: string, predicate: (s: Session) => boolean) {
    for (let attempt = 0; attempt < 60; attempt++) {
      const r = await call("/api/v1/sessions/" + id);
      const s = (await r.json()) as Session;
      if (predicate(s)) return s;
      await sleep(30);
    }
    throw new Error("Stage did not settle");
  }
  try {
    const config = await (await call("/api/v1/config")).json();
    assert.equal(config.mode, "live");
    assert.equal(config.max_answer_chars, 4000);
    const id = crypto.randomUUID(),
      form = new FormData();
    form.set("title", "Тест");
    form.set("persona", "business_angel");
    form.append("files", new Blob(["Persistent upload text"]), "material.txt");
    let r = await call("/api/v1/sessions/" + id, { method: "PUT", body: form });
    assert.equal(r.status, 202);
    assert.equal((await r.json()).status, "generating_questions");
    r = await fetch(base + "/api/v1/sessions/" + id);
    assert.equal(r.status, 404);
    const failed = await until(id, (s) => !!s.stage_error);
    assert.equal(failed.stage_error, "Повторите этап.");
    assert(existsSync(path.join(dir, "pending", id, "0")));
    r = await call("/api/app/sessions/" + id + "/retry", { method: "POST" });
    assert.equal(r.status, 202);
    const ready = await until(id, (s) => s.status === "awaiting_answers");
    assert.equal(ready.questions.length, 5);
    assert.equal(ready.max_answer_chars, 4000);
    assert(!existsSync(path.join(dir, "pending", id)));
    const answers = ready.questions.map((q) => ({
      question_id: q.id,
      answer: "Пока не знаю",
    }));
    r = await call("/api/v1/sessions/" + id + "/answers", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answers }),
    });
    assert.equal(r.status, 202);
    const completed = await until(id, (s) => s.status === "completed");
    assert.equal(completed.answers.length, 5);
    assert.equal(completed.advice.length, 3);
    assert.equal(completed.assessment?.score, 6.2);
    assert(!completed.stage_error);
    r = await call("/api/v1/sessions/" + id + "/answers", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answers }),
    });
    assert.equal(r.status, 200);
    assert.equal(starts, 2);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    upstream.closeAllConnections();
    await new Promise<void>((r) => upstream.close(() => r()));
    db.close();
    rmSync(dir, { recursive: true, force: true });
    delete process.env.AGENT_API_URL;
    delete process.env.AGENT_API_TOKEN;
  }
});
