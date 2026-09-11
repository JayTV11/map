"""Loads config.yaml and layers environment-variable overrides on top.

Secrets (the Elastic API key) are never read from config.yaml itself --
set ELASTIC_API_KEY in the environment (or a backend/.env file, copied
from .env.example) instead of committing it.
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import yaml
from dotenv import load_dotenv

load_dotenv()

CONFIG_PATH = Path(__file__).resolve().parent.parent / "config.yaml"


def load_config() -> dict[str, Any]:
    with open(CONFIG_PATH, "r") as f:
        cfg = yaml.safe_load(f)

    cfg.setdefault("elastic", {})
    cfg["elastic"]["api_key"] = os.environ.get("ELASTIC_API_KEY", cfg["elastic"].get("api_key", ""))
    return cfg


config = load_config()
