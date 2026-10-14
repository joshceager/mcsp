# MCSP backend: FastAPI + its managed Minecraft server in ONE container.
# The backend supervises the JVM directly (child process), so a single
# container is all that's needed — no docker socket, no privileged mode.
FROM eclipse-temurin:21-jre AS runtime

# uvicorn + fastapi + httpx + sse-starlette + pydantic (from requirements.txt)
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 python3-pip python3-venv curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY backend/requirements.txt /app/backend/requirements.txt
RUN python3 -m pip install --no-cache-dir --break-system-packages -r /app/backend/requirements.txt

COPY backend/app /app/backend/app

# Data lives OUTSIDE the image: bind-mount a host dir to /data.
# (User requirement: bind mounts only, never named volumes.)
ENV MCSP_DATA_DIR=/data \
    MCSP_API_HOST=0.0.0.0 \
    MCSP_API_PORT=8080 \
    PYTHONUNBUFFERED=1

VOLUME /data
EXPOSE 8080 25565

CMD ["python3", "-m", "uvicorn", "backend.app.main:create_app", \
     "--factory", "--host", "0.0.0.0", "--port", "8080", "--app-dir", "/app"]
