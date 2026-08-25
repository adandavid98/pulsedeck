import http.server
import socketserver
import json
import urllib.request
import os

PORT = 5500
DIRECTORY = os.path.dirname(os.path.abspath(__file__))

# Puedes configurar tu API Key aquí o como variable de entorno
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
                topic = payload.get('topic', 'General')
                count = payload.get('count', 15)

                api_key = GOOGLE_API_KEY or os.environ.get("GOOGLE_API_KEY", "")
                if not api_key:
                    self.send_response(500)
                    self.send_header('Content-Type', 'application/json')
                    self.end_headers()
                    self.wfile.write(json.dumps({
                        "error": "GOOGLE_API_KEY no configurada. Si estás en local, defínela con $env:GOOGLE_API_KEY='tu_clave' o pruébalo directamente en Vercel."
                    }).encode('utf-8'))
                    return

                # Llamar a Google Gemini
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
