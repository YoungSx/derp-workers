package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/coder/websocket"
	"tailscale.com/derp"
	"tailscale.com/disco"
	"tailscale.com/net/wsconn"
	"tailscale.com/types/key"
)

type client struct {
	derp      *derp.Client
	conn      *websocket.Conn
	transport *fragmentConn
	msgs      chan derp.ReceivedMessage
	err       chan error
}

type fragmentConn struct {
	net.Conn
	fragment int
}

func (c *fragmentConn) Write(p []byte) (int, error) {
	if c.fragment <= 0 {
		return c.Conn.Write(p)
	}
	for written := 0; written < len(p); {
		end := min(written+c.fragment, len(p))
		chunk := p[written:end]
		n, err := c.Conn.Write(chunk)
		written += n
		if err != nil {
			return written, err
		}
		if n != len(chunk) {
			return written, io.ErrShortWrite
		}
	}
	return len(p), nil
}

func connect(ctx context.Context, url string, privateKey key.NodePrivate, fragment int) (*client, error) {
	conn, _, err := websocket.Dial(ctx, url, &websocket.DialOptions{Subprotocols: []string{"derp"}})
	if err != nil {
		return nil, err
	}
	if conn.Subprotocol() != "derp" {
		conn.Close(websocket.StatusProtocolError, "DERP subprotocol was not selected")
		return nil, fmt.Errorf("server selected subprotocol %q", conn.Subprotocol())
	}
	conn.SetReadLimit(-1)
	netConn := wsconn.NetConn(context.Background(), conn, websocket.MessageBinary, "local-worker")
	transport := &fragmentConn{Conn: netConn, fragment: fragment}
	brw := bufio.NewReadWriter(bufio.NewReader(transport), bufio.NewWriter(transport))
	derpClient, err := derp.NewClient(privateKey, transport, brw, log.Printf)
	if err != nil {
		transport.Close()
		return nil, err
	}
	c := &client{derp: derpClient, conn: conn, transport: transport, msgs: make(chan derp.ReceivedMessage, 8), err: make(chan error, 1)}
	go func() {
		for {
			msg, err := derpClient.Recv()
			if err != nil {
				c.err <- err
				return
			}
			c.msgs <- msg
		}
	}()
	return c, nil
}

func (c *client) recv(timeout time.Duration, accept func(derp.ReceivedMessage) bool) (derp.ReceivedMessage, error) {
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	for {
		select {
		case msg := <-c.msgs:
			if accept(msg) {
				return msg, nil
			}
		case err := <-c.err:
			return nil, err
		case <-timer.C:
			return nil, fmt.Errorf("timed out waiting for DERP message")
		}
	}
}

func (c *client) close() { _ = c.conn.Close(websocket.StatusNormalClosure, "test complete") }

