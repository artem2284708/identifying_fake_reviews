.PHONY: install install-backend install-frontend install-system start backend frontend health wait-backend check-venv verify-model

PYTHON ?= python3.12
VENV   := venv
PIP    := $(VENV)/bin/pip
PY     := $(VENV)/bin/python
UVICORN := $(VENV)/bin/uvicorn
LIBOMP := /opt/homebrew/opt/libomp/lib
UVICORN_ENV := OMP_NUM_THREADS=1 TOKENIZERS_PARALLELISM=false DYLD_FALLBACK_LIBRARY_PATH="$(LIBOMP):$$DYLD_FALLBACK_LIBRARY_PATH"

install: install-system install-backend install-frontend

install-system:
	@test -f $(LIBOMP)/libomp.dylib || (echo "Installing OpenMP (required by XGBoost)..." && brew install libomp)

check-venv:
	@command -v $(PYTHON) >/dev/null 2>&1 || (echo "Install Python 3.12: brew install python@3.12" && exit 1)
	@if [ -x $(PY) ]; then \
		ver=$$($(PY) -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")'); \
		want=$$($(PYTHON) -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")'); \
		if [ "$$ver" != "$$want" ]; then \
			echo "venv uses Python $$ver but this project needs $$want."; \
			echo "Run: rm -rf venv && make install-backend"; \
			exit 1; \
		fi; \
	fi

install-backend:
	@command -v $(PYTHON) >/dev/null 2>&1 || (echo "Install Python 3.12: brew install python@3.12" && exit 1)
	@if [ -x $(PY) ]; then \
		ver=$$($(PY) -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")'); \
		want=$$($(PYTHON) -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")'); \
		if [ "$$ver" != "$$want" ]; then \
			echo "Removing venv (Python $$ver → need $$want)…"; \
			rm -rf $(VENV); \
		fi; \
	fi
	$(PYTHON) -m venv $(VENV)
	$(PIP) install --upgrade pip
	$(PIP) install -r requirements.txt

install-frontend:
	cd frontend && npm install

verify-model: check-venv
	@test -f $(LIBOMP)/libomp.dylib || (echo "Run: brew install libomp" && exit 1)
	@echo "Testing XGBoost_RoBERTa_Model.pkl load…"
	@cd backend && $(UVICORN_ENV) ../$(PY) -c "import joblib; from pathlib import Path; m=joblib.load(Path('XGBoost_RoBERTa_Model.pkl')); print('OK:', type(m).__name__)"

wait-backend:
	@echo "Loading models before starting website (watch [model] lines above)…"
	@i=0; last=""; while [ $$i -lt 180 ]; do \
		resp=$$(curl -sf http://localhost:8000/health 2>/dev/null || true); \
		if [ -n "$$resp" ]; then \
			ready=$$(printf '%s' "$$resp" | $(PY) -c "import sys,json; d=json.load(sys.stdin); print('yes' if d.get('model_loaded') else 'no')" 2>/dev/null || echo no); \
			status=$$(printf '%s' "$$resp" | $(PY) -c "import sys,json; d=json.load(sys.stdin); print(d.get('status',''))" 2>/dev/null || echo ""); \
			progress=$$(printf '%s' "$$resp" | $(PY) -c "import sys,json; d=json.load(sys.stdin); print(d.get('progress',0))" 2>/dev/null || echo 0); \
			msg=$$(printf '%s' "$$resp" | $(PY) -c "import sys,json; d=json.load(sys.stdin); print(d.get('message',''))" 2>/dev/null || echo ""); \
			[ "$$status" = error ] && echo "" && echo "Backend error: $$resp" && exit 1; \
			[ "$$ready" = yes ] && echo "" && echo "Model ready — starting frontend at http://localhost:5173" && exit 0; \
			line="[$${progress}%] $$msg"; \
		else \
			line="[…] Backend loading model (see [model] progress above)…"; \
		fi; \
		[ "$$line" != "$$last" ] && printf '%s\n' "$$line" && last="$$line"; \
		i=$$((i+1)); sleep 1; \
	done; \
	echo "Timed out waiting for model. Run: make verify-model"; exit 1

start: check-venv
	@test -x $(UVICORN) || (echo "Run 'make install-backend' first." && exit 1)
	@test -f $(LIBOMP)/libomp.dylib || (echo "XGBoost needs OpenMP. Run: brew install libomp" && exit 1)
	@echo "Starting backend (http://localhost:8000) + frontend..."
	@trap 'kill 0' INT TERM EXIT; \
	(cd backend && $(UVICORN_ENV) ../$(UVICORN) api:app --port 8000) & \
	$(MAKE) wait-backend && \
	cd frontend && npm run dev

backend: check-venv
	@test -x $(UVICORN) || (echo "Run 'make install-backend' first." && exit 1)
	@test -f $(LIBOMP)/libomp.dylib || (echo "XGBoost needs OpenMP. Run: brew install libomp" && exit 1)
	cd backend && $(UVICORN_ENV) ../$(UVICORN) api:app --reload --port 8000

frontend:
	cd frontend && npm run dev

health:
	@curl -sf http://localhost:8000/health && echo || (echo "Backend not running." && exit 1)
