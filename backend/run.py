"""Local entrypoint: starts the server and opens your browser to it.

This is a local-only tool -- it binds to config.yaml's server.host
(127.0.0.1 by default), not 0.0.0.0, so it isn't exposed to your network.
"""
import threading
import webbrowser

import uvicorn

from app.config import config

if __name__ == "__main__":
    host = config["server"]["host"]
    port = config["server"]["port"]

    threading.Timer(1.0, lambda: webbrowser.open(f"http://{host}:{port}")).start()
    uvicorn.run("app.main:app", host=host, port=port, reload=False)
