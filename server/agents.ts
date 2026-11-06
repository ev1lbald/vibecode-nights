import { criteria } from "../shared/catalog";
import type { Session, Question, Answer } from "../shared/types";

// Replaceable boundary: stub code never invokes an LLM or treats user text as instructions.
export function stubQuestions(
  session: Pick<Session, "persona" | "title">,
): Question[] {
  const common = `Кто клиент проекта «${session.title}»? Опиши одного конкретного человека и проблему, которую он решает сейчас.`;
  const sets = {
    business_angel: [
      common,
      "Кто уже готов платить за решение? Что подтверждает готовность платить, а не просто попробовать?",
      "Как клиент решает эту задачу сейчас? В чём твоё преимущество перед этой альтернативой?",
      "Сколько стоит привлечь и обслужить одного клиента? Какие цифры уже проверены, а какие ещё гипотеза?",
      "Кто в команде отвечает за результат и что будет с проектом после защиты? Какую рискованную гипотезу проверите первой?",
    ],
    venture_fund: [
      common,
      "Какой рынок доступен вашему проекту? Покажи расчёт снизу вверх и назови источник исходных данных.",
      "За счёт какого канала вы вырастете в десять раз? Какие метрики удержания или продаж это подтверждают?",
      "Что произойдёт с маржой, если конкурент снизит цену вдвое? Какие затраты на клиента вы уже знаете?",
      "Что помешает конкуренту скопировать продукт? Какой измеримый результат нужен для следующего раунда?",
    ],
    corporation: [
      common,
      "Кто внутри компании станет заказчиком и кто подписывает договор? Какую измеримую пользу получит каждый из них?",
      "Как пройдёт интеграция в существующие процессы? Какая критическая зависимость может остановить пилот?",
      "Какие данные потребуются и какие юридические или репутационные риски нужно закрыть до пилота?",
      "Какой результат и за какой срок покажет пилот? По какому критерию заказчик решит продолжить сотрудничество?",
    ],
    grant_fund: [
      common,
      "Какой измеримый результат и общественную пользу вы получите к концу проекта?",
      "На что конкретно пойдут средства? Какие статьи сметы подтверждены расчётами?",
      "Кто отвечает за этапы и сроки? Что произойдёт при потере ключевого участника или поставщика?",
      "Какие документы подтвердят результат и расходы? Как проект продолжит работу после окончания гранта?",
    ],
  };
  return sets[session.persona].map((text, i) => ({
    id: `q-${i + 1}`,
    text,
    category_id: [null, "no_customers", "copying", "price_war", "dependency"][
      i
    ],
  }));
}
export function stubAssessment(
  session: Session,
  answers: Answer[],
): Pick<Session, "assessment" | "advice"> {
  const days = session.deadline === "Завтра" ? 1 : 3;
  const unknown = answers.filter((a) =>
    /^(пока )?не знаю[.!]?$/i.test(a.answer.trim()),
  ).length;
  return {
    assessment: {
      score: null,
      score_min: 0,
      score_max: 10,
      criteria: criteria.map((c) => ({
        ...c,
        score: null,
        rationale: `Агент оценки не подключён. Сохранено ${answers.length} ответов${unknown ? `, из них «не знаю»: ${unknown}` : ""}. Этот критерий пока не оценён.`,
      })),
    },
    advice: [
      {
        category_id: "no_customers",
        action: "Проверь готовность платить",
        expected_result:
          "Поговори с двумя потенциальными клиентами. Назови конкретную цену и запиши их ответы. Подготовь один слайд: что подтвердилось, а что осталось гипотезой.",
        estimated_days: 1,
      },
      {
        category_id: "copying",
        action: "Покажи текущую альтернативу",
        expected_result:
          "Выбери один способ, которым клиент решает задачу сегодня. Сравни с проектом по цене, времени и результату на одном слайде. Неизвестные цифры пометь как гипотезы.",
        estimated_days: Math.min(2, days),
      },
      {
        category_id: "dependency",
        action: "Проверь самый рискованный шаг",
        expected_result:
          "Назови одну зависимость, без которой проект остановится. Запиши запасной вариант, ответственного и ближайшую проверку. Подготовь короткий ответ для защиты.",
        estimated_days: days,
      },
    ],
  };
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export async function upstream(
  path: string,
  init: RequestInit = {},
): Promise<any> {
  const url = process.env.AGENT_API_URL?.replace(/\/$/, "");
  if (!url)
    throw new ApiError(503, "not_configured", "Сервис агентов не настроен.");
  const headers = new Headers(init.headers);
  if (process.env.AGENT_API_TOKEN)
    headers.set("Authorization", `Bearer ${process.env.AGENT_API_TOKEN}`);
  let response: Response;
  try {
    response = await fetch(url + path, {
      ...init,
      headers,
      signal: AbortSignal.timeout(120000),
    });
  } catch {
    throw new ApiError(
      502,
      "agent_unavailable",
      "Сервис анализа временно недоступен. Ответы сохранены — попробуй ещё раз.",
    );
  }
  const body = await response.json().catch(() => null);
  if (!response.ok)
    throw new ApiError(
      response.status === 401 ? 502 : response.status,
      body?.detail?.code ?? "agent_error",
      response.status === 401
        ? "Ошибка подключения сервиса анализа."
        : (body?.detail?.message ??
            "Не удалось выполнить анализ. Попробуй ещё раз."),
    );
  return body;
}
