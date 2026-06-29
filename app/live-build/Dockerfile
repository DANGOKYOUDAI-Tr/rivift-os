FROM debian:bookworm-slim

# Install live-build and build tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    live-build \
    ca-certificates \
    curl \
    dpkg-dev \
    rsync \
    sudo \
    xorriso \
    isolinux \
    syslinux-utils \
    cpio \
    unzip \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

COPY build-iso.sh /build-iso.sh
RUN chmod +x /build-iso.sh

ENTRYPOINT ["/build-iso.sh"]
