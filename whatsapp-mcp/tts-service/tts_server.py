import os
import sys
import json
import subprocess
import tempfile
import threading
from http.server import HTTPServer, BaseHTTPRequestHandler

DIR = os.path.dirname(os.path.abspath(__file__))
VOICE_SAMPLE = os.path.join(DIR, "voice-sample.wav")
# Optional: put the transcript of your voice sample here for better quality.
# If missing, F5-TTS auto-transcribes via faster-whisper (slower first run).
VOICE_SAMPLE_TXT = os.path.join(DIR, "voice-sample.txt")
PORT = 5050

tts_instance = None
tts_lock = threading.Lock()
ref_text_cache = None


def load_model():
    global tts_instance
    try:
        from f5_tts.api import F5TTS
        import torch
        device = "cuda" if torch.cuda.is_available() else "cpu"
        print(f"[tts] loading F5-TTS model on {device.upper()}", flush=True)
        tts_instance = F5TTS(device=device)
        print("[tts] model ready", flush=True)
    except Exception as e:
        print(f"[tts] FATAL: could not load model: {e}", flush=True)
        sys.exit(1)


def get_ref_text():
    global ref_text_cache
    if ref_text_cache is not None:
        return ref_text_cache
    if os.path.exists(VOICE_SAMPLE_TXT):
        with open(VOICE_SAMPLE_TXT, "r", encoding="utf-8") as f:
            ref_text_cache = f.read().strip()
        print(f"[tts] loaded ref_text from file ({len(ref_text_cache)} chars)", flush=True)
    else:
        ref_text_cache = ""
        print("[tts] no voice-sample.txt found — will auto-transcribe on first synthesis", flush=True)
    return ref_text_cache


def wav_to_ogg(wav_path, ogg_path):
    result = subprocess.run(
        ["ffmpeg", "-y", "-i", wav_path, "-c:a", "libopus", "-b:a", "32k", ogg_path],
        capture_output=True
    )
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg failed: {result.stderr.decode()}")


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        print(f"[tts-http] {format % args}", flush=True)

    def do_GET(self):
        if self.path == "/health":
            ready = tts_instance is not None and os.path.exists(VOICE_SAMPLE)
            body = json.dumps({
                "ok": ready,
                "voice_sample": os.path.exists(VOICE_SAMPLE),
                "voice_sample_txt": os.path.exists(VOICE_SAMPLE_TXT),
                "model_loaded": tts_instance is not None
            }).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        if self.path != "/synthesize":
            self.send_response(404)
            self.end_headers()
            return

        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length)
        try:
            data = json.loads(body)
        except Exception:
            self.send_response(400)
            self.end_headers()
            return

        text = (data.get("text") or "").strip()
        if not text:
            self.send_response(400)
            self.end_headers()
            return

        if not os.path.exists(VOICE_SAMPLE):
            self.send_response(503)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": "voice-sample.wav not found — drop your recording into tts-service/"}).encode())
            return

        if tts_instance is None:
            self.send_response(503)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": "model still loading, try again in a moment"}).encode())
            return

        wav_fd, wav_path = tempfile.mkstemp(suffix=".wav")
        ogg_fd, ogg_path = tempfile.mkstemp(suffix=".ogg")
        os.close(wav_fd)
        os.close(ogg_fd)

        try:
            ref_text = get_ref_text()
            with tts_lock:
                print(f"[tts] synthesising {len(text)} chars", flush=True)
                import soundfile as sf
                wav, sr, _ = tts_instance.infer(
                    ref_file=VOICE_SAMPLE,
                    ref_text=ref_text,
                    gen_text=text,
                    file_wave=wav_path
                )

            wav_to_ogg(wav_path, ogg_path)

            with open(ogg_path, "rb") as f:
                audio = f.read()

            self.send_response(200)
            self.send_header("Content-Type", "audio/ogg")
            self.send_header("Content-Length", str(len(audio)))
            self.end_headers()
            self.wfile.write(audio)
            print(f"[tts] sent {len(audio)} bytes ogg", flush=True)
        except Exception as e:
            print(f"[tts] synthesis error: {e}", flush=True)
            self.send_response(500)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": str(e)}).encode())
        finally:
            for p in (wav_path, ogg_path):
                try:
                    os.unlink(p)
                except Exception:
                    pass


if __name__ == "__main__":
    load_thread = threading.Thread(target=load_model, daemon=True)
    load_thread.start()

    server = HTTPServer(("127.0.0.1", PORT), Handler)
    print(f"[tts] server on http://127.0.0.1:{PORT} — waiting for model...", flush=True)
    server.serve_forever()
