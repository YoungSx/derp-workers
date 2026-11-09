#!/usr/bin/env bash
set -euo pipefail

mkdir -p artifacts src
{
	printf '$ go version\n'
	go version
	printf '$ GOOS=js GOARCH=wasm go build -trimpath -o artifacts/derp.wasm ./cmd/derp-wasm\n'
	GOOS=js GOARCH=wasm go build -trimpath -o artifacts/derp.wasm ./cmd/derp-wasm
} 2>&1 | tee artifacts/wasm-build.log
install -m 644 "$(go env GOROOT)/lib/wasm/wasm_exec.js" src/wasm_exec.js
