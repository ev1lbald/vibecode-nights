export type PersonaId =
  "business_angel" | "venture_fund" | "corporation" | "grant_fund";
export type Question = { id: string; text: string; category_id: string | null };
export type Answer = { question_id: string; answer: string };
export type Criterion = {
  id: string;
  label: string;
  score: number | null;
  rationale: string;
};
export type Advice = {
  category_id: string;
  action: string;
  expected_result: string;
  estimated_days: number;
};
export type Session = {
  id: string;
  persona: PersonaId;
  status:
    "generating_questions" | "awaiting_answers" | "analyzing" | "completed";
  questions: Question[];
  assessment: {
    score: number | null;
    score_min: number;
    score_max: number;
    criteria: Criterion[];
  } | null;
  advice: Advice[];
  title: string;
  deadline: string;
  created_at: string;
  updated_at: string;
  answers: Answer[];
  pitch: string;
  files: string[];
  mode: "stub" | "live";
};
export type Config = {
  personas: { id: PersonaId; label: string }[];
  categories: { id: string; label: string }[];
  criteria: { id: string; label: string }[];
  question_count: number;
  advice_count: number;
  max_advice_days: number;
  score_min: number;
  score_max: number;
  file_extensions: string[];
  max_files: number;
  max_file_bytes: number;
  max_input_chars: number;
  max_answer_chars: number;
  mode: "stub" | "live";
};
