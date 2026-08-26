import http.server
import socketserver
import json
import urllib.request
import os

PORT = 5500
DIRECTORY = os.path.dirname(os.path.abspath(__file__))

# Puedes configurar tu API Key aquí o como variable de entorno
CEREBRAS_API_KEY = os.environ.get("CEREBRAS_API_KEY", "csk-jyh22cx6n4eh84ek94fjdwtj6935k5m2rj8k6xhrkrjw8w3k")
GOOGLE_API_KEY = os.environ.get("GOOGLE_API_KEY", os.environ.get("GEMINI_API_KEY", ""))

class PulseDeckHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

    def do_POST(self):
        if self.path == '/api/generate':
            content_length = int(self.headers.get('Content-Length', 0))
            body_data = self.rfile.read(content_length)
            
            try:
                payload = json.loads(body_data.decode('utf-8'))
                prompt = payload.get('prompt', '')
                engine = payload.get('engine', 'cerebras')
                
                # 1. MOTOR CEREBRAS CLOUD (LLaMA 3.3 70B · 1,800 tok/s)
                if engine == 'cerebras' or (not GOOGLE_API_KEY and CEREBRAS_API_KEY):
                    cerebras_key = CEREBRAS_API_KEY or os.environ.get("CEREBRAS_API_KEY", "")
                    url = "https://api.cerebras.ai/v1/chat/completions"
                    req_data = json.dumps({
                        "model": "llama-3.3-70b",
                        "messages": [
                            {"role": "system", "content": "Eres un profesor universitario experto en pedagogía. Responde ÚNICA Y EXCLUSIVAMENTE con un objeto JSON válido con la clave 'cards'."},
                            {"role": "user", "content": prompt}
                        ],
                        "response_format": {"type": "json_object"},
                        "temperature": 0.2,
                        "max_tokens": 4096
                    }).encode('utf-8')

                    req = urllib.request.Request(
                        url,
                        data=req_data,
                        headers={
                            "Content-Type": "application/json",
                            "Authorization": f"Bearer {cerebras_key}"
                        }
                    )
                    with urllib.request.urlopen(req, timeout=25) as resp:
                        data = json.loads(resp.read().decode('utf-8'))
                        raw_text = data["choices"][0]["message"]["content"]
                        parsed = json.loads(raw_text)

                        self.send_response(200)
                        self.send_header('Content-Type', 'application/json')
                        self.end_headers()
                        self.wfile.write(json.dumps(parsed).encode('utf-8'))
                        return

                # 2. MOTOR GOOGLE GEMINI FLASH
                api_key = GOOGLE_API_KEY or os.environ.get("GOOGLE_API_KEY", "")
                if not api_key:
                    self.send_response(500)
                    self.send_header('Content-Type', 'application/json')
                    self.end_headers()
                    self.wfile.write(json.dumps({
                        "error": "Clave API no configurada para el motor seleccionado."
                    }).encode('utf-8'))
                    return

                url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key={api_key}"
                req_data = json.dumps({
                    "contents": [{"parts": [{"text": prompt}]}],
                    "generationConfig": {"response_mime_type": "application/json"}
                }).encode('utf-8')

                req = urllib.request.Request(url, data=req_data, headers={"Content-Type": "application/json"})
                with urllib.request.urlopen(req, timeout=20) as resp:
                    data = json.loads(resp.read().decode('utf-8'))
                    raw_text = data["candidates"][0]["content"]["parts"][0]["text"]
                    parsed = json.loads(raw_text)

                    self.send_response(200)
                    self.send_header('Content-Type', 'application/json')
                    self.end_headers()
                    self.wfile.write(json.dumps(parsed).encode('utf-8'))
            except Exception as e:
                self.send_response(500)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({"error": str(e)}).encode('utf-8'))
        else:
            self.send_error(404, "Endpoint not found")

if __name__ == '__main__':
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("", PORT), PulseDeckHandler) as httpd:
        print(f"Servidor PulseDeck corriendo en http://localhost:{PORT}")
        httpd.serve_forever()
