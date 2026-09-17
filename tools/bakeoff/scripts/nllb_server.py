#!/usr/bin/env python3
"""Minimal NLLB-200 inference server for the Phase 0b bake-off.

This exists to answer one question eight weeks before it would otherwise come
up (PLAN.md §8): if self-hosted MT clears the same bar as the on-device path,
the Telegram bot is roughly free at the margin and Phase 3 is viable. If it
doesn't, the bot is a paid cloud product and needs a decision it has never
been given.

NLLB rather than Opus-MT on purpose: one multilingual model handles an
arbitrary language mix directly, where per-pair models mean preloading a matrix
or eating cold starts — and arbitrary mixes are the bot's whole premise.

Budget one to two days for this if you haven't done it before: model download,
Python env, tokenizer setup, a working loop. It is not an afternoon.

    pip install transformers torch flask sentencepiece
    python nllb_server.py

Then: bakeoff run corpus.jsonl selfhosted
"""

from __future__ import annotations

import logging

from flask import Flask, jsonify, request
from transformers import AutoModelForSeq2SeqLM, AutoTokenizer

MODEL = "facebook/nllb-200-distilled-600M"

# NLLB uses FLORES-200 codes, not ISO 639-1. Extend as your channels need.
FLORES = {
    "en": "eng_Latn",
    "es": "spa_Latn",
    "pt": "por_Latn",
    "fr": "fra_Latn",
    "de": "deu_Latn",
    "it": "ita_Latn",
    "ar": "arb_Arab",
    "fa": "pes_Arab",
    "he": "heb_Hebr",
    "ru": "rus_Cyrl",
    "tr": "tur_Latn",
    "hi": "hin_Deva",
    "zh": "zho_Hans",
    "ja": "jpn_Jpan",
    "ko": "kor_Hang",
}

app = Flask(__name__)
log = logging.getLogger("nllb")

print(f"loading {MODEL} (first run downloads ~2.5GB) ...")
tokenizer = AutoTokenizer.from_pretrained(MODEL)
model = AutoModelForSeq2SeqLM.from_pretrained(MODEL)
print("ready on http://127.0.0.1:8765")


@app.post("/translate")
def translate():
    body = request.get_json(force=True)
    text = body.get("text", "")
    source = FLORES.get(body.get("source", ""))
    target = FLORES.get(body.get("target", "en"))

    if not source or not target:
        return jsonify(error=f"unmapped language pair {body.get('source')}->{body.get('target')}"), 400
    if not text.strip():
        return jsonify(translation="")

    tokenizer.src_lang = source
    encoded = tokenizer(text, return_tensors="pt")
    generated = model.generate(
        **encoded,
        forced_bos_token_id=tokenizer.convert_tokens_to_ids(target),
        max_new_tokens=256,
    )
    out = tokenizer.batch_decode(generated, skip_special_tokens=True)[0]
    return jsonify(translation=out)


@app.get("/health")
def health():
    return jsonify(ok=True, model=MODEL, languages=sorted(FLORES))


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=8765)
