import json
import os
from http.server import BaseHTTPRequestHandler, HTTPServer
from difflib import SequenceMatcher
import re

DB_FILE = 'question_bank.json'

def load_db():
    if os.path.exists(DB_FILE):
        with open(DB_FILE, 'r', encoding='utf-8') as f:
            try:
                return json.load(f)
            except:
                return {}
    return {}

def save_db(db):
    with open(DB_FILE, 'w', encoding='utf-8') as f:
        json.dump(db, f, ensure_ascii=False, indent=2)

def clean_text(text):
    """去掉空白符和标点，只保留汉字+字母+数字，用于相似度比较"""
    return re.sub(r'[\s\W]', '', text, flags=re.UNICODE)

def fuzzy_find(question_text, db, threshold=0.75):
    """
    在题库中找最相似的题目。
    策略：精确匹配 → SequenceMatcher模糊匹配 → 关键片段包含
    返回 (best_key, score) 或 (None, 0.0)
    """
    # 1. 精确匹配
    if question_text in db:
        return question_text, 1.0

    q_clean = clean_text(question_text)
    best_key = None
    best_score = 0.0

    for key in db:
        k_clean = clean_text(key)
        ratio = SequenceMatcher(None, q_clean, k_clean).ratio()
        if ratio > best_score:
            best_score = ratio
            best_key = key

    # 2. 关键片段包含（取前15个有效字符）
    if best_score < threshold:
        snippet = q_clean[:15]
        if len(snippet) >= 8:
            for key in db:
                if snippet in clean_text(key):
                    return key, 0.85

    if best_score >= threshold:
        return best_key, best_score
    return None, 0.0


class AnserHandler(BaseHTTPRequestHandler):

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def do_POST(self):
        content_length = int(self.headers.get('Content-Length', 0))
        post_data = self.rfile.read(content_length)
        try:
            data = json.loads(post_data.decode('utf-8'))
        except:
            data = {}

        if self.path == '/api/save_answer':
            question_text = data.get('question_text', '').strip()
            answer = data.get('answer', '').strip()
            if question_text and answer:
                db = load_db()
                db[question_text] = answer
                save_db(db)
                self.send_json_response({"status": "success", "message": "Saved"})
            else:
                self.send_json_response({"error": "invalid data"}, 400)

        elif self.path == '/api/get_answer':
            question_text = data.get('question_text', '').strip()
            if not question_text:
                self.send_json_response({"error": "question_text is required"}, 400)
                return

            db = load_db()
            matched_key, score = fuzzy_find(question_text, db)

            if matched_key:
                print(f"[命中 {score:.0%}] {question_text[:25]}...")
                self.send_json_response({
                    "source": "local_db",
                    "answer": db[matched_key],
                    "score": round(score, 2)
                })
            else:
                print(f"[未命中] {question_text[:25]}...")
                self.send_json_response({
                    "source": "ai_model",
                    "answer": "未收录该题。"
                })
        else:
            self.send_json_response({"error": "Not found"}, 404)

    def send_json_response(self, data, status_code=200):
        self.send_response(status_code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(json.dumps(data, ensure_ascii=False).encode('utf-8'))

    def log_message(self, format, *args):
        pass  # 关闭默认请求日志

if __name__ == '__main__':
    port = 5000
    server_address = ('127.0.0.1', port)
    httpd = HTTPServer(server_address, AnserHandler)
    print(f"Anser 本地后端已启动: http://127.0.0.1:{port}")
    print(f"题库文件: {os.path.abspath(DB_FILE)}  (共 {len(load_db())} 题)")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    httpd.server_close()
    print("Server stopped.")
