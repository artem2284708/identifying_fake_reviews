# api.py
from contextlib import asynccontextmanager
from pathlib import Path

import contractions
import joblib
import numpy as np
import re
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from transformers import pipeline

MODEL_PATH = Path(__file__).resolve().parent / "XGBoost_RoBERTa_Model.pkl"

model = None
extractor = None
load_error = None
load_state = {
    "status": "loading",
    "stage": "starting",
    "progress": 0,
    "message": "Starting backend…",
    "model_loaded": False,
    "detail": None,
}


def _set_load_state(**kwargs):
    load_state.update(kwargs)
    print(f"[model] {load_state['progress']:>3}% — {load_state['message']}", flush=True)


def _load_models():
    global model, extractor, load_error

    try:
        _set_load_state(stage="loading_pkl", progress=5, message=f"Loading {MODEL_PATH.name}…")

        if not MODEL_PATH.exists():
            raise FileNotFoundError(f"Model file not found: {MODEL_PATH}")

        loaded_model = joblib.load(MODEL_PATH)
        _set_load_state(stage="loading_pkl", progress=35, message="XGBoost model loaded")

        _set_load_state(
            stage="loading_roberta",
            progress=40,
            message="Downloading/loading RoBERTa (first run may take 2–3 min)…",
        )
        loaded_extractor = pipeline(
            "feature-extraction",
            framework="pt",
            model="FacebookAI/roberta-base",
            device=-1,
        )

        model = loaded_model
        extractor = loaded_extractor
        load_error = None
        _set_load_state(
            status="ok",
            stage="ready",
            progress=100,
            message="All models ready",
            model_loaded=True,
            detail=None,
        )
    except Exception as exc:
        load_error = str(exc)
        model = None
        extractor = None
        _set_load_state(
            status="error",
            stage="error",
            progress=0,
            message="Model load failed",
            model_loaded=False,
            detail=str(exc),
        )


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Load on the main thread — XGBoost can segfault when unpickled in a worker thread.
    _load_models()
    yield


app = FastAPI(lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

CATEGORIES = [
    "Beauty_5", "Books_5", "Clothing_Shoes_and_Jewelry_5",
    "Electronics_5", "Home_and_Kitchen_5", "Movies_and_TV_5",
    "Office_Products_5", "Pet_Supplies_5",
    "Sports_and_Outdoors_5", "Toys_and_Games_5",
]


def preprocess(text):
    text = contractions.fix(str(text))
    text = re.sub(r"[^\w\s]", "", text)
    text = re.sub(r"(?<!^)(?=[A-Z])", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def normalize_category(category: str) -> str:
    category = str(category or "").strip()
    return category if category in CATEGORIES else "Electronics_5"


class Review(BaseModel):
    text: str
    category: str = "Electronics_5"
    rating: float = 3.0


class BatchRequest(BaseModel):
    reviews: list[Review]


@app.get("/")
async def root():
    return {
        "service": "Fake Review Detection API",
        "website": "http://localhost:5173",
        "health": "/health",
        "predict": "POST /predict",
        "note": "Open the website URL in your browser — not this API port.",
    }


@app.get("/health")
async def health():
    return {
        "status": load_state["status"],
        "stage": load_state["stage"],
        "progress": load_state["progress"],
        "message": load_state["message"],
        "model_loaded": load_state["model_loaded"],
        "model": MODEL_PATH.name if load_state["model_loaded"] else None,
        "detail": load_state["detail"],
    }


@app.post("/predict")
async def predict(req: BatchRequest):
    if load_error:
        raise HTTPException(status_code=503, detail=f"Model failed to load: {load_error}")
    if model is None or extractor is None:
        raise HTTPException(
            status_code=503,
            detail=f"Model is still loading ({load_state['progress']}%): {load_state['message']}",
        )

    texts = [preprocess(r.text) for r in req.reviews]

    embeddings = []
    for feat in extractor(texts, return_tensors="pt", truncation=True, batch_size=8):
        embeddings.append(feat[0].numpy().mean(axis=0))
    embeddings_np = np.array(embeddings)

    cat_encoded = np.array([
        [1.0 if normalize_category(r.category) == c else 0.0 for c in CATEGORIES]
        for r in req.reviews
    ])

    ratings = np.array([[float(r.rating)] for r in req.reviews])
    combined = np.concatenate([cat_encoded, ratings, embeddings_np], axis=1)

    preds = model.predict(combined).tolist()
    probas = model.predict_proba(combined).tolist()

    return {
        "results": [
            {"label": int(p), "confidence": round(max(prob), 4)}
            for p, prob in zip(preds, probas)
        ]
    }
