PY := python3
VENV := .venv
BIN := $(VENV)/bin
PORT ?= 8000
REPO ?= all

.PHONY: venv install dev models check doctor run test lint clean

venv:
	$(PY) -m venv $(VENV)

install: venv
	$(BIN)/pip install -U pip
	$(BIN)/pip install -r requirements.txt

dev: install
	$(BIN)/pip install -r requirements-dev.txt

models:
	$(BIN)/python scripts/download_models.py --repo=$(REPO)

check:
	$(BIN)/python scripts/download_models.py --check

doctor:
	$(BIN)/python scripts/doctor.py

run:
	$(BIN)/uvicorn app.main:app --host 127.0.0.1 --port $(PORT) --reload

test:
	$(BIN)/python -m pytest -q

lint:
	$(BIN)/python -m ruff check app tests scripts

clean:
	rm -rf $(VENV) tmp .pytest_cache .ruff_cache
	find . -name __pycache__ -type d -prune -exec rm -rf {} +