func main() {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	wantServerKey := strings.TrimPrefix(os.Getenv("DERP_SERVER_KEY"), "nodekey:")
	if wantServerKey == "" {
		log.Fatal("DERP_SERVER_KEY is required")
	}
	url := envOr("DERP_WS_URL", "ws://127.0.0.1:8797/derp")
	probeURL := envOr("DERP_HTTP_URL", "http://127.0.0.1:8797/derp/probe")
	aKey, bKey := key.NewNode(), key.NewNode()
	b, err := connect(ctx, url, bKey, 0)
	must(err)
	defer b.close()
	a, err := connect(ctx, url, aKey, 3)
	must(err)
	defer a.close()
	if a.derp.ServerPublicKey().UntypedHexString() != wantServerKey || b.derp.ServerPublicKey().UntypedHexString() != wantServerKey {
		log.Fatalf("clients received unexpected DERP ServerKey: %s / %s", a.derp.ServerPublicKey(), b.derp.ServerPublicKey())
	}

	var ping [8]byte
	copy(ping[:], []byte("pingtest"))
	must(a.derp.SendPing(ping))
	_, err = a.recv(5*time.Second, func(msg derp.ReceivedMessage) bool {
		pong, ok := msg.(derp.PongMessage)
		return ok && pong == derp.PongMessage(ping)
	})
	must(err)
	a.transport.fragment = 0

	payload := append(bytes.Repeat([]byte("Tailscale-DERP-"), derp.MaxPacketSize/15), 'x')
	packetStarted := time.Now()
	for i := 0; i < 8; i++ {
		must(a.derp.Send(b.derp.PublicKey(), payload))
		_, err = b.recv(5*time.Second, func(msg derp.ReceivedMessage) bool {
			packet, ok := msg.(derp.ReceivedPacket)
			return ok && packet.Source == a.derp.PublicKey() && bytes.Equal(packet.Data, payload)
		})
		must(err)
	}
	forwardingElapsed := time.Since(packetStarted)
	duplicate, err := connect(ctx, url, bKey, 0)
	must(err)
	waitConnections(ctx, probeURL, 3)
	must(a.derp.Send(b.derp.PublicKey(), payload))
	_, err = duplicate.recv(5*time.Second, func(msg derp.ReceivedMessage) bool {
		packet, ok := msg.(derp.ReceivedPacket)
		return ok && packet.Source == a.derp.PublicKey() && bytes.Equal(packet.Data, payload)
	})
	must(err)

	b.close()
	waitConnections(ctx, probeURL, 2)
	must(a.derp.Send(duplicate.derp.PublicKey(), payload))
	_, err = duplicate.recv(5*time.Second, func(msg derp.ReceivedMessage) bool {
		packet, ok := msg.(derp.ReceivedPacket)
		return ok && packet.Source == a.derp.PublicKey() && bytes.Equal(packet.Data, payload)
	})
	must(err)
	duplicate.close()
	waitConnections(ctx, probeURL, 1)
	discoProbe := make([]byte, len(disco.Magic)+32+24)
	copy(discoProbe, disco.Magic)
	must(a.derp.Send(b.derp.PublicKey(), discoProbe))
	_, err = a.recv(5*time.Second, func(msg derp.ReceivedMessage) bool {
		gone, ok := msg.(derp.PeerGoneMessage)
		return ok && gone.Peer == b.derp.PublicKey() && gone.Reason == derp.PeerGoneReasonNotHere
	})
	must(err)
	b, err = connect(ctx, url, bKey, 0)
	must(err)
	defer b.close()
	waitConnections(ctx, probeURL, 2)
	must(a.derp.Send(b.derp.PublicKey(), payload))
	_, err = b.recv(5*time.Second, func(msg derp.ReceivedMessage) bool {
		packet, ok := msg.(derp.ReceivedPacket)
		return ok && packet.Source == a.derp.PublicKey() && string(packet.Data) == string(payload)
	})
	must(err)

	fmt.Printf("PASS: official DERP Client handshake, expected ServerKey, ping/pong, packet forwarding, duplicate-key connection, PeerGone, reconnect\n")
	fmt.Printf("PASS: 3-byte fragmented client WebSocket messages; %d packets x %d bytes in %s (%.2f MiB/s)\n", 8, len(payload), forwardingElapsed, float64(8*len(payload))/(1024*1024)/forwardingElapsed.Seconds())
}

func envOr(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

func waitConnections(ctx context.Context, url string, want int) {
	ticker := time.NewTicker(25 * time.Millisecond)
	defer ticker.Stop()
	for {
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		must(err)
		response, err := http.DefaultClient.Do(request)
		if err == nil {
			var status struct {
				Connections int `json:"connections"`
			}
			body, readErr := io.ReadAll(response.Body)
			response.Body.Close()
			if readErr == nil && json.Unmarshal(body, &status) == nil && status.Connections == want {
				return
			}
		}
		select {
		case <-ctx.Done():
			log.Fatalf("timed out waiting for %d DERP connections", want)
		case <-ticker.C:
		}
	}
}

func must(err error) {
	if err != nil {
		log.Fatal(err)
	}
}
