//go:build js && wasm

package main

import (
	"context"
	"fmt"
	"syscall/js"
	"time"

	"tailscale.com/derp"
	"tailscale.com/derp/derphttp"
	"tailscale.com/disco"
	"tailscale.com/net/netmon"
	"tailscale.com/types/key"
)

var (
	wantServerKey string
	status        = js.Global().Get("derpBrowserStatus")
	logLine       = js.Global().Get("derpBrowserLog")
)

func logf(format string, args ...any) {
	msg := fmt.Sprintf(format, args...)
	println(msg)
	logLine.Invoke(msg)
}

func connect(ctx context.Context, url string, k key.NodePrivate) (*derphttp.Client, error) {
	client, err := derphttp.NewClient(k, url, logf, netmon.NewStatic())
	if err != nil {
		return nil, err
	}
	// A freshly deployed workers.dev route can briefly 404 per-colo while
	// it propagates; retry the dial a few times before giving up.
	var lastErr error
	for attempt := 0; attempt < 5; attempt++ {
		if attempt > 0 {
			select {
			case <-ctx.Done():
				client.Close()
				return nil, ctx.Err()
			case <-time.After(time.Duration(attempt) * 500 * time.Millisecond):
			}
		}
		if err := client.Connect(ctx); err == nil {
			return client, nil
		} else {
			lastErr = err
			client.Close()
			client, err = derphttp.NewClient(k, url, logf, netmon.NewStatic())
			if err != nil {
				return nil, err
			}
		}
	}
	client.Close()
	return nil, lastErr
}

type receiver struct {
	msgs chan derp.ReceivedMessage
	errs chan error
}

// startReceiver runs the single Recv loop a derphttp.Client permits,
// mirroring tstest/integration's official client tests: one goroutine
// per client, never concurrent Recv calls.
func startReceiver(client *derphttp.Client) *receiver {
	r := &receiver{msgs: make(chan derp.ReceivedMessage, 64), errs: make(chan error, 1)}
	go func() {
		for {
			msg, err := client.Recv()
			if err != nil {
				r.errs <- err
				return
			}
			r.msgs <- msg
		}
	}()
	return r
}

func (r *receiver) recv(timeout time.Duration, accept func(derp.ReceivedMessage) bool) (derp.ReceivedMessage, error) {
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	for {
		select {
		case msg := <-r.msgs:
			if accept(msg) {
				return msg, nil
			}
		case err := <-r.errs:
			return nil, err
		case <-timer.C:
			return nil, fmt.Errorf("timed out waiting for DERP message")
		}
	}
}

func isPacket(from key.NodePublic) func(derp.ReceivedMessage) bool {
	return func(m derp.ReceivedMessage) bool {
		packet, ok := m.(derp.ReceivedPacket)
		return ok && packet.Source == from
	}
}

