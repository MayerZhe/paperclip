# Alpine rootfs for AgentHubs VM
# Produces a minimal VM root filesystem with:
#   - Node.js 22, npm, bash, zstd, dropbear (SSH)
#   - OpenRC init system
#   - sdk-daemon (Go binary, copied from vm-guest-agent/bin/)
#   - MinIO (Go binary, downloaded)
#   - cloud-api (Node.js project, copied from agenthubs/cloud-api)
#   - paperclip (Node.js project, copied from paperclip/server)
#
# Build:
#   docker build -t agenthubs-rootfs .
# Export:
#   docker create --name tmp-rootfs agenthubs-rootfs
#   docker export tmp-rootfs -o rootfs.tar
#   docker rm tmp-rootfs

FROM alpine:3.21

# Install base system packages
RUN apk add --no-cache \
    nodejs~=22 \
    npm \
    bash \
    zstd \
    dropbear \
    openrc \
    e2fsprogs \
    wget \
    ca-certificates

# ─── sdk-daemon (Go binary) ───
# Must be built before running this Dockerfile:
#   cd apps/desktop/vm-guest-agent && \
#     GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build -ldflags "-s -w" -o bin/sdk-daemon ./cmd/sdk-daemon/
COPY sdk-daemon /usr/local/bin/sdk-daemon
RUN chmod +x /usr/local/bin/sdk-daemon

# ─── MinIO ───
# Download as a single Go binary (not a Docker container)
ARG TARGETARCH=arm64
RUN ARCH=$(echo "${TARGETARCH}" | sed 's/amd64/x86_64/;s/arm64/arm64/') && \
    wget -q "https://dl.min.io/server/minio/release/linux-${ARCH}/minio" -O /usr/local/bin/minio && \
    chmod +x /usr/local/bin/minio

# ─── cloud-api ───
# Copy from agenthubs/cloud-api (must exist at build time)
COPY cloud-api /opt/cloud-api
WORKDIR /opt/cloud-api
RUN npm install --omit=dev && npm cache clean --force

# ─── paperclip ───
# Copy from paperclip server (must exist at build time)
COPY paperclip-server /opt/paperclip
WORKDIR /opt/paperclip
RUN npm install --omit=dev && npm cache clean --force

# ─── Data directories ───
RUN mkdir -p /data/minio /data/cloud-api /data/paperclip /var/log/services

# ─── sdk-daemon config ───
RUN mkdir -p /etc/sdk-daemon
COPY sdk-daemon-config.json /etc/sdk-daemon/config.json

# ─── OpenRC services ───
COPY services/ /etc/init.d/
RUN chmod +x /etc/init.d/* && \
    rc-update add sdk-daemon default && \
    rc-update add cloud-api default && \
    rc-update add paperclip default && \
    rc-update add minio default && \
    rc-update add dropbear default

# ─── Cleanup ───
RUN rm -rf /var/cache/apk/* /tmp/* /root/.npm

# Note: sdk-daemon must start AFTER network is up.
# OpenRC handles ordering via `need net` in the init script.

CMD ["/sbin/init"]
