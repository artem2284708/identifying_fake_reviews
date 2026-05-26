# api.py
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import joblib, re, contractions, numpy as np
from transformers import pipeline

app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

# Load once at startup
model = joblib.load("XGBoost_RoBERTa_Model.pkl")
extractor = pipeline("feature-extraction", framework="pt",
                     model="FacebookAI/roberta-base", device=-1)

def preprocess(text):
    text = contractions.fix(str(text))
    text = re.sub(r'[^\w\s]', '', text)
    text = re.sub(r'(?<!^)(?=[A-Z])', ' ', text)
    return re.sub(r'\s+', ' ', text).strip()

CATEGORIES = ['Beauty_5','Books_5','Clothing_Shoes_and_Jewelry_5',
              'Electronics_5','Home_and_Kitchen_5','Movies_and_TV_5',
              'Office_Products_5','Pet_Supplies_5',
              'Sports_and_Outdoors_5','Toys_and_Games_5']

class Review(BaseModel):
    text: str
    category: str = "Electronics_5"
    rating: float = 3.0

class BatchRequest(BaseModel):
    reviews: list[Review]

@app.post("/predict")
async def predict(req: BatchRequest):
    texts = [preprocess(r.text) for r in req.reviews]
    
    # RoBERTa embeddings
    embeddings = []
    for feat in extractor(texts, return_tensors="pt", truncation=True, batch_size=8):
        embeddings.append(feat[0].numpy().mean(axis=0))
    embeddings_np = np.array(embeddings)
    
    # One-hot category
    cat_encoded = np.array([
        [1.0 if r.category == c else 0.0 for c in CATEGORIES]
        for r in req.reviews
    ])
    
    # Rating
    ratings = np.array([[r.rating] for r in req.reviews])
    
    # Combine → 779-dim
    combined = np.concatenate([cat_encoded, ratings, embeddings_np], axis=1)
    
    preds  = model.predict(combined).tolist()
    probas = model.predict_proba(combined).tolist()
    
    return {"results": [
        {"label": int(p), "confidence": round(max(prob), 4)}
        for p, prob in zip(preds, probas)
    ]}