func run(url string, opts string) {
	defer func() {
		if r := recover(); r != nil {
			status.Invoke("error", fmt.Sprintf("panic: %v", r))
		}
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	aKey, bKey := key.NewNode(), key.NewNode()
	aPub := aKey.Public()
	a, err := connect(ctx, url, aKey)
	var ra, rb *receiver
	if err != nil {
		status.Invoke("error", fmt.Sprintf("client A connect: %v", err))
		return
	}
	defer a.Close()
	if got := a.ServerPublicKey().UntypedHexString(); wantServerKey != "" && got != wantServerKey {
		status.Invoke("error", fmt.Sprintf("server key mismatch: got %s want %s", got, wantServerKey))
		return
	}
	logf("client A connected, server key %s", a.ServerPublicKey())

	bPub := bKey.Public()
	b, err := connect(ctx, url, bKey)
	if err != nil {
		status.Invoke("error", fmt.Sprintf("client B connect: %v", err))
		return
	}
	defer b.Close()
	logf("client B connected")
	ra = startReceiver(a)
	rb = startReceiver(b)

	ping := [8]byte{0x70, 0x69, 0x6e, 0x67, 0x74, 0x65, 0x73, 0x74}
	if err := a.SendPing(ping); err != nil {
		status.Invoke("error", fmt.Sprintf("A SendPing: %v", err))
		return
	}
	if _, err := ra.recv(5*time.Second, func(m derp.ReceivedMessage) bool {
		pong, ok := m.(derp.PongMessage)
		return ok && pong == derp.PongMessage(ping)
	}); err != nil {
		status.Invoke("error", fmt.Sprintf("A pong: %v", err))
		return
	}
	logf("A ping/pong ok")

	// coder/websocket's js build defaults to a 32768-byte read limit that
	// derphttp never lifts, so browser clients cannot receive frames above
	// that size. Real WireGuard packets (~1.5 KB) stay well below it.
	const payloadSize = 16 * 1024
	payload := append(make([]byte, 0, payloadSize), bytesRepeat("Tailscale-DERP-", payloadSize)...)
	started := time.Now()
	packets := 2 + 100*boolToInt(opts == "throughput")
	for i := 0; i < packets; i++ {
		if err := a.Send(bPub, payload); err != nil {
			status.Invoke("error", fmt.Sprintf("A Send #%d: %v", i, err))
			return
		}
		logf("A sent packet #%d (%d bytes)", i, len(payload))
		got, err := rb.recv(5*time.Second, isPacket(aPub))
		if err != nil {
			status.Invoke("error", fmt.Sprintf("B recv #%d: %v", i, err))
			return
		}
		if packet, ok := got.(derp.ReceivedPacket); !ok || len(packet.Data) != len(payload) {
			status.Invoke("error", fmt.Sprintf("B got unexpected message #%d: %T", i, got))
			return
		}
	}
	elapsed := time.Since(started)
	logf("forwarded %d packets x %d bytes in %s", packets, len(payload), elapsed)

	if err := b.Send(aPub, payload); err != nil {
		status.Invoke("error", fmt.Sprintf("B Send: %v", err))
		return
	}
	if _, err := ra.recv(5*time.Second, isPacket(bPub)); err != nil {
		status.Invoke("error", fmt.Sprintf("A recv reverse: %v", err))
		return
	}
	logf("bidirectional forwarding ok")

	b.Close()
	logf("B closed")
	discoProbe := make([]byte, len(disco.Magic)+32+24)
	copy(discoProbe, disco.Magic)
	if err := a.Send(bPub, discoProbe); err != nil {
		status.Invoke("error", fmt.Sprintf("A disco send: %v", err))
		return
	}
	if _, err := ra.recv(5*time.Second, func(m derp.ReceivedMessage) bool {
		gone, ok := m.(derp.PeerGoneMessage)
		return ok && gone.Peer == bPub && gone.Reason == derp.PeerGoneReasonNotHere
	}); err != nil {
		status.Invoke("error", fmt.Sprintf("A PeerGone: %v", err))
		return
	}
	logf("PeerGone after disco to closed peer ok")

	b, err = connect(ctx, url, bKey)
	if err != nil {
		status.Invoke("error", fmt.Sprintf("B reconnect: %v", err))
		return
	}
	defer b.Close()
	rb = startReceiver(b)
	if err := b.SendPing(ping); err != nil {
		status.Invoke("error", fmt.Sprintf("B SendPing after reconnect: %v", err))
		return
	}
	if _, err := rb.recv(5*time.Second, func(m derp.ReceivedMessage) bool {
		pong, ok := m.(derp.PongMessage)
		return ok && pong == derp.PongMessage(ping)
	}); err != nil {
		status.Invoke("error", fmt.Sprintf("B pong after reconnect: %v", err))
		return
	}
	logf("B ping/pong after reconnect ok")
	if err := a.Send(bPub, payload); err != nil {
		status.Invoke("error", fmt.Sprintf("A Send after reconnect: %v", err))
		return
	}
	if _, err := rb.recv(5*time.Second, isPacket(aPub)); err != nil {
		status.Invoke("error", fmt.Sprintf("B recv after reconnect: %v", err))
		return
	}
	logf("reconnect and resume delivery ok")

	status.Invoke("ok", fmt.Sprintf("packets=%d bytes=%d elapsed=%s", packets, len(payload), elapsed))
}

func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

func bytesRepeat(pattern string, total int) []byte {
	out := make([]byte, total)
	for i := 0; i < total; i += len(pattern) {
		copy(out[i:], pattern)
	}
	return out
}

func main() {
	fmt.Println("derp-browser booted")
	js.Global().Set("derpBrowserRun", js.FuncOf(func(_ js.Value, args []js.Value) any {
		go run(args[0].String(), args[1].String())
		return nil
	}))
	js.Global().Set("derpBrowserWantKey", js.FuncOf(func(_ js.Value, args []js.Value) any {
		wantServerKey = args[0].String()
		return nil
	}))
	select {}
}
