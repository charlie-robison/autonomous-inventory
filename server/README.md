# Autonomous Inventory API

FastAPI backend for the Autonomous Inventory system.

## Setup

1. Create and activate a virtual environment:

```bash
cd server
python3 -m venv venv
source venv/bin/activate
```

2. Install dependencies:

```bash
pip install -r requirements.txt
```

3. Run the development server:

```bash
uvicorn app.main:app --reload
```

The API will be available at `http://127.0.0.1:8000`. Interactive docs are at `http://127.0.0.1:8000/docs`.
