from http.server import BaseHTTPRequestHandler
import json, os, re, uuid


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
    return f"""Eres un experto en pedagogia y creacion de material de estudio.
Genera exactamente {count} flashcards de alta calidad basadas en el siguiente material.

CONFIGURACION:
- Nivel educativo: {level}
- Idioma de las tarjetas: {language}
- Tema principal: {topic}
{("- Instrucciones adicionales: " + extra) if extra else ""}

MATERIAL DE ESTUDIO:
{context[:30000]}

FORMATO DE RESPUESTA (JSON puro, sin markdown, sin texto adicional):
{{
  "cards": [
    {{
      "question": "pregunta clara, especifica y que estimule el pensamiento",
      "answer": "respuesta concisa, completa y precisa",
      "topic": "subtema especifico de la tarjeta",
      "tags": ["tag1", "tag2"]
    }}
  ]
}}

REGLAS:
- Genera EXACTAMENTE {count} tarjetas
- Responde SOLO con el JSON, sin ningun texto antes o despues
- Las preguntas deben ser variadas (definiciones, aplicaciones, comparaciones, ejemplos)
- Las respuestas deben ser completas pero concisas"""


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
    raise RuntimeError(f"Error generando: {last_err}")


class handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        self.send_response(200)
        self._cors()
        self.end_headers()

    def do_POST(self):
        try:
            length = int(self.headers.get("Content-Length", 0))
            data = json.loads(self.rfile.read(length))
            context = data.get("context", "").strip()
            prefs = data.get("prefs", {})
            if not context:
                return self._respond(400, {"error": "No se proporcionó contenido para generar flashcards."})
            api_key = os.environ.get("GOOGLE_API_KEY", "")
            if not api_key:
                return self._respond(500, {"error": "GOOGLE_API_KEY no configurada en el servidor."})
            cards = _generate(_build_prompt(context, prefs), api_key)
            self._respond(200, {"cards": cards, "count": len(cards)})
        except Exception as ex:
            self._respond(500, {"error": str(ex)})

    def _respond(self, status: int, data: dict):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def log_message(self, fmt, *args):
        pass
