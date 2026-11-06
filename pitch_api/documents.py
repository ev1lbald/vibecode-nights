from dataclasses import dataclass
import hashlib
from io import BytesIO
import json
from pathlib import PurePosixPath
from zipfile import ZipFile

from docx import Document
from docx.table import Table
from fastapi import UploadFile
from pptx import Presentation
from pptx.enum.shapes import MSO_SHAPE_TYPE
from pypdf import PdfReader
from typing_extensions import TypedDict

from .config import Policy


FILE_EXTENSIONS = (".md", ".txt", ".pdf", ".pptx", ".docx")


class Source(TypedDict):
    name: str
    text: str


class InputError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status = status
        self.code = code


@dataclass
class UploadedSource:
    name: str
    extension: str
    data: bytes


def collect_uploads(pitch: str, files: list[UploadFile], policy: Policy) -> list[UploadedSource]:
    if len(files) > policy.max_files:
        raise InputError(413, "too_many_files", "Превышен лимит числа файлов.")
    if len(pitch) > policy.max_input_chars:
        raise InputError(413, "input_too_long", "Превышен лимит длины материалов.")
    if not pitch and not files:
        raise InputError(422, "missing_materials", "Введите питч или приложите файл.")

    uploads = []
    for file in files:
        filename = PurePosixPath((file.filename or "").replace("\\", "/")).name
        extension = PurePosixPath(filename).suffix.lower()
        if extension not in FILE_EXTENSIONS:
            raise InputError(415, "unsupported_file", f"Неподдерживаемый формат файла: {filename}.")
        data = file.file.read(policy.max_file_bytes + 1)
        if len(data) > policy.max_file_bytes:
            raise InputError(413, "file_too_large", f"Превышен лимит размера файла: {filename}.")
        uploads.append(UploadedSource(filename, extension, data))
    return uploads


def input_digest(persona: str, pitch: str, uploads: list[UploadedSource]) -> str:
    contents = [(file.name, hashlib.sha256(file.data).hexdigest()) for file in uploads]
    data = json.dumps([persona, pitch, contents], ensure_ascii=False)
    return hashlib.sha256(data.encode()).hexdigest()


def _slide_text(shapes):
    for shape in shapes:
        if shape.shape_type == MSO_SHAPE_TYPE.GROUP:
            yield from _slide_text(shape.shapes)
        if shape.has_text_frame:
            yield shape.text_frame.text
        if shape.has_table:
            for row in shape.table.rows:
                yield " | ".join(cell.text for cell in row.cells)


def _document_text(document):
    for block in document.iter_inner_content():
        if isinstance(block, Table):
            for row in block.rows:
                yield " | ".join("\n".join(_document_text(cell)) for cell in row.cells)
        else:
            yield block.text


def _extract(upload: UploadedSource, policy: Policy) -> str:
    data = upload.data
    if upload.extension in (".md", ".txt"):
        encoding = "utf-16" if data.startswith((b"\xff\xfe", b"\xfe\xff")) else "utf-8-sig"
        text = data.decode(encoding)
        if "\x00" in text:
            raise ValueError("Unexpected NUL byte")
        return text

    stream = BytesIO(data)
    if upload.extension == ".pdf":
        reader = PdfReader(stream)
        pages = ((index, page.extract_text()) for index, page in enumerate(reader.pages, 1))
        return "\n\n".join(f"[Страница {index}]\n{text}" for index, text in pages if text.strip())

    with ZipFile(stream) as archive:
        size = sum(entry.file_size for entry in archive.infolist())
    if size > policy.max_office_uncompressed_bytes:
        raise InputError(413, "file_too_large", f"Слишком большой распакованный файл: {upload.name}.")

    if upload.extension == ".docx":
        return "\n".join(_document_text(Document(stream)))

    slides = []
    for index, slide in enumerate(Presentation(stream).slides, 1):
        parts = list(_slide_text(slide.shapes))
        if slide.has_notes_slide and slide.notes_slide.notes_text_frame is not None:
            parts.append(slide.notes_slide.notes_text_frame.text)
        text = "\n".join(part for part in parts if part.strip())
        if text:
            slides.append(f"[Слайд {index}]\n{text}")
    return "\n\n".join(slides)


def extract_sources(pitch: str, uploads: list[UploadedSource], policy: Policy) -> list[Source]:
    sources: list[Source] = [{"name": "Питч", "text": pitch}] if pitch else []
    length = len(pitch)
    for upload in uploads:
        try:
            text = _extract(upload, policy).strip()
        except InputError:
            raise
        except Exception as error:
            raise InputError(422, "unreadable_file", f"Не удалось прочитать файл: {upload.name}.") from error
        if not text:
            raise InputError(422, "empty_file", f"В файле нет доступного текста: {upload.name}.")
        length += len(text)
        if length > policy.max_input_chars:
            raise InputError(413, "input_too_long", "Превышен суммарный лимит длины материалов.")
        sources.append({"name": upload.name, "text": text})
    return sources
