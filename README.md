# Identifying Fake Reviews

A full-stack machine-learning application that classifies product reviews as **fake** or **genuine**, and detects coordinated review campaigns through graph-based burst analysis.

It combines a **RoBERTa + XGBoost** classifier served by a FastAPI backend with an interactive **React + Vite** dashboard for uploading datasets and exploring results.

---

## Features

- **Review classification** — labels each review as fake or genuine using RoBERTa sentence embeddings fed into a gradient-boosted XGBoost model.
- **Coordinated campaign detection** — graph/burst analysis flags products with suspicious clusters of reviews posted by the same users in short time windows.
- **Drag-and-drop dashboard** — upload CSV or Excel files; columns are auto-detected (review text, rating, category, user, timestamp, product id).
- **Live model loading** — the backend reports load progress so the UI never silently fails.
- **Visual insights** — confidence histograms, per-category breakdowns, a force-directed network graph, and a summary report.

---

## Tech stack

| Layer | Technology |
|---|---|
| Backend | Python, FastAPI, Uvicorn |
| ML | XGBoost, RoBERTa (`FacebookAI/roberta-base`) via Transformers, scikit-learn |
| Frontend | React 19, TypeScript, Vite, Recharts, D3 |
| Data parsing | PapaParse, SheetJS (xlsx) |

---

## Project structure

```
.
├── backend/
│   ├── api.py                     FastAPI inference service
│   ├── requirements.txt           Backend Python dependencies
│   └── XGBoost_RoBERTa_Model.pkl  Trained classifier
├── frontend/
│   ├── src/                       React app (App.tsx is the dashboard)
│   ├── .env.example               VITE_API_URL configuration
│   └── package.json
├── data/                          Datasets (see data/README.md)
├── notebooks/                     Training & validation notebooks
├── requirements.txt               Points to backend/requirements.txt
├── requirements-notebooks.txt     Extra deps for notebooks (pandas, jupyter…)
├── Makefile                       Install & run shortcuts
└── README.md
```

---

## Requirements

- **Python 3.10 – 3.12** (3.12 recommended; XGBoost wheels are unstable on 3.13/3.14)
- **Node.js 18+** and npm
- **OpenMP** — required by XGBoost on macOS: `brew install libomp`
- ~2 GB free disk for Python packages and the RoBERTa download on first run

---

## Quick start

```bash
# 1. System dependency (macOS, once)
brew install libomp

# 2. Install backend + frontend
make install

# 3. Configure the frontend API URL (optional — defaults to localhost:8000)
cp frontend/.env.example frontend/.env

# 4. Run everything with one command
make start
```

`make start` launches the API, waits for the model to finish loading, then starts the web app:

```
[5%]   Loading XGBoost_RoBERTa_Model.pkl…
[35%]  XGBoost model loaded
[40%]  Downloading/loading RoBERTa (first run may take 2–3 min)…
[100%] All models ready — starting frontend at http://localhost:5173
```

| Service | URL |
|---|---|
| Web app | http://localhost:5173 |
| API | http://localhost:8000 |

> The first launch downloads `FacebookAI/roberta-base` (~500 MB) from Hugging Face. Subsequent starts are fast.

---

## Usage

1. Open **http://localhost:5173**.
2. Drag in a CSV or Excel file containing a review-text column. Sample file: `data/fake reviews dataset.csv`.
3. Click **Run Analysis**. Reviews are classified and, if `user_id` / `timestamp` / `product_id` columns are present, burst analysis runs too.
4. Explore the overview, charts, network graph, and summary report.

### Recognized columns

| Field | Accepted column names |
|---|---|
| Review text *(required)* | `text_`, `text`, `review_text`, `review`, `content`, `body`, `comment` |
| Rating | `rating`, `stars`, `score`, `overall` |
| Category | `category`, `cat`, `product_category`, `type`, `genre` |
| User | `user_id`, `reviewer_id`, `author_id` |
| Timestamp | `timestamp`, `date`, `created_at`, `unixreviewtime` |
| Product | `parent_asin`, `product_id`, `asin`, `item_id` |

---

## Make targets

| Command | Description |
|---|---|
| `make install` | Install OpenMP, backend venv, and frontend packages |
| `make install-backend` | Create the Python 3.12 venv and install backend deps |
| `make install-frontend` | `npm install` in `frontend/` |
| `make start` | Run backend + frontend together (recommended) |
| `make backend` | Run only the API (with autoreload) |
| `make frontend` | Run only the web app |
| `make verify-model` | Smoke-test that the `.pkl` loads correctly |
| `make health` | Curl the API health endpoint |

---

## Configuration

| Variable | Location | Default | Purpose |
|---|---|---|---|
| `VITE_API_URL` | `frontend/.env` | `http://localhost:8000` | Backend base URL used by the dashboard |

---

## API

### `GET /health`
Returns model load status and progress.

```json
{ "status": "ok", "progress": 100, "model_loaded": true, "model": "XGBoost_RoBERTa_Model.pkl" }
```

### `POST /predict`
Classifies a batch of reviews.

```json
{
  "reviews": [
    { "text": "Great product, works perfectly!", "category": "Electronics_5", "rating": 5.0 }
  ]
}
```

Response — `label` is `0` for fake and `1` for genuine:

```json
{ "results": [ { "label": 1, "confidence": 0.9123 } ] }
```

---

## How it works

1. **Preprocessing** — text is expanded (contractions), stripped of punctuation, and normalized.
2. **Embeddings** — RoBERTa produces 768-dimensional sentence embeddings.
3. **Features** — embeddings are concatenated with the rating and a one-hot category vector (779 dims total).
4. **Classification** — an XGBoost model outputs a fake/genuine label and confidence.
5. **Graph analysis** *(frontend)* — reviews are grouped by user and product to surface burst clusters indicative of coordinated campaigns.

---

## Datasets

Small sample datasets live in `data/` and are tracked in git. The large `All_Beauty.jsonl` file is **not** committed (it exceeds GitHub's 100 MB limit). See `data/README.md` for details and download instructions.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| All reviews marked genuine / `Segmentation fault: 11` on start | Recreate the venv with Python 3.12: `rm -rf venv && make install-backend && make verify-model` |
| `XGBoost Library could not be loaded` / missing `libomp.dylib` | `brew install libomp` |
| `torch` install fails | Use Python 3.12 (`rm -rf venv && make install-backend`) |
| `No space left on device` during install | Free disk space (~2 GB needed), then retry |
| UI says the backend is unavailable | Run `make start` and wait for `All models ready` |
| First prediction is slow | RoBERTa loads on startup; the first batch warms the model |

