import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { personas, deadlines, examplePitch } from "../shared/catalog";
import type { Config, Session, PersonaId, Answer } from "../shared/types";
import "./styles.css";

const go = (route: string) => {
  location.hash = route;
  window.scrollTo({ top: 0, behavior: "instant" });
};
const read = <T,>(key: string, fallback: T): T => {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "null") ?? fallback;
  } catch {
    return fallback;
  }
};
function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}
async function api<T>(url: string, options: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      ...options,
      credentials: "same-origin",
      signal: AbortSignal.timeout(135000),
    });
  } catch {
    throw new Error(
      "Нет связи с сервером. Проверь интернет и повтори — введённый текст остался на экране.",
    );
  }
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => null);
  if (!res.ok)
    throw new Error(
      body?.detail?.message ?? "Не удалось выполнить запрос. Попробуй ещё раз.",
    );
  return body;
}
type Draft = { title: string; pitch: string; deadline: string };
const emptyDraft: Draft = { title: "", pitch: "", deadline: "Через 2–3 дня" };
type HistoryItem = Pick<
  Session,
  "id" | "title" | "persona" | "status" | "created_at" | "updated_at" | "mode"
> & { score: number | null; answer_count: number };

function Button({
  children,
  secondary = false,
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { secondary?: boolean }) {
  return (
    <button
      className={`${secondary ? "button secondary" : "button"} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}
function Badge({
  children,
  color,
}: {
  children: React.ReactNode;
  color?: string;
}) {
  return (
    <span className="badge" style={{ background: color }}>
      {children}
    </span>
  );
}
function ErrorBox({ message }: { message: string }) {
  return message ? (
    <div className="error" role="alert">
      {message}
    </div>
  ) : null;
}
function Busy({ text = "Загружаем…" }: { text?: string }) {
  return (
    <div className="busy" role="status">
      <span className="spinner" />
      {text}
    </div>
  );
}
function Mascot({
  persona,
  className = "",
  slot = "card",
}: {
  persona: PersonaId;
  className?: string;
  slot?: "card" | "setup" | "session";
}) {
  const file =
    persona === "business_angel" && slot !== "card"
      ? `angel-${slot}`
      : personas[persona].image;
  return (
    <div className={`mascot ${className}`}>
      <img src={`/assets/${file}.svg`} alt="" />
    </div>
  );
}
function App() {
  const [route, setRoute] = useState(location.hash.slice(1) || "/");
  const [config, setConfig] = useState<Config | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const listener = () => setRoute(location.hash.slice(1) || "/");
    window.addEventListener("hashchange", listener);
    return () => window.removeEventListener("hashchange", listener);
  }, []);
  const load = () => {
    setError("");
    api<Config>("/api/v1/config")
      .then(setConfig)
      .catch((e) => setError(e.message));
  };
  useEffect(load, []);
  useEffect(() => {
    document.title =
      (
        {
          "/": "Злой инвестор — репетиция защиты",
          "/history": "Мои тренировки — Злой инвестор",
          "/how": "Как это работает — Злой инвестор",
        } as Record<string, string>
      )[route] ?? "Тренировка — Злой инвестор";
  }, [route]);
  const [path, query] = route.split("?");
  const params = new URLSearchParams(query);
  const selected = (params.get("persona") ?? "business_angel") as PersonaId;
  const persona: PersonaId = selected in personas ? selected : "business_angel";
  return (
    <>
      <header className="header">
        <a href="#/" className="brand">
          <span>◉</span> злой инвестор
        </a>
        <nav aria-label="Основная навигация">
          <a className={path === "/" ? "active" : ""} href="#/">
            Инвесторы
          </a>
          <a className={path === "/how" ? "active" : ""} href="#/how">
            Как это работает
          </a>
          <a className={path === "/history" ? "active" : ""} href="#/history">
            Мои тренировки
          </a>
        </nav>
        <Badge>Гость</Badge>
      </header>
      <main>
        {error ? (
          <div className="page">
            <ErrorBox message={error} />
            <Button onClick={load}>Повторить подключение</Button>
          </div>
        ) : !config ? (
          <Busy />
        ) : path === "/" ? (
          <Home config={config} />
        ) : path === "/setup" ? (
          <Setup key={persona} persona={persona} config={config} />
        ) : path.startsWith("/session/") ? (
          <Training key={path} id={path.split("/")[2]} config={config} />
        ) : path === "/history" ? (
          <History />
        ) : path === "/how" ? (
          <How config={config} />
        ) : (
          <div className="page">
            <h1>Эта страница потерялась.</h1>
            <Button onClick={() => go("/")}>К инвесторам ↗</Button>
          </div>
        )}
      </main>
      <footer>
        <span>Строго к проекту. Бережно к человеку.</span>
        <span>
          {config?.mode === "stub"
            ? "Демо · агенты пока не подключены"
            : "Репетиция перед защитой"}
        </span>
      </footer>
    </>
  );
}
function Home({ config }: { config: Config }) {
  return (
    <div className="page home">
      <section className="hero">
        <div>
          <Badge color="var(--green)">Репетиция перед защитой</Badge>
          <h1>
            Сложные вопросы.
            <br />
            До настоящей защиты.
          </h1>
        </div>
        <div className="hero-intro">
          <h2>
            Здесь можно ошибаться.
            <br />
            На защите — быть готовым.
          </h2>
          <p>Выбери инвестора, расскажи о стартапе и получи честный разбор.</p>
          <small>
            {config.question_count} вопросов&nbsp; / &nbsp;{config.advice_count}{" "}
            конкретных совета
          </small>
        </div>
      </section>
      <section className="investor-grid" aria-label="Выбери инвестора">
        {Object.values(personas)
          .filter((p) => config.personas.some((allowed) => allowed.id === p.id))
          .map(({ id }) => {
            const p = personas[id];
            if (!p) return null;
            return (
              <a
                href={`#/setup?persona=${id}`}
                className="investor-card"
                style={{ background: p.color }}
                key={id}
              >
                <div className="card-heading">
                  <h2>{p.label}</h2>
                  <span aria-hidden="true">↗</span>
                </div>
                <p className="card-description">{p.description}</p>
                <Mascot persona={id} />
                <p className="card-quote">{p.quote}</p>
              </a>
            );
          })}
      </section>
    </div>
  );
}
function Setup({ persona, config }: { persona: PersonaId; config: Config }) {
  const [draft, setDraft] = useState<Draft>(() =>
    read("vibe-pitch", emptyDraft),
  );
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const [storageError, setStorageError] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const request = useRef<{ id: string; fingerprint: string } | null>(null);
  const p = personas[persona];
  const change = (field: keyof Draft, value: string) =>
    setDraft((d) => ({ ...d, [field]: value }));
  useEffect(() => {
    setStorageError(!save("vibe-pitch", draft));
  }, [draft]);
  function addFiles(incoming: FileList | File[]) {
    setError("");
    const next = [...files, ...Array.from(incoming)];
    if (next.length > config.max_files) {
      setError(`Можно добавить до ${config.max_files} файлов.`);
      return;
    }
    for (const f of next) {
      const ext = "." + f.name.split(".").pop()?.toLowerCase();
      if (!config.file_extensions.includes(ext)) {
        setError(`Формат «${f.name}» не поддерживается.`);
        return;
      }
      if (f.size > config.max_file_bytes) {
        setError(
          `Файл «${f.name}» больше ${Math.round(config.max_file_bytes / 1048576)} МБ.`,
        );
        return;
      }
    }
    setFiles(next);
  }
  async function start(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!draft.pitch.trim() && !files.length) {
      setError("Расскажи о проекте или добавь файл с текстом.");
      return;
    }
    setBusy(true);
    const fingerprint = JSON.stringify({
      draft,
      persona,
      files: files.map((f) => [f.name, f.size, f.lastModified]),
    });
    if (request.current?.fingerprint !== fingerprint)
      request.current = { id: crypto.randomUUID(), fingerprint };
    const id = request.current.id;
    const form = new FormData();
    form.set("persona", persona);
    form.set("title", draft.title.trim());
    form.set("pitch", draft.pitch);
    form.set("deadline", draft.deadline);
    files.forEach((f) => form.append("files", f));
    try {
      await api<Session>(`/api/v1/sessions/${id}`, {
        method: "PUT",
        body: form,
      });
      go(`/session/${id}`);
    } catch (e) {
      try {
        await api<Session>(`/api/v1/sessions/${id}`);
        go(`/session/${id}`);
      } catch {
        setError((e as Error).message);
      }
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="page setup">
      <a className="back" href="#/">
        ← К выбору инвестора
      </a>
      <h1>Начнём с твоего проекта.</h1>
      <p className="lead">
        Опиши то, что уже знаешь. Если данных нет — так и напиши.
      </p>
      <div className="setup-grid">
        <form onSubmit={start} className="pitch-form">
          <fieldset disabled={busy}>
            <label>
              Название проекта
              <input
                required
                maxLength={120}
                value={draft.title}
                onChange={(e) => change("title", e.target.value)}
                placeholder="Например, Смена — помощник для баров"
              />
            </label>
            <label>
              <span className="label-row">
                Что за стартап?
                <button
                  aria-label="Заполнить пример"
                  className="text-button"
                  type="button"
                  onClick={() =>
                    setDraft({
                      ...draft,
                      title: "Смена — помощник для баров",
                      pitch: examplePitch,
                    })
                  }
                >
                  Заполнить пример
                </button>
              </span>
              <textarea
                aria-label="Что за стартап?"
                className="pitch-input"
                maxLength={config.max_input_chars}
                value={draft.pitch}
                onChange={(e) => change("pitch", e.target.value)}
                placeholder="Что вы делаете, для кого и какую проблему решаете? Что уже проверили, кто в команде и как планируете зарабатывать?"
              />
              <span className="field-note">
                {draft.pitch.length.toLocaleString("ru")} /{" "}
                {config.max_input_chars.toLocaleString("ru")} · Можно загрузить
                материалы вместо текста
              </span>
            </label>
            <div
              className={`upload ${drag ? "drag" : ""}`}
              onDragOver={(e) => {
                e.preventDefault();
                setDrag(true);
              }}
              onDragLeave={() => setDrag(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDrag(false);
                if (!busy) addFiles(e.dataTransfer.files);
              }}
            >
              <input
                ref={input}
                type="file"
                multiple
                accept={config.file_extensions.join(",")}
                onChange={(e) => {
                  if (e.target.files) addFiles(e.target.files);
                  e.target.value = "";
                }}
                hidden
              />
              <button
                type="button"
                className="upload-button"
                onClick={() => input.current?.click()}
              >
                <span>＋</span>
                <strong>Добавить материалы</strong>
                <small>
                  {config.file_extensions
                    .map((e) => e.slice(1).toUpperCase())
                    .join(", ")}{" "}
                  · до {Math.round(config.max_file_bytes / 1048576)} МБ
                </small>
              </button>
              <span className="field-note">
                Или перетащи файлы сюда. PDF должен содержать текстовый слой.
              </span>
            </div>
            {files.length > 0 && (
              <ul className="file-list">
                {files.map((file, i) => (
                  <li key={`${file.name}-${i}`}>
                    <span>
                      {file.name}
                      <small>{Math.ceil(file.size / 1024)} КБ</small>
                    </span>
                    <button
                      type="button"
                      aria-label={`Удалить ${file.name}`}
                      onClick={() =>
                        setFiles(files.filter((_, index) => index !== i))
                      }
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div>
              <p className="field-label">Когда защита?</p>
              <div className="chips">
                {deadlines.map((d) => (
                  <button
                    type="button"
                    className={`chip ${draft.deadline === d ? "selected" : ""}`}
                    aria-pressed={draft.deadline === d}
                    key={d}
                    onClick={() => change("deadline", d)}
                  >
                    {d}
                  </button>
                ))}
              </div>
            </div>
            <ErrorBox
              message={
                error ||
                (storageError
                  ? "Браузер не сохраняет черновик. Не закрывай вкладку до отправки."
                  : "")
              }
            />
            <Button className="start-button" type="submit" disabled={busy}>
              {busy ? (
                <>
                  <span className="spinner" /> Готовим вопросы…
                </>
              ) : (
                "Начать тренировку ↗"
              )}
            </Button>
            <small className="muted">
              Описание используется для вопросов и разбора этой тренировки.
            </small>
          </fieldset>
        </form>
        <aside className="selected-investor" style={{ background: p.color }}>
          <Badge>Твой собеседник</Badge>
          <h2>{p.label}</h2>
          <Mascot persona={persona} slot="setup" />
          <h3>
            {persona === "business_angel"
              ? "«Идея звучит интересно.\nА кто за неё заплатит?»"
              : p.quote}
          </h3>
          <p>{p.intro}</p>
          <small>
            {config.question_count} вопросов · можно отвечать «не знаю»
          </small>
          {config.mode === "stub" && (
            <small className="demo-note">
              Демо: вопросы подготовлены заранее. Индивидуальный анализ появится
              после подключения агентов.
            </small>
          )}
        </aside>
      </div>
    </div>
  );
}
function Training({ id, config }: { id: string; config: Config }) {
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>(() =>
    read(`vibe-answers-${id}`, {}),
  );
  const [index, setIndex] = useState(0);
  const [storageError, setStorageError] = useState(false);
  const [loading, setLoading] = useState(true);
  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const s = await api<Session>(`/api/v1/sessions/${id}`);
      setSession(s);
      if (s.answers.length) {
        setDrafts(
          Object.fromEntries(s.answers.map((a) => [a.question_id, a.answer])),
        );
      } else {
        const d = read<Record<string, string>>(`vibe-answers-${id}`, {});
        const first = s.questions.findIndex((q) => !d[q.id]?.trim());
        setIndex(first < 0 ? Math.max(0, s.questions.length - 1) : first);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
  }, [id]);
  useEffect(() => {
    setStorageError(!save(`vibe-answers-${id}`, drafts));
  }, [id, drafts]);
  useEffect(() => {
    if (
      !session ||
      session.stage_error ||
      !["generating_questions", "analyzing"].includes(session.status)
    )
      return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const updated = await api<Session>(`/api/v1/sessions/${id}`);
        if (stopped) return;
        setSession(updated);
        setError("");
        if (
          updated.stage_error ||
          !["generating_questions", "analyzing"].includes(updated.status)
        )
          return;
      } catch (e) {
        if (!stopped) setError((e as Error).message);
      }
      if (!stopped) timer = setTimeout(poll, 2500);
    };
    timer = setTimeout(poll, 1500);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [id, session?.status, session?.stage_error]);
  async function retryStage() {
    setBusy(true);
    setError("");
    try {
      setSession(
        await api<Session>(`/api/app/sessions/${id}/retry`, { method: "POST" }),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function submitAll(next: Record<string, string>) {
    if (!session) return;
    setBusy(true);
    setError("");
    const answers: Answer[] = session.questions.map((q) => ({
      question_id: q.id,
      answer: next[q.id]?.trim() ?? "",
    }));
    try {
      const s = await api<Session>(`/api/v1/sessions/${id}/answers`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answers }),
      });
      setSession(s);
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function answer(value: string) {
    if (!session || !value.trim()) return;
    const q = session.questions[index];
    const next = { ...drafts, [q.id]: value.trim() };
    setDrafts(next);
    setError("");
    if (index + 1 < session.questions.length) {
      setIndex(index + 1);
    } else await submitAll(next);
  }
  if (loading) return <Busy text="Открываем тренировку…" />;
  if (!session)
    return (
      <div className="page">
        <ErrorBox message={error} />
        <Button onClick={load}>Попробовать ещё раз</Button>
        <a className="back" href="#/history">
          К моим тренировкам
        </a>
      </div>
    );
  if (session.status === "completed") return <Results session={session} />;
  if (
    ["generating_questions", "analyzing"].includes(session.status) ||
    session.questions.length === 0
  ) {
    const analyzing = session.status === "analyzing";
    return (
      <div className="page processing">
        <Badge color="var(--green)">
          {analyzing ? "Пять ответов получены" : "Материалы получены"}
        </Badge>
        <h1>
          {session.stage_error
            ? "Нужно повторить этот этап."
            : analyzing
              ? "Инвестор разбирает проект."
              : "Готовим вопросы по твоему проекту."}
        </h1>
        <p className="lead">
          {analyzing
            ? "Оцениваем проект по критериям и выбираем три конкретных действия."
            : "Изучаем материалы и выбираем пять самых важных вопросов."}{" "}
          Это может занять несколько минут.
        </p>
        <div
          className="processing-card"
          style={{ background: personas[session.persona].color }}
        >
          <Mascot persona={session.persona} />
          <div>
            <h2>{session.title}</h2>
            <p>{personas[session.persona].label}</p>
            {!session.stage_error && (
              <Busy
                text={analyzing ? "Анализируем ответы…" : "Изучаем проект…"}
              />
            )}
          </div>
        </div>
        <ErrorBox message={session.stage_error || error} />
        <div className="actions">
          {session.stage_error && (
            <Button disabled={busy} onClick={retryStage}>
              {busy ? "Запускаем…" : "Повторить этап ↗"}
            </Button>
          )}
          <Button secondary onClick={load}>
            Проверить состояние
          </Button>
          <a href="#/history">Вернуться к моим тренировкам</a>
        </div>
        <p className="muted">
          Материалы и отправленные ответы сохранены. Можно закрыть страницу и
          вернуться позже.
        </p>
      </div>
    );
  }
  const p = personas[session.persona],
    q = session.questions[index],
    color = p.color;
  return (
    <div className="page training">
      <div className="session-heading">
        <div>
          <h1>{session.title} / репетиция защиты</h1>
          <p className="muted">
            Говори конкретно. Честное «не знаю» лучше выдуманной цифры.
          </p>
        </div>
        <Badge color="var(--lavender)">
          Вопрос {index + 1} из {session.questions.length}
        </Badge>
      </div>
      <div className="training-grid">
        <aside className="session-investor" style={{ background: color }}>
          <h2>{p.label}</h2>
          <Mascot persona={session.persona} slot="session" />
          <h3>
            Цифры вместо
            <br />
            «нам кажется».
          </h3>
          <p>{p.description}</p>
          <hr />
          <p>
            Проект
            <br />
            <strong>{session.title}</strong>
          </p>
          <div
            className="progress"
            aria-label={`Вопрос ${index + 1} из ${session.questions.length}`}
          >
            {session.questions.map((question, i) => (
              <button
                disabled={i > index || busy}
                onClick={() => setIndex(i)}
                key={question.id}
                aria-label={`Вопрос ${i + 1}`}
                className={i <= index ? "filled" : ""}
              />
            ))}
          </div>
        </aside>
        <section className="conversation" aria-label="Диалог с инвестором">
          {index > 0 && (
            <>
              <small className="muted">
                {String(index).padStart(2, "0")} / Предыдущий вопрос
              </small>
              <p className="previous-question">
                {session.questions[index - 1].text}
              </p>
              <div className="previous-answer">
                <small>Твой ответ</small>
                <p>{drafts[session.questions[index - 1].id]}</p>
                <button
                  className="text-button"
                  onClick={() => setIndex(index - 1)}
                  disabled={busy}
                >
                  Изменить ответ
                </button>
              </div>
            </>
          )}
          <div className="current-question" aria-live="polite">
            <small>
              {String(index + 1).padStart(2, "0")} /{" "}
              {q.category_id
                ? (config.categories.find((c) => c.id === q.category_id)
                    ?.label ?? "Вопрос инвестора")
                : "Общий вопрос"}
            </small>
            <h2>{q.text}</h2>
          </div>
          <form
            className="answer-composer"
            onSubmit={(e) => {
              e.preventDefault();
              void answer(drafts[q.id] ?? "");
            }}
          >
            <label className="sr-only" htmlFor="answer">
              Твой ответ
            </label>
            <textarea
              id="answer"
              disabled={busy}
              maxLength={session.max_answer_chars ?? config.max_answer_chars}
              value={drafts[q.id] ?? ""}
              onChange={(e) => setDrafts({ ...drafts, [q.id]: e.target.value })}
              placeholder="Напиши свой ответ…"
            />
            <div className="answer-actions">
              <button
                className="text-button"
                disabled={busy}
                type="button"
                onClick={() => answer("Пока не знаю")}
              >
                Пока не знаю
              </button>
              <small className="muted answer-count">
                {(drafts[q.id] ?? "").length} /{" "}
                {session.max_answer_chars ?? config.max_answer_chars}
              </small>
              <Button disabled={busy || !drafts[q.id]?.trim()} type="submit">
                {busy ? (
                  <>
                    <span className="spinner" /> Готовим разбор…
                  </>
                ) : index === session.questions.length - 1 ? (
                  "Получить разбор ↗"
                ) : (
                  "Ответить ↑"
                )}
              </Button>
            </div>
          </form>
          <ErrorBox
            message={
              error ||
              (storageError
                ? "Не удалось сохранить черновик в браузере. Не закрывай вкладку."
                : "")
            }
          />
          <div className="conversation-footer">
            <small className="muted">
              {session.mode === "stub"
                ? "Демо-тренировка · ответы сохраняются, оценка агента пока недоступна"
                : "Ответы сохранятся на сервере после завершения раунда."}
            </small>
            <a href="#/history">Продолжить позже</a>
          </div>
        </section>
      </div>
    </div>
  );
}
function Results({ session }: { session: Session }) {
  const assessment = session.assessment;
  const [open, setOpen] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState("");
  const scored =
    assessment?.criteria.filter((c) => c.score !== null).length ?? 0;
  function repeat() {
    save("vibe-pitch", {
      title: session.title,
      pitch: session.pitch,
      deadline: session.deadline,
    });
    go(`/setup?persona=${session.persona}`);
  }
  function download() {
    try {
      const text = [
        `# ${session.title}`,
        `Инвестор: ${personas[session.persona].label}`,
        `Режим: ${session.mode === "stub" ? "Демонстрация без оценки агента" : "Анализ"}`,
        `Оценка: ${assessment?.score ?? "Нет оценки"}`,
        "",
        ...session.questions.flatMap((q) => [
          `## ${q.text}`,
          session.answers.find((a) => a.question_id === q.id)?.answer ?? "",
          "",
        ]),
        "## Критерии",
        ...(assessment?.criteria.map(
          (c) => `${c.label}: ${c.score ?? "Нет оценки"}\n${c.rationale}`,
        ) ?? []),
        "",
        "## План",
        ...session.advice.map(
          (a, i) =>
            `${i + 1}. ${a.action}\n${a.expected_result}\nСрок: ${a.estimated_days} дн.`,
        ),
      ].join("\n");
      const url = URL.createObjectURL(
        new Blob([text], { type: "text/markdown;charset=utf-8" }),
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = "razbor-proekta.md";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      setDownloadError("Не удалось скачать разбор. Попробуй ещё раз.");
    }
  }
  return (
    <div className="page results">
      <div className="result-heading">
        <div>
          <Badge color="var(--green)">Раунд завершён</Badge>
          <h1>
            {session.mode === "stub"
              ? "Первая репетиция позади."
              : "Теперь понятно, что доработать."}
          </h1>
        </div>
        <p className="muted">
          {session.title}
          <br />
          {personas[session.persona].label}
        </p>
      </div>
      <section className="score-card">
        <div>
          <strong className="score">
            {assessment?.score == null
              ? "—"
              : Number(assessment.score.toFixed(1)).toLocaleString("ru")}{" "}
            / {assessment?.score_max ?? 10}
          </strong>
          <small>
            {scored ? "по оценённым критериям" : "оценка пока недоступна"}
          </small>
        </div>
        <div>
          <h2>
            {session.mode === "stub"
              ? "Ответы сохранены. Следующий шаг — подготовка."
              : scored
                ? "Разбор твоего проекта готов."
                : "Для оценки пока недостаточно данных."}
          </h2>
          <p>
            {session.mode === "stub"
              ? "Агенты пока не подключены, поэтому мы не выставляем баллы. Ниже — пример плана подготовки, а не персональная оценка проекта."
              : "Открой критерии ниже: у каждого балла есть обоснование по твоим материалам и ответам."}
          </p>
          <small>
            {session.questions.length} ответов · {scored} из{" "}
            {assessment?.criteria.length ?? 10} критериев оценены
          </small>
        </div>
      </section>
      <h2 className="section-title">
        {session.mode === "stub"
          ? "Три шага для подготовки"
          : "Три шага до защиты"}
      </h2>
      <div className="advice-grid">
        {session.advice.map((advice, i) => (
          <article
            key={i}
            style={{
              background: ["var(--peach)", "var(--lavender)", "var(--green)"][
                i % 3
              ],
            }}
          >
            <small>
              {String(i + 1).padStart(2, "0")} /{" "}
              {advice.estimated_days === 1
                ? "за 1 день"
                : `за ${advice.estimated_days} дня`}
            </small>
            <h3>{advice.action}</h3>
            <p>{advice.expected_result}</p>
            <small className="muted">
              Что показать: конкретный ответ или слайд
            </small>
          </article>
        ))}
      </div>
      <div className="result-details">
        <section>
          <h2>Оценка по критериям</h2>
          <div className="criteria-list">
            {assessment?.criteria.map((c) => (
              <div className="criterion" key={c.id}>
                <button
                  aria-expanded={open === c.id}
                  onClick={() => setOpen(open === c.id ? null : c.id)}
                >
                  <span>{c.label}</span>
                  <span>
                    {c.score === null ? "Нет оценки" : `${c.score}/10`}{" "}
                    <span aria-hidden="true">{open === c.id ? "−" : "＋"}</span>
                  </span>
                </button>
                {open === c.id && <p>{c.rationale}</p>}
              </div>
            ))}
          </div>
        </section>
        <section className="evidence">
          <h2>На чём основан вывод</h2>
          {session.mode === "stub" ? (
            <>
              <h3>Сейчас это демонстрационный режим.</h3>
              <p className="muted">
                Ответы сохранены, но агент ещё не делал выводов. Все критерии
                остаются без оценки.
              </p>
            </>
          ) : (
            <>
              <h3>
                {assessment?.criteria.find((c) => c.score !== null)?.label ??
                  "Недостаточно подтверждённых данных"}
              </h3>
              <p className="muted">
                {assessment?.criteria.find((c) => c.score !== null)
                  ?.rationale ??
                  "Расскажи больше о проекте в следующем раунде."}
              </p>
            </>
          )}
          <hr />
          <p>
            {session.mode === "live"
              ? "Оценка учитывает приоритеты выбранного инвестора."
              : "В деморежиме баллы не выставляются."}
          </p>
          <p className="muted">
            {session.mode === "live"
              ? "Каждый критерий имеет свой вес. Если данных недостаточно, агент ставит 0 и объясняет, что нужно подтвердить."
              : "Результат появится после прохождения новой тренировки с подключёнными агентами."}
          </p>
          <details>
            <summary>Вопросы и мои ответы</summary>
            {session.questions.map((q) => (
              <div className="transcript" key={q.id}>
                <strong>{q.text}</strong>
                <p>
                  {session.answers.find((a) => a.question_id === q.id)?.answer}
                </p>
              </div>
            ))}
          </details>
        </section>
      </div>
      <ErrorBox message={downloadError} />
      <div className="result-actions">
        <Button onClick={repeat}>Доработать и повторить ↗</Button>
        <Button secondary onClick={download}>
          Скачать разбор ↓
        </Button>
        <a href="#/">Вернуться к инвесторам</a>
      </div>
    </div>
  );
}
function History() {
  const [items, setItems] = useState<HistoryItem[] | null>(null),
    [error, setError] = useState(""),
    [deleting, setDeleting] = useState<string | null>(null);
  const load = () =>
    api<HistoryItem[]>("/api/app/history")
      .then(setItems)
      .catch((e) => setError(e.message));
  useEffect(() => {
    void load();
  }, []);
  async function remove(id: string) {
    setError("");
    try {
      await api(`/api/app/sessions/${id}`, { method: "DELETE" });
      setItems(items?.filter((s) => s.id !== id) ?? []);
      localStorage.removeItem(`vibe-answers-${id}`);
      setDeleting(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <div className="page history">
      <div className="session-heading">
        <div>
          <h1>Мои тренировки</h1>
          <p className="lead">
            Вернись к разговору или посмотри, что получилось.
          </p>
        </div>
        <Button onClick={() => go("/")}>Новая тренировка ＋</Button>
      </div>
      <p className="muted">
        Тренировки доступны в этом браузере. Завершённые раунды хранятся на
        сервере.
      </p>
      <ErrorBox message={error} />
      {!items ? (
        !error ? (
          <Busy />
        ) : (
          <Button onClick={load}>Повторить</Button>
        )
      ) : !items.length ? (
        <section className="empty-state">
          <span>↗</span>
          <h2>Первая репетиция ещё впереди.</h2>
          <p>Выбери инвестора. Ошибаться здесь — часть подготовки.</p>
          <Button onClick={() => go("/")}>Выбрать инвестора</Button>
        </section>
      ) : (
        <div className="history-list">
          {items.map((s) => (
            <article key={s.id}>
              <div
                className="history-avatar"
                style={{ background: personas[s.persona].color }}
              >
                <img alt="" src={`/assets/${personas[s.persona].image}.svg`} />
              </div>
              <div className="history-info">
                <small className="muted">
                  {new Date(s.created_at).toLocaleString("ru", {
                    day: "numeric",
                    month: "long",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </small>
                <h2>{s.title}</h2>
                <p>
                  {personas[s.persona].label} ·{" "}
                  {s.status === "completed" ? "Раунд завершён" : "В процессе"}
                  {s.mode === "stub" ? " · Демо" : ""}
                </p>
              </div>
              <div className="history-actions">
                <Button secondary onClick={() => go(`/session/${s.id}`)}>
                  {s.status === "completed"
                    ? "Открыть разбор ↗"
                    : "Продолжить ↗"}
                </Button>
                <button
                  className="text-button"
                  onClick={() => setDeleting(s.id)}
                >
                  Удалить
                </button>
              </div>
              {deleting === s.id && (
                <div className="delete-confirm" role="alert">
                  <p>
                    Удалить эту тренировку и ответы? Восстановить их не
                    получится.
                  </p>
                  <div className="actions">
                    <Button onClick={() => remove(s.id)}>
                      Удалить тренировку
                    </Button>
                    <Button secondary onClick={() => setDeleting(null)}>
                      Оставить
                    </Button>
                  </div>
                </div>
              )}
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
function How({ config }: { config: Config }) {
  return (
    <div className="page how">
      <Badge color="var(--green)">10 минут до большей уверенности</Badge>
      <h1>
        Репетиция, после которой
        <br />
        понятно, что делать.
      </h1>
      <p className="lead">Строгие вопросы к проекту. Уважение к тебе.</p>
      <div className="how-grid">
        {[
          [
            "01",
            "Расскажи о проекте",
            "Вставь питч или загрузи материалы. Факты, гипотезы и «пока не знаю» одинаково полезны.",
          ],
          [
            "02",
            "Ответь на пять вопросов",
            "Выбери инвестора и пройди короткий раунд. Сохраняй конкретику: кто клиент, что проверили, откуда цифры.",
          ],
          [
            "03",
            "Получи разбор и план",
            "Десять критериев с обоснованием и три выполнимых действия. Вернись со следующим раундом, когда доработаешь проект.",
          ],
        ].map(([n, title, body], i) => (
          <article
            key={n}
            style={{
              background: ["var(--green)", "var(--lavender)", "var(--peach)"][
                i
              ],
            }}
          >
            <small>{n}</small>
            <h2>{title}</h2>
            <p>{body}</p>
          </article>
        ))}
      </div>
      <section className="how-rules">
        <h2>Честные правила</h2>
        <p>
          Оценка учитывает веса критериев для выбранного инвестора. Если данных
          недостаточно, критерий получает 0 с объяснением пробела. Инвестор
          проверяет аргументы, а не личные качества. Факты о рынке и конкурентах
          нужно подтверждать.
        </p>
        <p className="muted">
          {config.mode === "stub"
            ? "Сейчас доступен демонстрационный режим: сценарий работает целиком, но агенты ещё не подключены. В нём нет персональных баллов, а советы — примеры подготовки."
            : "Вопросы, оценка и советы формируются по твоим материалам и ответам. Отделяй подтверждённые факты от гипотез."}
        </p>
        <Button onClick={() => go("/")}>Выбрать собеседника ↗</Button>
      </section>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
