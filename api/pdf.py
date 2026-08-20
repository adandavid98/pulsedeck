from http.server import BaseHTTPRequestHandler
import json, base64, io


class handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        self.send_response(200)
        self._cors()
        self.end_headers()

    def do_POST(self):
        try:
            length = int(self.headers.get("Content-Length", 0))
            data = json.loads(self.rfile.read(length))
            pdf_b64 = data.get("pdf_base64", "")
            if not pdf_b64:
                return self._respond(400, {"error": "No se recibio el archivo PDF."})
            pdf_bytes = base64.b64decode(pdf_b64)
            from pypdf import PdfReader
            reader = PdfReader(io.BytesIO(pdf_bytes))
            pages_text = []
            for page in reader.pages[:40]:
                text = page.extract_text()
                if text and text.strip():
                    pages_text.append(text.strip())
            full_text = "\n\n".join(pages_text)
            if not full_text.strip():
                return self._respond(400, {"error": "No se pudo extraer texto del PDF. El archivo puede ser una imagen escaneada."})
            self._respond(200, {
                "text": full_text[:50000],
                "pages": len(reader.pages),
                "chars": len(full_text)
            })
        except Exception as ex:
            self._respond(500, {"error": f"Error procesando PDF: {str(ex)}"})

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
