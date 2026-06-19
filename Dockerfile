# GeOSINT Workbench — self-contained container image.
#
#   docker build -t geosint .
#   docker run --rm -p 127.0.0.1:8650:8650 geosint   # open http://localhost:8650/app/
#
# Publish to host loopback (`-p 127.0.0.1:8650:8650`) unless you intend LAN
# access. The server binds 0.0.0.0 *inside the container* (so the published port
# is reachable); the Host-header allowlist + X-GeOSINT CSRF guard still apply
# (reach it via http://localhost:<port>/; use --allow-host for a direct IP/name).
# The container runs as a non-root user. Desktop tools (Google Earth Pro, QGIS)
# are GUI apps and are not present in a headless container — they degrade
# gracefully; ExifTool IS installed so EXIF/preview extraction works in-container.

FROM python:3.12-slim AS build

# ExifTool for the image-intelligence endpoints (the only runtime native dep).
RUN apt-get update \
 && apt-get install -y --no-install-recommends libimage-exiftool-perl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt ./
# mkdocs-material is build-time only (builds the wiki); kept in this layer.
RUN pip install --no-cache-dir -r requirements.txt

# Copy the source needed to build the wiki + indexes.
COPY wiki ./wiki
COPY tools ./tools
COPY data ./data
COPY app ./app
COPY server.py ./

# Build the wiki + search index at image-build time so the container starts ready.
# Data-refresh steps are best-effort (network may be unavailable during build).
RUN python tools/fetch_datasets.py || true \
 && python tools/build_flora.py || true \
 && mkdocs build -f wiki/mkdocs.yml \
 && python tools/build_search_index.py || true

# ── runtime image: drop the mkdocs toolchain, keep the built site ──
FROM python:3.12-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends libimage-exiftool-perl \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/app ./app
COPY --from=build /app/wiki/site ./wiki/site
COPY --from=build /app/data ./data
COPY --from=build /app/server.py ./server.py

# Run as a non-root user; give it ownership of the writable cache dir. ExifTool
# then parses attacker-supplied bytes without root in the container.
RUN useradd --system --uid 10001 --create-home geosint \
 && mkdir -p /app/cache \
 && chown -R geosint:geosint /app/cache
USER geosint

EXPOSE 8650
# Liveness probe via the cheap /api/health endpoint (no tool detection, exempt
# from the Host guard so probing the container's own address isn't a 403). Uses
# Python (already present) so we don't depend on curl being installed.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8650/api/health', timeout=4).status==200 else 1)"
# Bind 0.0.0.0 so the published port is reachable; no browser inside a container.
ENTRYPOINT ["python", "server.py", "--host", "0.0.0.0", "--no-browser"]
