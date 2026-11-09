//go:build js && wasm

package main

import (
	"bufio"
	"context"
	"fmt"
	"runtime"
	"sync"
	"syscall/js"

	"go4.org/mem"
	"tailscale.com/derp"
	"tailscale.com/derp/derpserver"
	"tailscale.com/types/key"
)

func main() {
	// This deterministic key only proves server construction in the local PoC.
	const serverKeyHex = "0101010101010101010101010101010101010101010101010101010101010101"
	privateKey, err := key.ParseNodePrivateUntyped(mem.S(serverKeyHex))
	if err != nil {
		panic(err)
	}
	server := derpserver.New(privateKey, func(format string, args ...any) {
		fmt.Printf(format+"\n", args...)
	})
	connections := map[string]*workerConn{}
	var connectionsMu sync.Mutex
	register := func(name string, fn func(js.Value, []js.Value) any) {
		js.Global().Set(name, js.FuncOf(fn))
	}
	register("derpSocketOpen", func(_ js.Value, args []js.Value) any {
		if len(args) != 2 {
			return false
		}
		id, remoteAddr := args[0].String(), args[1].String()
		conn := newWorkerConn(id)
		connectionsMu.Lock()
		connections[id] = conn
		connectionsMu.Unlock()
		go func() {
			reader := bufio.NewReaderSize(conn, 1024)
			server.Accept(context.Background(), conn, &bufio.ReadWriter{Reader: reader}, remoteAddr)
			connectionsMu.Lock()
			delete(connections, id)
			connectionsMu.Unlock()
		}()
		return true
	})
	register("derpSocketRead", func(_ js.Value, args []js.Value) any {
		if len(args) != 2 || args[1].Type() != js.TypeObject {
			return false
		}
		id := args[0].String()
		data := js.Global().Get("Uint8Array").New(args[1])
		payload := make([]byte, data.Get("byteLength").Int())
		if n := js.CopyBytesToGo(payload, data); n != len(payload) {
			return false
		}
		connectionsMu.Lock()
		conn := connections[id]
		connectionsMu.Unlock()
		if conn == nil || len(payload) > derp.MaxPacketSize+1024 {
			return false
		}
		return conn.enqueue(payload)
	})
	register("derpSocketClose", func(_ js.Value, args []js.Value) any {
		if len(args) == 1 {
			connectionsMu.Lock()
			conn := connections[args[0].String()]
			connectionsMu.Unlock()
			if conn != nil {
				conn.close(false)
			}
		}
		return nil
	})
	register("derpServerConnectionCount", func(_ js.Value, _ []js.Value) any {
		connectionsMu.Lock()
		defer connectionsMu.Unlock()
		return len(connections)
	})
	register("derpServerMemStats", func(_ js.Value, _ []js.Value) any {
		var stats runtime.MemStats
		runtime.ReadMemStats(&stats)
		return map[string]any{
			"heapAlloc":   stats.HeapAlloc,
			"sys":         stats.Sys,
			"numGoroutine": runtime.NumGoroutine(),
		}
	})

	js.Global().Set("derpServerKey", privateKey.Public().String())
	js.Global().Set("derpServerReady", server != nil)
	wake := make(chan struct{})
	js.Global().Get("derpWasmNotify").Invoke()
	<-wake
}
