#!/usr/bin/env bash
set -euo pipefail

REPO="EasyPoolPearl/pearlpool"
BINARY="pearlpool"
INSTALL_DIR="${INSTALL_DIR:-.}"

# Detect platform
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64) ARCH="x86_64" ;;
  aarch64|arm64) ARCH="aarch64" ;;
  *) echo "Unsupported architecture: $ARCH"; exit 1 ;;
esac

case "$OS" in
  linux) PLATFORM="linux" ;;
  darwin) PLATFORM="darwin" ;;
  *) echo "Unsupported OS: $OS"; exit 1 ;;
esac

ASSET="${BINARY}-${PLATFORM}-${ARCH}"
if [ "$PLATFORM" = "windows" ]; then
  ASSET="${ASSET}.exe"
fi

echo "PearlPool Installer"
echo "==================="
echo "Platform: ${PLATFORM}/${ARCH}"
echo ""

# Get latest release tag
echo "Fetching latest release..."
TAG=$(curl -sf "https://api.github.com/repos/${REPO}/releases/latest" | grep '"tag_name"' | sed -E 's/.*"tag_name": *"([^"]+)".*/\1/')
if [ -z "$TAG" ]; then
  echo "Error: Could not determine latest release."
  exit 1
fi
echo "Latest version: ${TAG}"
echo ""

BASE_URL="https://github.com/${REPO}/releases/download/${TAG}"

# Download binary
echo "Downloading ${ASSET}..."
curl -sfL "${BASE_URL}/${ASSET}" -o "${INSTALL_DIR}/${BINARY}"

# Download checksums
echo "Downloading checksums..."
curl -sfL "${BASE_URL}/SHA256SUMS" -o "${INSTALL_DIR}/SHA256SUMS"

# Verify checksum
echo "Verifying checksum..."
EXPECTED=$(grep "${ASSET}" "${INSTALL_DIR}/SHA256SUMS" | awk '{print $1}')
ACTUAL=$(sha256sum "${INSTALL_DIR}/${BINARY}" | awk '{print $1}')

if [ "$EXPECTED" != "$ACTUAL" ]; then
  echo "Error: Checksum mismatch!"
  echo "  Expected: $EXPECTED"
  echo "  Got:      $ACTUAL"
  rm -f "${INSTALL_DIR}/${BINARY}" "${INSTALL_DIR}/SHA256SUMS"
  exit 1
fi
echo "Checksum verified."

# Make executable
chmod +x "${INSTALL_DIR}/${BINARY}"

# Clean up
rm -f "${INSTALL_DIR}/SHA256SUMS"

echo ""
echo "Installation complete!"
echo ""
echo "Usage:"
echo "  ${INSTALL_DIR}/${BINARY} --wallet prl1pYOUR_WALLET_ADDRESS"
echo ""
echo "Options:"
echo "  --port       Stratum port (default: 3333)"
echo "  --api-port   API/dashboard port (default: 8080)"
echo "  --rpc-url    PRL node RPC URL (default: http://127.0.0.1:11332)"
echo "  --fee        Pool fee % (default: 1.0)"
echo "  --min-payout Minimum payout in PRL (default: 0.1)"
echo ""
echo "Dashboard will be available at http://localhost:8080"
