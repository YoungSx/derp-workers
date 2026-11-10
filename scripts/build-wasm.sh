#!/usr/bin/env bash
set -euo pipefail

mkdir -p artifacts src
ldflags=()
if [[ -n "${DERP_SERVER_KEY:-}" ]]; then
	[[ ${#DERP_SERVER_KEY} == 64 && ! $(echo "$DERP_SERVER_KEY" | tr -d '0-9a-fA-F') ]] \
		|| { echo "DERP_SERVER_KEY must be 64 hex chars (node private key)" >&2; exit 1; }
	ldflags+=("-X" "main.serverKeyHex=$DERP_SERVER_KEY")
	echo "building with an injected server key"
else
	echo "WARNING: building with the deterministic TEST key; do not deploy this build" >&2
fi
{
	printf '$ go version\n'
	go version
	printf '$ GOOS=js GOARCH=wasm go build -trimpath %s -o artifacts/derp.wasm ./cmd/derp-wasm\n' "${ldflags[*]+${ldflags[*]}}"
	GOOS=js GOARCH=wasm go build -trimpath ${ldflags[@]+"${ldflags[@]}"} -o artifacts/derp.wasm ./cmd/derp-wasm
} 2>&1 | tee artifacts/wasm-build.log
install -m 644 "$(go env GOROOT)/lib/wasm/wasm_exec.js" src/wasm_exec.js
