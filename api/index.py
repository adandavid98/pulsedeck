from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import os, json, re, uuid, base64, io

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class GenerateRequest(BaseModel):
    context: str
    prefs: dict = {}

class PDFRequest(BaseModel):
    pdf_base64: str

def _clean_json(raw: str) -> str:
    text = raw.strip()
    match = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", text)
    if match:
        return match.group(1).strip()
    return text

def _build_prompt(context: str, prefs: dict) -> str:
    count = prefs.get("count", 20)
    level = prefs.get("level", "Universitario")
    language = prefs.get("language", "Español")
    topic = prefs.get("topic", "General")
    extra = prefs.get("extra", "")
    return f"""Eres un experto en pedagogía y creación de material de estudio.
Genera exactamente {count} flashcards de alta calidad basadas en el siguiente material.

CONFIGURACIÓN:
- Nivel educativo: {level}
- Idioma de las tarjetas: {language}
- Tema principal: {topic}
{("- Instrucciones adicionales: " + extra) if extra else ""}

MATERIAL DE ESTUDIO:
{context[:30000]}

FORMATO DE RESPUESTA (JSON puro, sin markdown):
{{
  "cards": [
    {{
      "question": "pregunta clara, especifica y analitica",
      "answer": "respuesta concisa, completa y precisa",
      "topic": "subtema de la tarjeta",
      "tags": ["tag1", "tag2"]
    }}
  ]
}}

REGLAS:
- Genera EXACTAMENTE {count} tarjetas
- Responde SOLO con el JSON válido, sin ningún texto adicional."""

def _generate(prompt: str, api_key: str) -> list:
    from google import genai
    models = ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-1.5-flash", "gemini-2.5-pro"]
    client = genai.Client(api_key=api_key)
    last_err = None
    for model in models:
        try:
            resp = client.models.generate_content(model=model, contents=prompt)
            data = json.loads(_clean_json(resp.text))
            if isinstance(data, list):
                data = {"cards": data}
            cards = []
            for e in data.get("cards", []):
                q = str(e.get("question", "")).strip()
                a = str(e.get("answer", "")).strip()
                if q and a:
                    cards.append({
                        "id": uuid.uuid4().hex[:8],
                        "question": q,
                        "answer": a,
                        "topic": str(e.get("topic", "General")).strip(),
                        "tags": [str(t) for t in e.get("tags", [])[:5]] if isinstance(e.get("tags"), list) else []
                    })
            return cards
        except Exception as ex:
            last_err = ex
    raise RuntimeError(f"Error generando con IA: {last_err}")

@app.post("/api/generate")
async def generate_cards(req: GenerateRequest):
    context = req.context.strip()
    if not context:
        raise HTTPException(status_code=400, detail="No se proporcionó contenido.")
    api_key = os.environ.get("GOOGLE_API_KEY", "")
    if not api_key:
        raise HTTPException(status_code=500, detail="GOOGLE_API_KEY no configurada en Vercel.")
    cards = _generate(_build_prompt(context, req.prefs), api_key)
    return {"cards": cards, "count": len(cards)}

@app.post("/api/pdf")
async def extract_pdf(req: PDFRequest):
    if not req.pdf_base64:
        raise HTTPException(status_code=400, detail="No se recibió el PDF.")
    try:
        pdf_bytes = base64.b64decode(req.pdf_base64)
        from pypdf import PdfReader
        reader = PdfReader(io.BytesIO(pdf_bytes))
        pages_text = []
        for page in reader.pages[:40]:
            text = page.extract_text()
            if text and text.strip():
                pages_text.append(text.strip())
        full_text = "\n\n".join(pages_text)
        if not full_text.strip():
            raise HTTPException(status_code=400, detail="No se pudo extraer texto del PDF (podría ser imagen escaneada).")
        return {
            "text": full_text[:50000],
            "pages": len(reader.pages),
            "chars": len(full_text)
        }
    except HTTPException:
        raise
    except Exception as ex:
        raise HTTPException(status_code=500, detail=f"Error procesando PDF: {str(ex)}")
