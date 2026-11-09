//go:build js && wasm

package main

import (
	"fmt"
	"io"
	"net"
	"os"
	"sync"
	"syscall/js"
	"time"
)

const incomingQueueDepth = 16

type workerConn struct {
	id                  string
	incoming            chan []byte
	closed              chan struct{}
	once                sync.Once
	readMu              sync.Mutex
	writeMu             sync.Mutex
	current             []byte
	deadlineMu          sync.Mutex
	readDeadline        time.Time
	writeDeadline       time.Time
	readDeadlineChanged chan struct{}
}

func newWorkerConn(id string) *workerConn {
	return &workerConn{
		id:                  id,
		incoming:            make(chan []byte, incomingQueueDepth),
		closed:              make(chan struct{}),
		readDeadlineChanged: make(chan struct{}, 1),
	}
}

func (c *workerConn) enqueue(payload []byte) bool {
	select {
	case <-c.closed:
		return false
	default:
	}
	select {
	case c.incoming <- payload:
		return true
	default:
		return false
	}
}

func (c *workerConn) Read(p []byte) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}
	c.readMu.Lock()
	defer c.readMu.Unlock()
	for {
		if len(c.current) != 0 {
			n := copy(p, c.current)
			c.current = c.current[n:]
			return n, nil
		}
		select {
		case c.current = <-c.incoming:
			continue
		default:
		}

		c.deadlineMu.Lock()
		deadline := c.readDeadline
		c.deadlineMu.Unlock()
		if deadline.IsZero() {
			select {
			case c.current = <-c.incoming:
			case <-c.closed:
				select {
				case c.current = <-c.incoming:
				default:
					return 0, io.EOF
				}
			case <-c.readDeadlineChanged:
			}
			continue
		}

		timer := time.NewTimer(time.Until(deadline))
		select {
		case c.current = <-c.incoming:
			timer.Stop()
		case <-c.closed:
			timer.Stop()
			select {
			case c.current = <-c.incoming:
			default:
				return 0, io.EOF
			}
		case <-c.readDeadlineChanged:
			timer.Stop()
		case <-timer.C:
			return 0, os.ErrDeadlineExceeded
		}
	}
}

func (c *workerConn) Write(p []byte) (n int, err error) {
	if len(p) == 0 {
		return 0, nil
	}
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	select {
	case <-c.closed:
		return 0, net.ErrClosed
	default:
	}
	c.deadlineMu.Lock()
	deadline := c.writeDeadline
	c.deadlineMu.Unlock()
	if !deadline.IsZero() && time.Until(deadline) <= 0 {
		return 0, os.ErrDeadlineExceeded
	}
	defer func() {
		if recovered := recover(); recovered != nil {
			n = 0
			err = fmt.Errorf("DERP WebSocket write failed: %v", recovered)
		}
	}()
	data := js.Global().Get("Uint8Array").New(len(p))
	if n := js.CopyBytesToJS(data, p); n != len(p) {
		return 0, io.ErrShortWrite
	}
	if result := js.Global().Get("derpSocketSend").Invoke(c.id, data); result.Type() == js.TypeBoolean && !result.Bool() {
		return 0, net.ErrClosed
	}
	return len(p), nil
}

func (c *workerConn) close(notifyJS bool) {
	c.once.Do(func() {
		close(c.closed)
		if notifyJS {
			js.Global().Get("derpSocketTerminate").Invoke(c.id)
		}
	})
}

func (c *workerConn) Close() error {
	c.close(true)
	return nil
}

func (c *workerConn) LocalAddr() net.Addr  { return workerAddr("worker") }
func (c *workerConn) RemoteAddr() net.Addr { return workerAddr("websocket/" + c.id) }
func (c *workerConn) SetDeadline(t time.Time) error {
	if err := c.SetReadDeadline(t); err != nil {
		return err
	}
	return c.SetWriteDeadline(t)
}
func (c *workerConn) SetWriteDeadline(t time.Time) error {
	c.deadlineMu.Lock()
	c.writeDeadline = t
	c.deadlineMu.Unlock()
	return nil
}
func (c *workerConn) SetReadDeadline(t time.Time) error {
	c.deadlineMu.Lock()
	c.readDeadline = t
	c.deadlineMu.Unlock()
	select {
	case c.readDeadlineChanged <- struct{}{}:
	default:
	}
	return nil
}

type workerAddr string

func (a workerAddr) Network() string { return "websocket" }
func (a workerAddr) String() string  { return string(a) }

var _ net.Conn = (*workerConn)(nil)
