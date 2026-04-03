@echo off
echo Starting NeMo Guardrails - Sourcing Validation Service
echo Port: 7779
echo.
cd /d %~dp0
pip install -r requirements.txt -q
python app.py
