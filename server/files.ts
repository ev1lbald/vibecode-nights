import path from "node:path";
import { Worker } from "node:worker_threads";
import { ApiError } from "./agents";
import { stubConfig } from "../shared/catalog";

// Extraction runs in a bounded worker, so malformed archives/PDFs cannot block the web process.
export async function extractFile(file: Express.Multer.File): Promise<string> {
  const ext = path.extname(file.originalname).toLowerCase();
  if (!stubConfig.file_extensions.includes(ext))
    throw new ApiError(
      415,
      "unsupported_file",
      "Поддерживаются TXT, MD, PDF, PPTX и DOCX.",
    );
  if (ext === ".txt" || ext === ".md")
    return file.buffer.toString("utf8").replace(/\u0000/g, "");
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL("./extract-worker.mjs", import.meta.url),
      {
        execArgv: [],
        workerData: { ext, bytes: file.buffer },
        resourceLimits: { maxOldGenerationSizeMb: 192 },
      },
    );
    let finished = false;
    const end = (err: Error | null, text?: string) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      void worker.terminate();
      err ? reject(err) : resolve(text ?? "");
    };
    const timer = setTimeout(
      () =>
        end(
          new ApiError(
            422,
            "unreadable_file",
            "Файл слишком сложный для чтения. Экспортируй текст или вставь описание вручную.",
          ),
        ),
      15000,
    );
    worker.once("message", (m) =>
      m.error
        ? end(
            new ApiError(
              422,
              "unreadable_file",
              "Не удалось прочитать файл. Проверь, что он не повреждён и содержит текст.",
            ),
          )
        : end(null, m.text),
    );
    worker.once("error", () =>
      end(
        new ApiError(
          422,
          "unreadable_file",
          "Не удалось прочитать файл. Попробуй другой формат.",
        ),
      ),
    );
    worker.once("exit", (code) => {
      if (!finished)
        end(
          new ApiError(
            422,
            "unreadable_file",
            `Не удалось обработать файл (${code}).`,
          ),
        );
    });
  });
}
