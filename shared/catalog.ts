import type { Config, PersonaId } from "./types";
export const personas: Record<
  PersonaId,
  {
    id: PersonaId;
    label: string;
    description: string;
    quote: string;
    intro: string;
    image: string;
    color: string;
  }
> = {
  business_angel: {
    id: "business_angel",
    label: "Бизнес-ангел",
    description: "Команда, мотивация\nи первые продажи",
    quote: "«Кто уже готов\nвам заплатить?»",
    intro:
      "Спросит о клиентах, команде и первых продажах. Не примет предположение за факт.",
    image: "angel",
    color: "#b1ff91",
  },
  venture_fund: {
    id: "venture_fund",
    label: "Венчурный фонд",
    description: "Большой рынок\nи быстрый рост",
    quote: "«Как вы вырастете\nв десять раз?»",
    intro:
      "Проверит размер рынка, метрики роста и возможность масштабировать бизнес.",
    image: "venture",
    color: "#e8c6fa",
  },
  corporation: {
    id: "corporation",
    label: "Корпорация",
    description: "Пилот, интеграция\nи ценность для бизнеса",
    quote: "«Кто внутри компании\nкупит ваше решение?»",
    intro:
      "Спросит о внутреннем заказчике, интеграции и рисках для данных и репутации.",
    image: "corporation",
    color: "#9fc8ff",
  },
  grant_fund: {
    id: "grant_fund",
    label: "Грантовый фонд",
    description: "Выполнимый план\nи измеримый результат",
    quote: "«Что получите\nк концу проекта?»",
    intro: "Проверит смету, сроки, общественную пользу и измеримый результат.",
    image: "grant",
    color: "#ffc09e",
  },
};
export const criteria = [
  ["problem", "Проблема и решение"],
  ["business_model", "Бизнес-модель"],
  ["market", "Рынок и конкуренты"],
  ["financial_model", "Финансовая модель"],
  ["intellectual_property", "ИС / регистрация"],
  ["sales", "Первые продажи"],
  ["risks", "Риски"],
  ["horizon", "Горизонт расчёта"],
  ["uniqueness", "Уникальность продукта"],
  ["investment", "Инвестиционная привлекательность"],
].map(([id, label]) => ({ id, label }));
export const categories = [
  ["recession", "Рецессия"],
  ["copying", "Копирование конкурентом"],
  ["legal", "Юридические риски"],
  ["reviews", "Плохие отзывы"],
  ["price_war", "Ценовая война"],
  ["no_customers", "Отсутствие клиентов"],
  ["dependency", "Критическая зависимость"],
].map(([id, label]) => ({ id, label }));
export const stubConfig: Config = {
  personas: Object.values(personas).map(({ id, label }) => ({ id, label })),
  criteria,
  categories,
  question_count: 5,
  advice_count: 3,
  max_advice_days: 3,
  score_min: 0,
  score_max: 10,
  file_extensions: [".md", ".txt", ".pdf", ".pptx", ".docx"],
  max_files: 5,
  max_file_bytes: 10 * 1024 * 1024,
  max_input_chars: 50000,
  max_answer_chars: 6000,
  mode: "stub",
};
export const deadlines = [
  "Завтра",
  "Через 2–3 дня",
  "Через неделю",
  "Пока не знаю",
];
export const examplePitch =
  "Мы делаем Telegram-бота для небольших баров и кофеен.\nОн объединяет график смен, рецепты, стоп-лист и передачу смены.\n\nКлиент — управляющий заведения с командой 5–10 человек.\nПровели 6 интервью. Два бара согласились попробовать прототип.\nПланируем подписку 1 500 ₽ в месяц с заведения.\nПлатных клиентов пока нет.";
