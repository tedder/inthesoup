# Python 3.11, matching requirements.txt
FROM python:3.11-slim

ARG TARGETARCH
ARG SUPERCRONIC_VERSION=v0.2.51
ARG SUPERCRONIC_SHA1_AMD64=1692066e350a88ff4d7d6474fe3c7a6c41ec5e89
ARG SUPERCRONIC_SHA1_ARM64=9d4c2000493215a1898502b2fc2dada3e8ea8c7a

# git is needed to install arinc424 from GitHub (see requirements.txt).
# curl is used only to download supercronic (the scheduler used by scheduler.sh).
RUN apt-get update && apt-get install -y --no-install-recommends git curl ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && case "${TARGETARCH:-amd64}" in \
         amd64) SHA1="$SUPERCRONIC_SHA1_AMD64" ;; \
         arm64) SHA1="$SUPERCRONIC_SHA1_ARM64" ;; \
         *) echo "unsupported arch: $TARGETARCH" >&2; exit 1 ;; \
       esac \
    && curl -fsSL -o /usr/local/bin/supercronic \
         "https://github.com/aptible/supercronic/releases/download/${SUPERCRONIC_VERSION}/supercronic-linux-${TARGETARCH:-amd64}" \
    && echo "${SHA1}  /usr/local/bin/supercronic" | sha1sum -c - \
    && chmod +x /usr/local/bin/supercronic

# Output directory for self-hosting; owned by uid 1000 so a named volume mounted
# here is writable by a non-root user.
RUN mkdir /data && chown 1000:1000 /data

WORKDIR /app

# Install dependencies first so the layer is cached across code changes.
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY . ./

ENTRYPOINT ["python3", "-u"]
# With no arguments, do a safe download-and-parse check that writes nothing.
CMD ["load_weather.py", "--dry-run"]
