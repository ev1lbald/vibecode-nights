import express from "express";
import multer from "multer";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { openDb } from "./db";
import { stubConfig, personas } from "../shared/catalog";
import { ApiError, stubQuestions, stubAssessment, upstream } from "./agents";
import { extractFile } from "./files";
import type { Session, Answer, Config } from "../shared/types";

const hash = (text: string | Buffer) =>
  createHash("sha256").update(text).digest("hex");
const uuid = z.string().uuid();
const createSchema = z.object({
  persona: z.enum([
    "business_angel",
    "venture_fund",
    "corporation",
    "grant_fund",
  ]),
  pitch: z.string().default(""),
  title: z.string().trim().min(1).max(120),
  deadline: z
    .enum(["Завтра", "Через 2–3 дня", "Через неделю", "Пока не знаю"])
    .default("Через 2–3 дня"),
});

export function createApp(dataDir = process.env.DATA_DIR ?? "./data") {
  const db = openDb(dataDir);
  const app = express();
  const locks = new Set<string>();
  const live = !!process.env.AGENT_API_URL;
  app.set("trust proxy", process.env.TRUST_PROXY === "1" ? 1 : false);
  app.disable("x-powered-by");
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          "img-src": ["'self'", "data:"],
          "style-src": ["'self'", "'unsafe-inline'"],
          "script-src": ["'self'"],
          "connect-src": ["'self'"],
        },
      },
    }),
  );
  app.get("/healthz", (_req, res) =>
    res.json({ status: "ok", mode: live ? "live" : "stub" }),
  );
  app.use(
    "/api",
    rateLimit({
      windowMs: 60000,
      limit: 120,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      handler: (_req, res) =>
        res.status(429).json({
          detail: {
            code: "rate_limit",
            message: "Слишком много запросов. Подожди минуту.",
          },
        }),
    }),
  );
  app.use("/api", (req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      const origin = req.get("origin");
      if (
        req.get("sec-fetch-site") === "cross-site" ||
        (origin && new URL(origin).host !== req.get("host"))
      )
        return next(
          new ApiError(403, "origin", "Запрос с другого сайта отклонён."),
        );
    }
    const match = req.headers.cookie?.match(
      /(?:^|;\s*)vibe_owner=([a-f0-9]{64})(?:;|$)/,
    );
    const token = match?.[1] ?? randomBytes(32).toString("hex");
    if (!match)
      res.cookie("vibe_owner", token, {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.COOKIE_SECURE === "1",
        maxAge: 365 * 86400000,
        path: "/",
      });
    res.locals.owner = hash(token);
    next();
  });
  app.use(express.json({ limit: "128kb" }));
  const getConfig = async (): Promise<Config> =>
    live ? { ...(await upstream("/api/v1/config")), mode: "live" } : stubConfig;
  const upload: express.RequestHandler = async (req, res, next) => {
    try {
      const config = await getConfig();
      res.locals.config = config;
      multer({
        storage: multer.memoryStorage(),
        limits: {
          fileSize: config.max_file_bytes,
          files: config.max_files,
          fields: 8,
          fieldSize: Math.max(200000, config.max_input_chars * 4),
        },
        fileFilter: (_req, file, cb) => {
          const ext = path.extname(file.originalname).toLowerCase();
          if (!config.file_extensions.includes(ext))
            return cb(
              new ApiError(
                415,
                "unsupported_file",
                "Поддерживаются TXT, MD, PDF, PPTX и DOCX.",
              ),
            );
          cb(null, true);
        },
      }).array("files")(req, res, next);
    } catch (error) {
      next(error);
    }
  };
  const get = (id: string, owner: string) => {
    uuid.parse(id);
    const row = db.get(id, owner);
    if (!row)
      throw new ApiError(
        404,
        "not_found",
        "Тренировка не найдена в этом браузере.",
      );
    return row;
  };
  const locked = async (id: string, work: () => Promise<void>) => {
    if (locks.has(id))
      throw new ApiError(
        409,
        "busy",
        "Тренировка ещё обрабатывается. Попробуй через несколько секунд.",
      );
    locks.add(id);
    try {
      await work();
    } finally {
      locks.delete(id);
    }
  };
  app.get("/api/v1/config", async (_req, res) => {
    const config = await getConfig();
    res.json({ ...config, mode: live ? "live" : "stub" });
  });
  app.get("/api/app/history", (_req, res) =>
    res.json(
      db.list(res.locals.owner).map((s) => ({
        id: s.id,
        title: s.title,
        persona: s.persona,
        status: s.status,
        created_at: s.created_at,
        updated_at: s.updated_at,
        score: s.assessment?.score ?? null,
        mode: s.mode,
        answer_count: s.answers.length,
      })),
    ),
  );
  app.get("/api/v1/sessions/:id", async (req, res) => {
    const row = get(req.params.id, res.locals.owner);
    if (
      live &&
      ["generating_questions", "analyzing"].includes(row.session.status)
    ) {
      const remote = await upstream(`/api/v1/sessions/${row.session.id}`);
      Object.assign(row.session, {
        status: remote.status,
        questions: remote.questions,
        assessment: remote.assessment,
        advice: remote.advice,
      });
      db.put(row.session, res.locals.owner, row.fingerprint);
    }
    res.json(row.session);
  });
  app.put("/api/v1/sessions/:id", upload, async (req, res) => {
    const id = uuid.parse(req.params.id);
    const input = createSchema.parse(req.body);
    const config: Config = res.locals.config;
    const files = (req.files as Express.Multer.File[]) ?? [];
    if (!input.pitch.trim() && !files.length)
      throw new ApiError(
        422,
        "empty_pitch",
        "Добавь описание проекта или файл с текстом.",
      );
    const fingerprint = hash(
      JSON.stringify({
        input,
        files: files.map((f) => ({
          name: f.originalname,
          hash: hash(f.buffer),
        })),
      }),
    );
    await locked(id, async () => {
      const previous = db.get(id, res.locals.owner);
      if (db.exists(id) && !previous)
        throw new ApiError(404, "not_found", "Тренировка не найдена.");
      if (previous && previous.fingerprint !== fingerprint)
        throw new ApiError(
          409,
          "changed_input",
          "Материалы изменились. Начни новую тренировку.",
        );
      if (previous && previous.session.status !== "generating_questions") {
        res.json(previous.session);
        return;
      }
      const extracted = live
        ? ""
        : (await Promise.all(files.map(extractFile))).join("\n");
      if (!live && files.length && !extracted.trim() && !input.pitch.trim())
        throw new ApiError(
          422,
          "no_text",
          "В файлах не найден текст. Для сканов добавь описание вручную или загрузи файл с текстовым слоем.",
        );
      if (input.pitch.length + extracted.length > config.max_input_chars)
        throw new ApiError(
          413,
          "too_much_text",
          `В материалах слишком много текста. Оставь до ${config.max_input_chars} символов.`,
        );
      const now = new Date().toISOString();
      const session: Session = previous?.session ?? {
        id,
        persona: input.persona,
        title: input.title,
        deadline: input.deadline,
        pitch: input.pitch,
        files: files.map((f) => f.originalname),
        status: "generating_questions",
        questions: [],
        assessment: null,
        advice: [],
        answers: [],
        created_at: now,
        updated_at: now,
        mode: live ? "live" : "stub",
      };
      db.put(session, res.locals.owner, fingerprint);
      if (live) {
        const form = new FormData();
        form.set("persona", input.persona);
        form.set("pitch", input.pitch);
        files.forEach((f) =>
          form.append(
            "files",
            new Blob([new Uint8Array(f.buffer)]),
            f.originalname,
          ),
        );
        const result = await upstream(`/api/v1/sessions/${id}`, {
          method: "PUT",
          body: form,
        });
        Object.assign(session, {
          status: result.status,
          questions: result.questions,
          assessment: result.assessment,
          advice: result.advice,
        });
      } else {
        session.questions = stubQuestions(session);
        session.status = "awaiting_answers";
      }
      session.updated_at = new Date().toISOString();
      db.put(session, res.locals.owner, fingerprint);
      res.json(session);
    });
  });
  app.put("/api/v1/sessions/:id/answers", async (req, res) => {
    const id = uuid.parse(req.params.id);
    await locked(id, async () => {
      const row = get(id, res.locals.owner);
      const config = await getConfig();
      const session = row.session;
      const { answers } = z
        .object({
          answers: z
            .array(
              z.object({
                question_id: z.string(),
                answer: z.string().trim().min(1).max(config.max_answer_chars),
              }),
            )
            .max(50),
        })
        .parse(req.body);
      const ids = new Set(answers.map((a) => a.question_id));
      if (
        answers.length !== session.questions.length ||
        ids.size !== answers.length ||
        session.questions.some((q) => !ids.has(q.id))
      )
        throw new ApiError(
          422,
          "incomplete_answers",
          "Ответь на каждый вопрос ровно один раз. Можно написать «не знаю».",
        );
      const ordered: Answer[] = session.questions.map((q) =>
        answers.find((a) => a.question_id === q.id)!,
      );
      if (session.status === "completed" || session.status === "analyzing") {
        if (JSON.stringify(session.answers) !== JSON.stringify(ordered))
          throw new ApiError(
            409,
            "changed_answers",
            "Эти ответы уже отправлены. Для новых ответов начни повторную тренировку.",
          );
        if (session.status === "completed") {
          res.json(session);
          return;
        }
      } else if (session.status !== "awaiting_answers")
        throw new ApiError(
          409,
          "invalid_state",
          "Дождись подготовки вопросов.",
        );
      session.answers = ordered;
      session.status = "analyzing";
      db.put(session, res.locals.owner, row.fingerprint);
      if (live) {
        const result = await upstream(`/api/v1/sessions/${id}/answers`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ answers: ordered }),
        });
        Object.assign(session, {
          status: result.status,
          questions: result.questions,
          assessment: result.assessment,
          advice: result.advice,
        });
      } else {
        Object.assign(session, stubAssessment(session, ordered));
        session.status = "completed";
      }
      session.updated_at = new Date().toISOString();
      db.put(session, res.locals.owner, row.fingerprint);
      res.json(session);
    });
  });
  app.delete("/api/app/sessions/:id", (req, res) => {
    const { session } = get(req.params.id, res.locals.owner);
    if (locks.has(session.id))
      throw new ApiError(409, "busy", "Дождись завершения обработки.");
    db.delete(session.id, res.locals.owner);
    res.status(204).end();
  });
  app.use("/api", (_req, _res, next) =>
    next(new ApiError(404, "not_found", "Такого метода API нет.")),
  );
  app.use(express.static(path.resolve("dist"), { maxAge: "1h", index: false }));
  app.get("/{*path}", (_req, res) =>
    res.sendFile(path.resolve("dist/index.html")),
  );
  app.use(
    (
      err: any,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      let status = 500,
        code = "internal_error",
        message = "Что-то пошло не так. Попробуй ещё раз.";
      if (err instanceof ApiError) {
        status = err.status;
        code = err.code;
        message = err.message;
      } else if (err instanceof z.ZodError) {
        status = 422;
        code = "validation";
        message = "Проверь заполнение полей и допустимую длину текста.";
      } else if (err instanceof multer.MulterError) {
        status = 413;
        code = "file_limit";
        message = `Можно загрузить до ${res.locals.config?.max_files ?? 5} файлов, каждый до ${Math.round((res.locals.config?.max_file_bytes ?? 10485760) / 1048576)} МБ.`;
      } else if (err?.type === "entity.too.large") {
        status = 413;
        code = "body_limit";
        message = "Запрос слишком большой.";
      } else if (err instanceof SyntaxError) {
        status = 400;
        code = "invalid_json";
        message = "Некорректный формат запроса.";
      }
      if (status === 500) console.error("Request failed:", err?.name);
      res.status(status).json({ detail: { code, message } });
    },
  );
  return { app, db };
}
